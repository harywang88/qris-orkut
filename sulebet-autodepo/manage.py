#!/usr/bin/env python3
"""
CLI admin untuk paket auto-depo sulebet (mode cookie session / Google OAuth).

Alur:
  1. python3 manage.py init
  2. Login manual ke sulebet.com/mimin via Google di browser, ambil cookie PHPSESSID
     (F12 -> Application -> Cookies).
  3. python3 manage.py add-site --name SULEBET --url https://sulebet.link/mimin/ \\
         --cookie 'ISI_PHPSESSID' --bank-id 86
  4. python3 manage.py test-cookie --site 1        # cek cookie valid
  5. python3 manage.py test-deposit --site 1 --member budi --amount 15000
  6. Saat cookie mati -> ambil ulang dari browser:
     python3 manage.py set-cookie --site 1 --cookie 'PHPSESSID_BARU'

  # antrian:
  python3 manage.py add-tx --site 1 --member budi --amount 15000 --ref QR123
  python3 manage.py list-tx
"""

import os
import sys
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db as dbmod
from sulebet_panel import SulebetPanel


def cmd_init(_):
    dbmod.init_db()
    print(f"DB siap: {dbmod.DB_PATH}")


def cmd_add_site(a):
    conn = dbmod.connect()
    conn.execute(
        """INSERT INTO sites (site_name, game_panel_url, cookie_name, cookie_value,
           cookie_domain, cookie_updated_at, game_panel_bank_id, auto_deposit_enabled, status)
           VALUES (?,?,?,?,?,datetime('now'),?,1,'active')""",
        (a.name, a.url, a.cookie_name, a.cookie, a.cookie_domain or "", a.bank_id),
    )
    conn.commit()
    sid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Site '{a.name}' ditambahkan (id={sid}).")


def cmd_set_cookie(a):
    conn = dbmod.connect()
    cur = conn.execute(
        "UPDATE sites SET cookie_value = ?, cookie_updated_at = datetime('now') WHERE id = ?",
        (a.cookie, a.site))
    conn.commit()
    conn.close()
    print("Cookie diperbarui." if cur.rowcount else f"Site id={a.site} tidak ada.")


def cmd_list_sites(_):
    conn = dbmod.connect()
    rows = conn.execute(
        "SELECT id, site_name, game_panel_url, cookie_value, cookie_updated_at, "
        "game_panel_bank_id, auto_deposit_enabled, status FROM sites"
    ).fetchall()
    conn.close()
    if not rows:
        print("(belum ada site)")
        return
    for r in rows:
        ck = r["cookie_value"] or ""
        ck_short = (ck[:8] + "…") if ck else "(kosong)"
        print(f"[{r['id']}] {r['site_name']}  {r['game_panel_url']}  cookie={ck_short}  "
              f"updated={r['cookie_updated_at']}  bank_id={r['game_panel_bank_id']}  "
              f"enabled={r['auto_deposit_enabled']}  status={r['status']}")


def _load_panel(site_id, debug=True):
    conn = dbmod.connect()
    site = conn.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
    conn.close()
    if not site:
        print(f"Site id={site_id} tidak ada.")
        sys.exit(1)
    panel = SulebetPanel(
        site["game_panel_url"].rstrip("/") + "/",
        site["cookie_value"], site["cookie_name"] or "PHPSESSID",
        site["cookie_domain"] or "",
    )
    panel.set_debug(debug)
    panel.set_log_prefix(site["site_name"])
    return panel, site


def cmd_test_cookie(a):
    panel, _ = _load_panel(a.site)
    info = panel.probe()
    for k, v in info.items():
        print(f"  {k}: {v}")
    print("HASIL:", "COOKIE VALID ✓" if info.get("logged_in") else "COOKIE TIDAK VALID ✗ — ambil ulang dari browser")


def cmd_test_deposit(a):
    panel, site = _load_panel(a.site)
    if not panel.is_session_valid():
        print("Cookie TIDAK valid:", panel.get_last_error())
        print("Ambil ulang PHPSESSID dari browser lalu: manage.py set-cookie --site", a.site)
        return
    res = panel.deposit(a.member, a.amount, int(site["game_panel_bank_id"] or 86),
                        a.note or "Test Deposit")
    print("HASIL:", res)


def cmd_add_tx(a):
    conn = dbmod.connect()
    conn.execute(
        """INSERT INTO transactions (site_id, member_id, amount, transaction_id,
           status, paid_at) VALUES (?,?,?,?,'paid', datetime('now'))""",
        (a.site, a.member, a.amount, a.ref),
    )
    conn.commit()
    tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    print(f"Transaksi ditambahkan (id={tid}) untuk site {a.site}, akan diproses worker.")


def cmd_list_tx(_):
    conn = dbmod.connect()
    rows = conn.execute(
        "SELECT id, site_id, member_id, amount, status, auto_deposited, "
        "auto_deposit_success, auto_deposit_message FROM transactions "
        "ORDER BY id DESC LIMIT 30"
    ).fetchall()
    conn.close()
    if not rows:
        print("(belum ada transaksi)")
        return
    state = {0: "pending", 1: "done", 2: "processing", 3: "skip"}
    for r in rows:
        print(f"[{r['id']}] site={r['site_id']} {r['member_id']} Rp{r['amount']:,} "
              f"{r['status']} -> {state.get(r['auto_deposited'], r['auto_deposited'])} "
              f"ok={r['auto_deposit_success']} {r['auto_deposit_message'][:60]}")


def build_parser():
    p = argparse.ArgumentParser(description="Admin auto-depo sulebet (cookie mode)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(func=cmd_init)

    s = sub.add_parser("add-site")
    s.add_argument("--name", required=True)
    s.add_argument("--url", required=True, help=".../mimin/")
    s.add_argument("--cookie", required=True, help="value PHPSESSID dari browser")
    s.add_argument("--cookie-name", default="PHPSESSID")
    s.add_argument("--cookie-domain", default="", help="kosong = auto dari URL")
    s.add_argument("--bank-id", type=int, default=86)
    s.set_defaults(func=cmd_add_site)

    s = sub.add_parser("set-cookie")
    s.add_argument("--site", type=int, required=True)
    s.add_argument("--cookie", required=True)
    s.set_defaults(func=cmd_set_cookie)

    sub.add_parser("list-sites").set_defaults(func=cmd_list_sites)

    s = sub.add_parser("test-cookie")
    s.add_argument("--site", type=int, required=True)
    s.set_defaults(func=cmd_test_cookie)

    s = sub.add_parser("test-deposit")
    s.add_argument("--site", type=int, required=True)
    s.add_argument("--member", required=True)
    s.add_argument("--amount", type=int, required=True)
    s.add_argument("--note", default="")
    s.set_defaults(func=cmd_test_deposit)

    s = sub.add_parser("add-tx")
    s.add_argument("--site", type=int, required=True)
    s.add_argument("--member", required=True)
    s.add_argument("--amount", type=int, required=True)
    s.add_argument("--ref", default="")
    s.set_defaults(func=cmd_add_tx)

    sub.add_parser("list-tx").set_defaults(func=cmd_list_tx)
    return p


if __name__ == "__main__":
    args = build_parser().parse_args()
    args.func(args)
