#!/usr/bin/env python3
"""
game_panel.py — Cek ONLINE/OFFLINE panel web-game (IDN Toto / PAY4D) untuk qris-orkut.

MENGGUNAKAN ULANG kode login STABIL dari Ayu Chen Bot (scrapers.idn / scrapers.pay4d)
supaya perilakunya PERSIS sama (Session + cookie persist + is_session_valid).

Kontrak I/O (dipanggil Node via spawn, seperti python Nobu):
  INPUT  (stdin, JSON): {
    "platform": "idn" | "pay4d",
    "creds":   { link, username, password, pin,            # IDN
                 cookie_name, cookie_value, cookie_domain }, # PAY4D
    "cookies": { ... }   # cookie tersimpan sebelumnya (opsional) untuk reuse sesi
  }
  OUTPUT (stdout): GAMECHK_JSON_BEGIN {json} GAMECHK_JSON_END
    json = { ok, online, platform, message, cookies }
      - online  : sesi terautentikasi (bisa dipakai) atau tidak
      - message : alasan (mis. maintenance / cookie kedaluwarsa)
      - cookies : cookie terbaru untuk disimpan Node (agar tak login berulang)

Python: /opt/ayuchenbot/venv/bin/python3 (punya requests + bs4 + lxml).
"""
import sys
import json

AYU_ROOT = "/opt/ayuchenbot"
if AYU_ROOT not in sys.path:
    sys.path.insert(0, AYU_ROOT)


def emit(obj):
    sys.stdout.write("GAMECHK_JSON_BEGIN\n")
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\nGAMECHK_JSON_END\n")
    sys.stdout.flush()


def build_scraper(platform, creds):
    p = (platform or "").strip().lower()
    if p in ("idn", "default", "idntoto", "idn_toto", "idn toto"):
        from scrapers.idn import IdnScraper
        return "idn", IdnScraper({
            "link": creds.get("link") or "",
            "username": creds.get("username") or "",
            "password": creds.get("password") or "",
            "pin": creds.get("pin") or "",
        })
    if p in ("pay4d", "sulebet"):
        from scrapers.pay4d import Pay4dScraper
        return "pay4d", Pay4dScraper({
            "link": creds.get("link") or "",
            "cookie_name": creds.get("cookie_name") or "PHPSESSID",
            "cookie_value": creds.get("cookie_value") or "",
            "cookie_domain": creds.get("cookie_domain") or "",
        })
    raise ValueError("Platform tidak dikenal: %r (pakai 'idn' atau 'pay4d')" % platform)


def main():
    result = {"ok": False, "online": False, "platform": "", "message": "", "cookies": {}}
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        result["message"] = "Input JSON tidak valid: %s" % e
        emit(result)
        return

    platform_in = inp.get("platform") or ""
    creds = inp.get("creds") or {}
    saved_cookies = inp.get("cookies") or {}

    try:
        plat, sc = build_scraper(platform_in, creds)
        result["platform"] = plat
    except Exception as e:
        result["message"] = str(e)[:300]
        emit(result)
        return

    # 1) Pakai ulang cookie tersimpan (kunci "tidak logout").
    if saved_cookies:
        try:
            sc.load_cookies_dict(saved_cookies)
        except Exception:
            pass

    online = False
    message = ""
    try:
        # 2) Sesi masih valid dari cookie? -> online tanpa login ulang.
        try:
            online = bool(sc.is_session_valid())
        except Exception:
            online = False

        # 3) Belum valid -> login (IDN: user/md5-pass/pin; PAY4D: inject cookie + validasi).
        if not online:
            sc.login()  # ScrapeError bila gagal (kredensial/cookie/maintenance)
            try:
                online = bool(sc.is_session_valid())
            except Exception:
                online = True  # login() sukses = terautentikasi

        message = "Sesi aktif (online)." if online else "Sesi tidak valid (offline)."
        result["ok"] = True
        result["online"] = online
        result["message"] = message
        try:
            result["cookies"] = sc.cookies_dict()
        except Exception:
            result["cookies"] = {}
    except Exception as e:
        # login/cek gagal = OFFLINE dengan alasan (mis. maintenance / cookie kedaluwarsa).
        result["ok"] = True
        result["online"] = False
        result["message"] = str(e)[:300] or "Login gagal."
        try:
            result["cookies"] = sc.cookies_dict()
        except Exception:
            result["cookies"] = {}

    emit(result)


if __name__ == "__main__":
    main()
