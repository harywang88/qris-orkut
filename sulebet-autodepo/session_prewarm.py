#!/usr/bin/env python3
"""
Sulebet Session Keep-Alive (mode cookie).

Jalankan tiap ~1 menit. Untuk tiap site: GET /mimin/adminarea supaya session
di server tetap fresh (memperpanjang umur PHPSESSID), persis seperti manusia
membuka dashboard. Karena login = Google OAuth, TIDAK ada re-login otomatis —
kalau cookie sudah mati, hanya melapor agar Anda ambil ulang dari browser.

  * * * * * /usr/bin/python3 /opt/qris-orkut/sulebet-autodepo/session_prewarm.py >> /opt/qris-orkut/sulebet-autodepo/logs/prewarm.log 2>&1
"""

import os
import sys
import time
import fcntl
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db as dbmod
from sulebet_panel import SulebetPanel

GLOBAL_LOCK = "/tmp/sulebet-prewarm.lock"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def main():
    fp = open(GLOBAL_LOCK, "w")
    try:
        fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("Another prewarm already running, skip.")
        return

    dbmod.init_db()
    conn = dbmod.connect()
    started = time.time()
    sites = conn.execute(
        """SELECT * FROM sites
           WHERE status = 'active' AND auto_deposit_enabled = 1
             AND game_panel_url != '' AND cookie_value != ''"""
    ).fetchall()
    conn.close()

    if not sites:
        log("No sulebet sites configured.")
        return

    alive = dead = 0
    for site in sites:
        name = site["site_name"]
        panel = SulebetPanel(
            site["game_panel_url"].rstrip("/") + "/",
            site["cookie_value"], site["cookie_name"] or "PHPSESSID",
            site["cookie_domain"] or "",
        )
        if panel.is_session_valid():
            alive += 1
            log(f"[{name}] Session alive (keep-alive OK)")
        else:
            dead += 1
            log(f"[{name}] COOKIE MATI: {panel.get_last_error()} "
                f"-> manage.py set-cookie --site {site['id']}")

    elapsed = round((time.time() - started) * 1000)
    log(f"Done: alive={alive} dead={dead} ({elapsed}ms)")
    fcntl.flock(fp, fcntl.LOCK_UN)
    fp.close()


if __name__ == "__main__":
    main()
