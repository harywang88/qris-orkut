import sys, json, time, traceback
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By

def main():
    url = open('/tmp/nobu_redirect.txt').read().strip()
    opts = uc.ChromeOptions()
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=1400,2000')
    opts.binary_location = '/usr/bin/google-chrome-stable'
    driver = uc.Chrome(options=opts, headless=False, use_subprocess=True, version_main=149)
    try:
        driver.get(url)
        time.sleep(9)
        info = {'title': driver.title, 'url': driver.current_url}
        inputs = []
        for el in driver.find_elements(By.TAG_NAME, 'input'):
            try:
                inputs.append({
                    'type': el.get_attribute('type'), 'name': el.get_attribute('name'),
                    'id': el.get_attribute('id'), 'placeholder': el.get_attribute('placeholder'),
                    'maxlength': el.get_attribute('maxlength'), 'inputmode': el.get_attribute('inputmode'),
                    'aria': el.get_attribute('aria-label'), 'class': (el.get_attribute('class') or '')[:60],
                    'displayed': el.is_displayed(),
                })
            except Exception:
                pass
        info['inputs'] = inputs
        buttons = []
        for el in driver.find_elements(By.TAG_NAME, 'button'):
            try:
                buttons.append({'text': (el.text or '')[:40], 'type': el.get_attribute('type'),
                                'class': (el.get_attribute('class') or '')[:50], 'displayed': el.is_displayed()})
            except Exception:
                pass
        info['buttons'] = buttons
        try:
            info['body_text'] = driver.find_element(By.TAG_NAME, 'body').text[:1200]
        except Exception:
            info['body_text'] = ''
        driver.save_screenshot('/tmp/nobu_recon.png')
        print('RECON_JSON_BEGIN')
        print(json.dumps(info, ensure_ascii=False, indent=2))
        print('RECON_JSON_END')
    finally:
        try: driver.quit()
        except Exception: pass

try:
    main()
except Exception as e:
    print('RECON_ERROR', repr(e))
    traceback.print_exc()
