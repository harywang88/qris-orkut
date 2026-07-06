"""
SulebetPanel — Auto-deposit connector untuk panel Sulebet (mode COOKIE SESSION).

Panel sulebet /mimin sekarang login via Google OAuth, jadi bot TIDAK bisa login
otomatis (username/password/captcha). Pola-nya seperti pay4d.py ayuchenbot:
  1. Admin login manual di browser via Google.
  2. Ambil cookie PHPSESSID (F12 -> Application -> Cookies).
  3. Cookie disimpan (di DB), bot inject cookie itu untuk semua operasi.
  4. Keep-alive tiap cron memperpanjang umur session; kalau mati, bot LAPOR
     'cookie kadaluarsa' (tak bisa auto-relogin — harus ambil ulang manual).

Deposit tetap: adminarea -> editCreditUsersManual (parse bankasal) ->
updateCreditUsersManual. Hanya butuh `requests` (bankasal via regex).
"""

import re
import json
import time
import os
from urllib.parse import urlsplit

import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Marker halaman login (kalau muncul = cookie sudah mati, ke-redirect ke login)
LOGIN_MARKERS = (
    "continue with google", "sign in with google", "sign in with your organization",
    "access is restricted", "formlogin", "captchaimg", "/auth/google",
)


class SulebetPanel:
    """Connector deposit panel Sulebet via cookie session (login manual Google)."""

    def __init__(self, base_url, cookie_value, cookie_name="PHPSESSID", cookie_domain=""):
        self.base_url = base_url.rstrip("/") + "/"            # e.g. https://sulebet.link/mimin/
        parts = urlsplit(self.base_url)
        self.site_root = f"{parts.scheme}://{parts.netloc}/"   # e.g. https://sulebet.link/
        self.cookie_name = (cookie_name or "PHPSESSID").strip()
        self.cookie_value = (cookie_value or "").strip()
        self.cookie_domain = (cookie_domain or "").strip().lstrip(".") or parts.netloc
        self.last_error = ""
        self.debug = False
        self.log_prefix = ""

        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self.session.verify = False
        self._inject_cookie()

    # ------------------------------------------------------------------ #
    def set_debug(self, debug):
        self.debug = bool(debug)

    def set_log_prefix(self, prefix):
        self.log_prefix = prefix or ""

    def get_last_error(self):
        return self.last_error

    def _log(self, message):
        if self.debug:
            from datetime import datetime
            prefix = f"[{self.log_prefix}] " if self.log_prefix else ""
            print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {prefix}{message}", flush=True)

    # ------------------------------------------------------------------ #
    # Cookie injection (dukung 1 value PHPSESSID ATAU string penuh 'A=1; B=2')
    # ------------------------------------------------------------------ #
    def _cookie_pairs(self):
        val = self.cookie_value
        pairs = []
        if "=" in val:
            for part in val.split(";"):
                part = part.strip()
                if "=" in part:
                    k, v = part.split("=", 1)
                    if k.strip():
                        pairs.append((k.strip(), v.strip()))
        if not pairs:
            pairs = [(self.cookie_name, val)]
        return pairs

    def _inject_cookie(self):
        if not self.cookie_value:
            return
        for name, value in self._cookie_pairs():
            for dom in {self.cookie_domain, "." + self.cookie_domain}:
                try:
                    self.session.cookies.set(name, value, domain=dom, path="/")
                except Exception:            # noqa: BLE001
                    pass

    # ------------------------------------------------------------------ #
    def _is_login_page(self, final_url, body):
        f = (final_url or "").lower()
        if any(s in f for s in ("accounts.google", "/login", "signin", "oauth", "/auth/google")):
            return True
        low = (body or "").lower()
        return any(m in low for m in LOGIN_MARKERS)

    # ------------------------------------------------------------------ #
    # HTTP helper
    # ------------------------------------------------------------------ #
    def request(self, url, method="GET", data=None, headers=None, timeout=30):
        hdr = {
            "Accept": "*/*",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": self.site_root,
        }
        if headers:
            hdr.update(headers)
        try:
            if method.upper() == "POST":
                r = self.session.post(url, data=data or {}, headers=hdr,
                                      timeout=timeout, allow_redirects=True)
            else:
                r = self.session.get(url, headers=hdr, timeout=timeout, allow_redirects=True)
        except requests.RequestException as e:
            self.last_error = f"request error: {e}"
            return False
        if r.status_code >= 400:
            self.last_error = f"HTTP {r.status_code}"
            return False
        return r.text

    # ================================================================== #
    # PUBLIC
    # ================================================================== #
    def is_session_valid(self):
        """Cek cookie masih hidup lewat ENDPOINT API asli (ground truth).

        Panel sulebet menyembunyikan /mimin (redirect ke 404), tapi endpoint SPA
        seperti process/users/editCreditUsersManual tetap sah dengan cookie benar.
        Form deposit yang sah selalu memuat <select class="...ec_bankasal...">.
        """
        if not self.cookie_value:
            self.last_error = "Cookie PHPSESSID kosong"
            return False
        response = self.request(
            self.site_root + "process/users/editCreditUsersManual",
            "POST", {"username": "", "page": 1},
        )
        if response is False:
            return False
        if self._is_login_page("", response):
            self.last_error = "Cookie kadaluarsa (ke-redirect ke login)"
            return False
        # Form deposit sah -> ada ec_bankasal / ec_op / 'Form Deposit'
        low = response.lower()
        return ("ec_bankasal" in low) or ("ec_op" in low) or ("form deposit" in low)

    def deposit(self, member_username, amount, bank_id=86, note=""):
        """Submit deposit. Return dict {success, message, [expired]}.

        Tidak ada auto-relogin: kalau session mati, kembalikan expired=True dan
        pesan minta ambil ulang cookie dari browser.
        """
        # Step 1: buka form deposit -> parse bankasal
        # (panel /mimin di-hide; endpoint API langsung sah dengan cookie benar)
        edit = self.request(
            self.site_root + "process/users/editCreditUsersManual",
            "POST", {"username": member_username, "page": 1},
        )
        if edit is False:
            return {"success": False, "message": "Gagal buka form deposit: " + self.last_error}

        if self._is_login_page("", edit):
            return {"success": False, "expired": True,
                    "message": "Cookie kadaluarsa — ambil ulang PHPSESSID dari browser"}

        low_edit = edit.lower()

        # Isolasi blok <select ...ec_bankasal...>...</select> DULU — kalau tidak,
        # regex .*? bisa nyasar ke <select ec_bank> (bank tujuan) dan mengambil
        # option value dari situ, sehingga user tak-ada pun lolos deposit.
        block_m = re.search(
            r'<select[^>]*class="[^"]*ec_bankasal[^"]*"[^>]*>(.*?)</select>',
            edit, re.I | re.S,
        )
        block = block_m.group(1) if block_m else ""

        # bank asal HANYA valid bila ada <option ... selected> di dalam blok itu.
        # User valid selalu punya bank asal ter-select; user tak-ada -> 0 option.
        bank_asal = ""
        sel = re.search(r'<option\s+value="(\d+)"[^>]*\bselected', block, re.I | re.S)
        if sel:
            bank_asal = sel.group(1)

        if not bank_asal:
            # Tidak ada bank asal ter-select = user tidak ada / tak punya bank.
            # JANGAN fallback ke option pertama (bahaya: deposit ke bank acak).
            n_opt = len(re.findall(r"<option", block, re.I))
            if "tidak ditemukan" in low_edit or n_opt == 0:
                return {"success": False,
                        "message": f"User '{member_username}' tidak ditemukan / tidak punya bank asal di panel"}
            return {"success": False,
                    "message": f"Bank asal user '{member_username}' tidak ter-select "
                               f"({n_opt} opsi) — deposit dibatalkan demi keamanan"}
            return {"success": False, "message": "Gagal parse bank asal dari form deposit"}

        self._log(f"Form deposit loaded. Bank asal: {bank_asal}, Bank tujuan: {bank_id}")

        # Step 2: submit deposit
        clean_note = re.sub(r"[^a-zA-Z0-9 ]", "", note or "Auto Deposit QRIS")
        submit = self.request(
            self.site_root + "process/users/updateCreditUsersManual", "POST",
            {"username": member_username, "amount": amount, "op": "bayar",
             "bank": bank_id, "bankasal": bank_asal, "note": clean_note, "page": 1},
        )
        if submit is False:
            return {"success": False, "message": "Gagal submit deposit: " + self.last_error}

        try:
            j = json.loads(submit)
        except ValueError:
            if self._is_login_page("", submit):
                return {"success": False, "expired": True,
                        "message": "Cookie kadaluarsa — ambil ulang PHPSESSID dari browser"}
            return {"success": False, "message": "Response bukan JSON: " + submit[:200]}

        err = j.get("error") or {}
        code = err.get("code", 0)
        msg = err.get("message", "Unknown")
        if code == 200 or "berhasil" in msg.lower() or "success" in msg.lower():
            self._log(f"Deposit berhasil: {msg}")
            return {"success": True, "message": msg}
        return {"success": False, "message": msg}

    def probe(self):
        """Diagnostik 'Tes Cookie': cek login via endpoint API asli + info."""
        info = {"logged_in": False, "api_status": 0, "has_deposit_form": False,
                "is_login_page": None, "egress_ip": ""}
        try:
            info["egress_ip"] = requests.get("https://api.ipify.org", timeout=8).text.strip()
        except Exception:                    # noqa: BLE001
            pass
        if not self.cookie_value:
            info["error"] = "Cookie value kosong"
            return info
        try:
            r = self.session.post(
                self.site_root + "process/users/editCreditUsersManual",
                data={"username": "", "page": 1},
                headers={"X-Requested-With": "XMLHttpRequest", "Referer": self.site_root},
                timeout=15, allow_redirects=True,
            )
        except requests.RequestException as e:
            info["error"] = str(e)
            return info
        info["api_status"] = r.status_code
        info["is_login_page"] = self._is_login_page(r.url, r.text)
        low = r.text.lower()
        info["has_deposit_form"] = ("ec_bankasal" in low) or ("form deposit" in low)
        info["logged_in"] = (r.status_code == 200 and not info["is_login_page"]
                             and info["has_deposit_form"])
        return info
