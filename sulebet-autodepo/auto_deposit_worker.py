#!/usr/bin/env python3
"""
Auto Deposit Worker (mode cookie session).

Jalankan via cron tiap ~1 menit:
  * * * * * /usr/bin/python3 /opt/qris-orkut/sulebet-autodepo/auto_deposit_worker.py >> /opt/qris-orkut/sulebet-autodepo/logs/auto-deposit.log 2>&1

Karena login sulebet = Google OAuth, bot TIDAK login otomatis. Kalau cookie
session mati, worker melapor dan MENUNGGU cookie di-refresh manual
(manage.py set-cookie). Transaksi tetap 'pending' (bukan gagal permanen) supaya
begitu cookie diperbarui, langsung diproses.

Alur:
  1. Recovery: reset stuck (auto_deposited=2 >10 menit belum sukses) -> 0
  2. Untuk tiap site: cek cookie -> kalau valid, deposit transaksi paid (LIMIT 5)
     dgn lock atomik. Kalau mati -> lapor, lewati site.
"""

import os
import sys
import time
import fcntl
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db as dbmod
from sulebet_panel import SulebetPanel

LOCK_FILE = "/tmp/sulebet-auto-deposit-worker.lock"
STUCK_MINUTES = 10
BATCH_LIMIT = 5


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def acquire_lock():
    fp = open(LOCK_FILE, "w")
    try:
        fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("Worker already running, skipping...")
        sys.exit(0)
    return fp


def main():
    lock_fp = acquire_lock()
    log("=== Auto Deposit Worker Started ===")
    dbmod.init_db()
    conn = dbmod.connect()

    cur = conn.execute(
        f"""UPDATE transactions
            SET auto_deposited = 0, auto_deposit_at = NULL
            WHERE auto_deposited = 2 AND auto_deposit_success = 0
              AND auto_deposit_at IS NOT NULL
              AND auto_deposit_at < datetime('now', '-{STUCK_MINUTES} minutes')"""
    )
    conn.commit()
    if cur.rowcount > 0:
        log(f"Recovery: reset {cur.rowcount} stuck transactions (>{STUCK_MINUTES}min)")

    sites = conn.execute(
        """SELECT * FROM sites
           WHERE status = 'active' AND auto_deposit_enabled = 1
             AND game_panel_url != '' AND cookie_value != ''"""
    ).fetchall()
    log(f"Found {len(sites)} sulebet sites with cookie configured")

    for site in sites:
        process_site(conn, site)

    conn.close()
    fcntl.flock(lock_fp, fcntl.LOCK_UN)
    lock_fp.close()
    log("=== Auto Deposit Worker Finished ===\n")


def process_site(conn, site):
    site_name = site["site_name"]
    log(f"Processing site: {site_name} (site_id: {site['id']})")

    txs = conn.execute(
        """SELECT id, member_id, amount, transaction_id, paid_at
           FROM transactions
           WHERE site_id = ? AND status = 'paid'
             AND member_id IS NOT NULL AND member_id != ''
             AND (auto_deposited IS NULL OR auto_deposited = 0)
           ORDER BY paid_at ASC LIMIT ?""",
        (site["id"], BATCH_LIMIT),
    ).fetchall()

    if not txs:
        log("  No pending transactions")
        return

    log(f"  Found {len(txs)} pending transactions")

    panel = SulebetPanel(
        site["game_panel_url"].rstrip("/") + "/",
        site["cookie_value"], site["cookie_name"] or "PHPSESSID",
        site["cookie_domain"] or "",
    )
    panel.set_debug(True)
    panel.set_log_prefix(site_name)

    if not panel.is_session_valid():
        log(f"  COOKIE MATI: {panel.get_last_error()}")
        log(f"  -> Ambil ulang PHPSESSID dari browser, lalu: manage.py set-cookie --site {site['id']}")
        log("  -> Transaksi dibiarkan pending, akan diproses setelah cookie diperbarui.")
        return

    log("  Cookie valid, memproses deposit...")
    bank_id = int(site["game_panel_bank_id"] or 86)
    for trx in txs:
        process_tx(conn, panel, trx, bank_id, site["id"])


def process_tx(conn, panel, trx, bank_id, site_id):
    member = (trx["member_id"] or "").strip()
    log(f"  Depositing: {member} - Rp {int(trx['amount']):,}")

    # Lock atomik
    cur = conn.execute(
        """UPDATE transactions SET auto_deposited = 2, auto_deposit_at = datetime('now')
           WHERE id = ? AND (auto_deposited = 0 OR auto_deposited IS NULL)""",
        (trx["id"],))
    conn.commit()
    if cur.rowcount == 0:
        log("    Skipped - already being processed")
        return

    note = "QRIS Auto " + _clean(trx["transaction_id"] or "")
    result = panel.deposit(member, int(trx["amount"]), bank_id, note)
    success = 1 if result.get("success") else 0
    message = result.get("message", "")
    log(f"    {'SUCCESS' if success else 'FAILED'}: {message}")

    if not success and result.get("expired"):
        # Cookie mati di tengah jalan: JANGAN tandai gagal permanen.
        # Balikkan ke pending (0) supaya diproses lagi setelah cookie di-refresh.
        conn.execute(
            "UPDATE transactions SET auto_deposited = 0, auto_deposit_at = NULL, "
            "auto_deposit_message = ? WHERE id = ?",
            (message, trx["id"]))
        conn.commit()
        log(f"    -> Cookie mati; transaksi dikembalikan ke pending. "
            f"Refresh cookie: manage.py set-cookie --site {site_id}")
        return

    conn.execute(
        """UPDATE transactions SET auto_deposited = 1, auto_deposit_success = ?,
           auto_deposit_message = ?, auto_deposit_by = 'Bot (worker)' WHERE id = ?""",
        (success, message, trx["id"]))
    conn.commit()
    time.sleep(0.5)


def _clean(s):
    import re
    return re.sub(r"[^a-zA-Z0-9 ]", "", s or "")


if __name__ == "__main__":
    main()
