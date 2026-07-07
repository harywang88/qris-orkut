#!/usr/bin/env python3
"""Finalisasi PIN transfer Madera->Bank (Nobu) via headless browser (uc+selenium/Xvfb).
Input : JSON via stdin { "redirect_url": "...", "pin": "787877", "dry_run": false }
Output: JSON via stdout { "success": bool, "outcome": "success|failed|unknown", "message": str, ... }
dry_run=true -> hanya ketik (len-1) digit, TIDAK submit (validasi tanpa memindahkan uang).
"""
import sys, json, time, traceback
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

CHROME_BIN = '/usr/bin/google-chrome-stable'
SUCCESS_KW = ['transaksi kamu berhasil', 'transaksi berhasil', 'pembayaran berhasil', 'berhasil']
FAIL_KW = ['transaksi gagal', 'pin salah', 'pin yang kamu masukkan salah', 'tidak sesuai',
           'diblokir', 'terblokir', 'melebihi', 'kesalahan saat memproses', 'gagal']

def digit_xpath(d):
    return ("//button[contains(@class,'numpadButton') and not(contains(@class,'Back')) "
            "and normalize-space(.)='%s']" % d)

def extract_result_message(body):
    """Ambil judul hasil ('Transaksi Gagal/Berhasil') + baris alasan setelahnya."""
    lines = [l.strip() for l in body.split('\n') if l.strip()]
    for i, l in enumerate(lines):
        ll = l.lower()
        if ('transaksi berhasil' in ll or 'transaksi gagal' in ll
                or 'transaksi kamu berhasil' in ll or 'pembayaran berhasil' in ll):
            reason = lines[i + 1] if i + 1 < len(lines) else ''
            # jangan ambil baris tombol
            if reason.lower().startswith('kembali'):
                reason = ''
            return (l + ((' — ' + reason) if reason else '')).strip()
    return ''

def run(redirect_url, pin, dry_run):
    opts = uc.ChromeOptions()
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=1400,2000')
    opts.binary_location = CHROME_BIN
    driver = uc.Chrome(options=opts, headless=False, use_subprocess=True, version_main=150)
    result = {'success': False, 'outcome': 'unknown', 'message': None, 'dry_run': dry_run}
    try:
        driver.get(redirect_url)
        WebDriverWait(driver, 40).until(
            EC.presence_of_element_located((By.XPATH, digit_xpath('1'))))
        time.sleep(1.0)

        seq = pin[:-1] if dry_run else pin
        for d in seq:
            btn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.XPATH, digit_xpath(d))))
            btn.click()
            time.sleep(0.4)

        if dry_run:
            driver.save_screenshot('/tmp/nobu_finalize_dry.png')
            result['success'] = True; result['outcome'] = 'dry_run'
            result['message'] = 'DRY RUN: %d digit ditekan (tidak submit).' % len(seq)
            return result

        # Setelah 6 digit -> SPA auto-submit verify-pin -> tunggu modal hasil.
        deadline = time.time() + 32
        final_body = ''
        while time.time() < deadline:
            body = (driver.find_element(By.TAG_NAME, 'body').text or '')
            final_body = body
            low = body.lower()
            if any(k in low for k in SUCCESS_KW):
                result['success'] = True; result['outcome'] = 'success'
                result['message'] = extract_result_message(body) or 'Transaksi berhasil.'
                break
            if any(k in low for k in FAIL_KW):
                result['success'] = False; result['outcome'] = 'failed'
                result['message'] = extract_result_message(body) or 'Transaksi gagal diproses Nobu.'
                break
            time.sleep(1.0)
        else:
            result['outcome'] = 'unknown'
            result['message'] = 'Status belum terbaca (timeout). Cek mutasi untuk memastikan.'
        driver.save_screenshot('/tmp/nobu_finalize.png')
        return result
    finally:
        try: driver.quit()
        except Exception: pass

def main():
    data = json.loads(sys.stdin.read())
    out = run(data['redirect_url'], str(data['pin']), bool(data.get('dry_run', False)))
    print('FINALIZE_JSON_BEGIN')
    print(json.dumps(out, ensure_ascii=False))
    print('FINALIZE_JSON_END')

try:
    main()
except Exception as e:
    print('FINALIZE_JSON_BEGIN')
    print(json.dumps({'success': False, 'outcome': 'unknown', 'message': 'exception: ' + repr(e)}))
    print('FINALIZE_JSON_END')
    traceback.print_exc()
