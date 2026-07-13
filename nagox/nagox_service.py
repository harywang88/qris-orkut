#!/usr/bin/env python3
"""
Nagox sync service — login (3-step: device-token -> username/password) + standby,
tarik saldo bank dari /api/data-banks/lazy-grid tiap N detik, tulis ke
data/nagox-balances.json (auto-replace tiap tarik). Dipakai qris-orkut (Daftar Bank + Kirim Uang + badge).
Kredensial dibaca dari data/nagox_config.json (chmod 600, gitignored). JANGAN log kredensial.
"""
import os, re, json, time, html, sys
from urllib.parse import urlencode
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CFG_PATH = os.path.join(HERE, "..", "data", "nagox_config.json")
OUT_PATH = os.path.join(HERE, "..", "data", "nagox-balances.json")
CFG = json.load(open(CFG_PATH, "r", encoding="utf-8"))
BASE = CFG.get("base", "https://app.nagox.id").rstrip("/")
INTERVAL = int(CFG.get("interval", 10))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
# Tipe bank Nagox yg ditarik (Deposit/Withdraw tak perlu - koko 10 Jul). Override via config "bankTipes".
BANK_TIPES = CFG.get("bankTipes", ["KAS WD", "Bank Kas 1"])

def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), "[nagox]", *a, flush=True)

def _csrf(t):
    m = re.search(r'name="csrf-token"\s+content="([^"]+)"', t) or re.search(r'csrf-token"\s+content="([^"]+)"', t)
    return m.group(1) if m else None

def make_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept": "text/html,application/json,*/*"})
    return s

def login(s):
    r = s.get(BASE + "/login", timeout=25)
    c = _csrf(r.text)
    if not c:
        raise RuntimeError("csrf tidak ditemukan")
    rv = s.post(BASE + "/device-token/validate", json={"token": CFG["token"]},
                headers={"X-CSRF-TOKEN": c, "X-Requested-With": "XMLHttpRequest", "Referer": BASE + "/login"}, timeout=25)
    try:
        okv = rv.json().get("success")
    except Exception:
        okv = False
    if not okv:
        raise RuntimeError("device-token ditolak")
    r2 = s.get(BASE + "/login", timeout=25)
    m = re.search(r'name="_token"[^>]*value="([^"]+)"', r2.text)
    if not m:
        raise RuntimeError("_token login tidak ditemukan")
    s.post(BASE + "/login", data={"_token": m.group(1), "username": CFG["username"], "password": CFG["password"]},
           headers={"Referer": BASE + "/login", "Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    rd = s.get(BASE + "/dashboard", timeout=25)
    return ("loginForm" not in rd.text) and ("Dashboard" in rd.text or "Saldo" in rd.text or "Logout" in rd.text or "Keluar" in rd.text)

def _clean(x):
    return html.unescape(re.sub(r"<[^>]+>", " ", x)).replace("\xa0", " ").strip()

def parse_cards(t):
    banks = []
    parts = re.split(r'(?=<div class="bank-grid-card")', t)
    for c in parts:
        if 'bank-grid-card' not in c:
            continue
        def grab(cls):
            m = re.search(r'class="[^"]*' + cls + r'[^"]*"[^>]*>(.*?)</(?:div|span|p|h[1-6]|a|small|strong)>', c, re.S)
            return _clean(m.group(1)) if m else ""
        bank = grab("bank-grid-title")
        norek = re.sub(r"[^0-9]", "", grab("account-number"))
        nama = grab("account-name")
        saldo_raw = grab("bank-grid-saldo-amount") or grab("saldo-amount")
        saldo = int(re.sub(r"[^0-9]", "", saldo_raw) or "0")
        panel = grab("bank-grid-panel") or grab("bank-grid-panel-name")
        status = grab("bank-grid-status")
        if not norek:
            continue
        banks.append({"bank": bank.upper(), "namaRekening": nama.upper(), "noRekening": norek,
                      "saldo": saldo, "saldoText": saldo_raw, "panel": panel.upper(), "status": status.upper()})
    return banks

def write_out(banks, logged_in):
    data = {"syncedAt": int(time.time() * 1000), "loggedIn": bool(logged_in), "count": len(banks), "banks": banks}
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False))
    os.replace(tmp, OUT_PATH)

def fetch_banks(s):
    # Tarik lazy-grid PER tipe_bank lalu gabung by norek. Nagox default (tanpa filter) TIDAK memuat
    # "Bank Kas 1" -> rekening tipe itu tak dapat saldo. Dedup: kalau dobel lintas-tipe, utamakan saldo>0.
    merged = {}
    for tp in BANK_TIPES:
        r = s.get(BASE + "/api/data-banks/lazy-grid?" + urlencode({"tipe_bank": tp, "per_page": "100"}),
                  headers={"X-Requested-With": "XMLHttpRequest"}, timeout=25)
        if "loginForm" in r.text or "/login" in str(r.url):
            raise RuntimeError("sesi hilang (redirect login)")
        for b in parse_cards(r.text):
            ex = merged.get(b["noRekening"])
            if ex is None or (b["saldo"] > 0 and ex["saldo"] == 0):
                merged[b["noRekening"]] = b
    return list(merged.values())

def run_once(query=None):
    s = make_session()
    ok = login(s)
    print("login:", "OK" if ok else "GAGAL")
    banks = fetch_banks(s)
    print("total bank:", len(banks))
    if banks:
        print("contoh:", json.dumps({k: banks[0][k] for k in ("bank", "namaRekening", "noRekening", "saldoText", "panel")}, ensure_ascii=False))
    if query:
        hit = [b for b in banks if query in b["noRekening"] or query.upper() in b["namaRekening"]]
        for h in hit:
            print("MATCH:", json.dumps({k: h[k] for k in ("bank", "namaRekening", "noRekening", "saldoText", "panel", "status")}, ensure_ascii=False))
        if not hit:
            print("TIDAK KETEMU:", query)

def main():
    s = make_session()
    logged = False
    fails = 0
    while True:
        try:
            if not logged:
                logged = login(s)
                log("login:", "OK" if logged else "GAGAL")
                if not logged:
                    fails += 1
                    time.sleep(min(60, INTERVAL * (1 + fails)))
                    continue
                fails = 0
            banks = fetch_banks(s)
            write_out(banks, True)
            log("sync ok:", len(banks), "bank")
        except Exception as e:
            logged = False
            fails += 1
            log("err:", str(e)[:100])
        time.sleep(INTERVAL)

if __name__ == "__main__":
    if "--once" in sys.argv:
        q = None
        for a in sys.argv[1:]:
            if a != "--once":
                q = a
        run_once(q)
    else:
        main()
