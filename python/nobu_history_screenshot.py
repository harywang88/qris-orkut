#!/usr/bin/env python3
"""Screenshot BUKTI RESMI transaksi Madera (Nobu) via webview history-transaction.
Alur: buka URL -> INPUT PIN (numpad) -> tunggu daftar -> klik transaksi (by nominal) ->
  halaman DETAIL (tahan 'Data Gagal Dimuat' -> Muat Ulang) -> klik 'Lihat Detail' (expand) -> screenshot.
Input  (stdin JSON): { "url","out_path","pin","amount"(int, opsional),"wait"(opsional) }
Output (stdout)    : SHOT_JSON_BEGIN { ...json... } SHOT_JSON_END
Butuh undetected-chromedriver + Xvfb (DISPLAY=:99); halaman Nobu = Next.js SPA + Imperva.
SUKSES hanya jika benar-benar sampai halaman DETAIL (bukan daftar / error).
"""
import sys, json, time, os, traceback
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

CHROME_BIN = '/usr/bin/google-chrome-stable'
DETAIL_MARKERS = ['rekening penerima', 'nama penerima', 'nama pengirim', 'sumber dana', 'lihat detail', 'sembunyikan detail']
ERROR_MARKERS = ['data gagal dimuat', 'gagal dimuat', 'muat ulang', 'periksa jaringan']
EXPANDED_MARKERS = ['sembunyikan detail', 'nama pengirim', 'sumber dana', 'tipe transfer']


def body_text(driver):
    try:
        return (driver.find_element(By.TAG_NAME, 'body').text or '').lower()
    except Exception:
        return ''


def page_state(driver):
    b = body_text(driver)
    if any(m in b for m in ERROR_MARKERS):
        return 'error'
    if any(m in b for m in DETAIL_MARKERS):
        return 'detail'
    return 'list'


def is_expanded(driver):
    b = body_text(driver)
    return any(m in b for m in EXPANDED_MARKERS)


def digit_btn(driver, d):
    xpaths = [
        "//button[contains(@class,'numpadButton') and not(contains(@class,'Back')) and normalize-space(.)='%s']" % d,
        "//button[normalize-space(.)='%s']" % d,
        "//*[self::button or @role='button'][normalize-space(.)='%s']" % d,
    ]
    for xp in xpaths:
        for el in driver.find_elements(By.XPATH, xp):
            try:
                if el.is_displayed():
                    return el
            except Exception:
                pass
    return None


def enter_pin(driver, pin):
    WebDriverWait(driver, 40).until(lambda d: digit_btn(d, '1') is not None)
    time.sleep(1.0)
    for d in str(pin):
        btn = None
        for _ in range(20):
            btn = digit_btn(driver, d)
            if btn:
                break
            time.sleep(0.3)
        if not btn:
            raise Exception('numpad digit %s tidak ketemu' % d)
        btn.click()
        time.sleep(0.45)


def amount_variants(amount):
    try:
        n = int(amount)
    except Exception:
        return []
    return [format(n, ',d').replace(',', '.'), str(n)]


def robust_click(driver, el):
    """Webview mobile Nobu sering pakai handler pointer/touch, bukan click mouse biasa.
    Kirim rangkaian pointerdown/up + mousedown/up + click + el.click()."""
    driver.execute_script(
        """
        var el = arguments[0];
        try { el.scrollIntoView({block:'center'}); } catch(e){}
        var r = el.getBoundingClientRect();
        var o = {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2, view:window};
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
          try {
            var ev = (t.indexOf('pointer')===0)
              ? new PointerEvent(t, Object.assign({}, o, {pointerType:'touch', isPrimary:true, pointerId:1}))
              : new MouseEvent(t, o);
            el.dispatchEvent(ev);
          } catch(e){}
        });
        try { el.click(); } catch(e){}
        """, el)


def wait_state(driver, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        st = page_state(driver)
        if st in ('detail', 'error'):
            return st
        time.sleep(1.0)
    return page_state(driver)


def click_muat_ulang(driver):
    for el in driver.find_elements(By.XPATH, "//*[contains(normalize-space(.),'Muat Ulang')]"):
        try:
            if el.is_displayed():
                driver.execute_script('arguments[0].click();', el)
                return True
        except Exception:
            pass
    return False


def reload_retry(driver, tries=3):
    for _ in range(tries):
        if page_state(driver) != 'error':
            return page_state(driver)
        if not click_muat_ulang(driver):
            try:
                driver.refresh()
            except Exception:
                pass
        time.sleep(6)
    return page_state(driver)


def parent_of(node):
    try:
        p = node.find_element(By.XPATH, './parent::*')
        if p.tag_name.lower() in ('html', 'body'):
            return None
        return p
    except Exception:
        return None


def deepest_elements(driver, text):
    # hanya elemen DAUN yg berisi teks (tak ada keturunan yg juga berisi teks)
    return driver.find_elements(
        By.XPATH,
        "//*[contains(normalize-space(.), '%s')][not(.//*[contains(normalize-space(.), '%s')])]" % (text, text))


def _dedup_displayed(cands):
    out, seen = [], set()
    for el in cands:
        try:
            if el.id in seen:
                continue
            seen.add(el.id)
            if el.is_displayed():
                out.append(el)
        except Exception:
            pass
    return out


def tx_row_candidates(driver, amount):
    """Kandidat BARIS transaksi <li class='MuiListItem...'> (struktur asli Nobu dari koko).
    Prioritas: (1) BI FAST OUT + nominal, (2) nominal saja, (3) fallback elemen daun."""
    cands = []
    for v in amount_variants(amount):
        cands += driver.find_elements(
            By.XPATH,
            "//li[contains(@class,'MuiListItem')][.//*[contains(normalize-space(.),'BI FAST OUT')]][.//*[contains(normalize-space(.),'%s')]]" % v)
    for v in amount_variants(amount):
        cands += driver.find_elements(
            By.XPATH, "//li[contains(@class,'MuiListItem')][.//*[contains(normalize-space(.),'%s')]]" % v)
    for v in amount_variants(amount):
        cands += deepest_elements(driver, v)
    return _dedup_displayed(cands)


def find_and_click_tx(driver, amount, deadline_s=45):
    """Klik <li> baris transaksi hingga pindah ke halaman detail/error."""
    deadline = time.time() + deadline_s
    for el in tx_row_candidates(driver, amount)[:6]:  # doc-order: teratas = terbaru
        if time.time() > deadline:
            return None
        node = el
        for _ in range(4):
            if time.time() > deadline:
                return None
            try:
                robust_click(driver, node)
                st = wait_state(driver, 5)
                if st in ('detail', 'error'):
                    return st
            except Exception:
                pass
            node = parent_of(node)
            if node is None:
                break
    return None


def click_lihat_detail(driver):
    if is_expanded(driver):
        return True
    # Kandidat: (1) class 'css-tbw7fv' (tombol Lihat Detail asli dari koko), (2) teks 'Lihat Detail'
    cands = list(driver.find_elements(By.XPATH, "//*[contains(@class,'css-tbw7fv')]"))
    for label in ['Lihat Detail', 'Lihat Detil']:
        cands += deepest_elements(driver, label)
    for leaf in _dedup_displayed(cands):
        node = leaf
        for _ in range(4):
            try:
                robust_click(driver, node)
                time.sleep(1.2)
                if is_expanded(driver):
                    return True
            except Exception:
                pass
            node = parent_of(node)
            if node is None:
                break
    return is_expanded(driver)


def run(url, out_path, pin, amount, wait):
    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
    except Exception:
        pass
    opts = uc.ChromeOptions()
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=900,1600')
    opts.binary_location = CHROME_BIN
    driver = uc.Chrome(options=opts, headless=False, use_subprocess=True, version_main=150)
    result = {'success': False, 'out_path': out_path, 'step': 'start', 'message': None}
    try:
        driver.get(url)
        time.sleep(wait)
        if pin:
            try:
                enter_pin(driver, pin)
                result['step'] = 'pin_entered'
            except Exception as e:
                result['step'] = 'pin_failed'
                result['message'] = 'PIN: ' + str(e)
        time.sleep(6)
        if amount and result['step'] == 'pin_entered':
            st = find_and_click_tx(driver, amount)
            if st == 'error':
                st = reload_retry(driver, 3)
            if st == 'detail':
                result['step'] = 'tx_opened'
                result['tx_clicked'] = True
                time.sleep(1.5)
                # detail bisa saja masih loading -> tunggu marker asli
                for _ in range(5):
                    if page_state(driver) == 'detail' and not any(m in body_text(driver) for m in ERROR_MARKERS):
                        break
                    time.sleep(1.0)
                if click_lihat_detail(driver):
                    result['step'] = 'detail_opened'
                    result['detail_clicked'] = True
                time.sleep(1.2)
            elif st == 'error':
                result['message'] = 'Nobu: "Data Gagal Dimuat" — detail tidak bisa dimuat (coba lagi beberapa saat).'
            else:
                result['message'] = 'Transaksi nominal tsb tidak ditemukan / tidak bisa dibuka.'
        # full-page height
        try:
            h = driver.execute_script('return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);')
            if h and int(h) > 800:
                driver.set_window_size(900, min(int(h) + 140, 4200))
                time.sleep(0.6)
        except Exception:
            pass
        final_state = page_state(driver)
        ok_shot = driver.save_screenshot(out_path)
        size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
        # SUKSES hanya jika sampai DETAIL asli (bukan list/error) & lolos PIN
        result['success'] = bool(ok_shot and size > 1500 and final_state == 'detail'
                                 and result['step'] in ('tx_opened', 'detail_opened'))
        result['size'] = size
        result['final_state'] = final_state
        if not result['success'] and not result['message']:
            result['message'] = 'Belum sampai halaman detail (state=%s, step=%s).' % (final_state, result['step'])
        # jangan tinggalkan file bila gagal (biar tidak dianggap "bukti siap")
        if not result['success']:
            try:
                if os.path.exists(out_path):
                    os.remove(out_path)
            except Exception:
                pass
    finally:
        try:
            driver.quit()
        except Exception:
            pass
    return result


def main():
    data = json.loads(sys.stdin.read())
    result = run(data['url'], data['out_path'], data.get('pin'), data.get('amount'), int(data.get('wait', 12)))
    print('SHOT_JSON_BEGIN')
    print(json.dumps(result, ensure_ascii=False))
    print('SHOT_JSON_END')


try:
    main()
except Exception as e:
    print('SHOT_JSON_BEGIN')
    print(json.dumps({'success': False, 'message': repr(e)}))
    print('SHOT_JSON_END')
    traceback.print_exc()
