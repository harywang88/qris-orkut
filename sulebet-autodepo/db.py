"""
Lapisan DB standalone (SQLite) untuk auto-depo sulebet.

Dua tabel — meniru widget_merchants + widget_transactions alfaelpay, tapi mandiri:
  - sites        : konfig panel per situs (URL /mimin, username, password terenkripsi, pin, bank_id)
  - transactions : transaksi paid yang perlu di-deposit + state machine auto_deposited

State machine auto_deposited (sama semantik dgn PHP):
  0 = pending (belum diproses)
  2 = sedang diproses (lock atomik)
  1 = selesai (lihat auto_deposit_success 0/1)
  3 = skip permanen (mis. member_id kosong)
"""

import os
import sqlite3

DB_PATH = os.environ.get(
    "SULEBET_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "autodepo.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    site_name            TEXT NOT NULL,
    game_panel_url       TEXT NOT NULL,              -- .../mimin/
    -- Login sulebet = Google OAuth. Bot pakai cookie session dari browser (login manual).
    cookie_name          TEXT DEFAULT 'PHPSESSID',
    cookie_value         TEXT NOT NULL DEFAULT '',   -- value PHPSESSID (atau 'A=1; B=2' penuh)
    cookie_domain        TEXT DEFAULT '',            -- kosong = auto dari URL
    cookie_updated_at    TEXT,                        -- kapan cookie terakhir di-refresh manual
    game_panel_bank_id   INTEGER DEFAULT 86,
    auto_deposit_enabled INTEGER DEFAULT 1,
    status               TEXT DEFAULT 'active',
    created_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id               INTEGER NOT NULL,
    member_id             TEXT,                       -- username member di panel
    amount                INTEGER NOT NULL,
    transaction_id        TEXT,                       -- ref unik (mis. qrId gateway)
    note                  TEXT DEFAULT '',            -- note deposit (dari payload qris-orkut)
    status                TEXT DEFAULT 'paid',        -- hanya 'paid' yang diproses
    paid_at               TEXT,
    auto_deposited        INTEGER DEFAULT 0,          -- 0/1/2/3 (lihat modul docstring)
    auto_deposit_success  INTEGER DEFAULT 0,
    auto_deposit_message  TEXT DEFAULT '',
    auto_deposit_at       TEXT,
    auto_deposit_by       TEXT DEFAULT '',
    created_at            TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_tx_pending
    ON transactions (site_id, status, auto_deposited);
"""


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")       # aman untuk worker+prewarm paralel
    conn.execute("PRAGMA busy_timeout=10000;")
    return conn


def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    # Migrasi additif: kolom note untuk DB lama yang tabelnya sudah ada tanpa 'note'.
    cols = [r[1] for r in conn.execute("PRAGMA table_info(transactions)").fetchall()]
    if "note" not in cols:
        conn.execute("ALTER TABLE transactions ADD COLUMN note TEXT DEFAULT ''")
    conn.commit()
    conn.close()


if __name__ == "__main__":
    init_db()
    print(f"DB siap: {DB_PATH}")
