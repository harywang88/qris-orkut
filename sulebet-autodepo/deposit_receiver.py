#!/usr/bin/env python3
"""
Deposit Receiver — jembatan callback "paid/success" dari qris-orkut ke antrian autodepo.

qris-orkut (Node) sudah punya mekanisme callback: saat transaksi QRIS LUNAS,
`attemptDeposit()` mem-POST payload JSON ber-tanda-tangan HMAC ke `client.depositApiUrl`.
Skrip ini adalah penerima POST tersebut. Tugasnya HANYA:

    1. Verifikasi HMAC (X-Deposit-Signature) memakai depositApiKey sulebet.
    2. Masukkan transaksi ke tabel `transactions` autodepo (status 'paid', pending).
       Idempoten pada transaction_id (qrId) -> retry dari app tidak dobel antri.

Setelah itu, `auto_deposit_worker.py` (cron yang sudah ada) yang meng-eksekusi
deposit ke panel sulebet. TIDAK menyentuh skrip lain.

Payload dari qris-orkut (src/shared/deposit.service.ts buildPayload):
    { qrId, transactionId, userId, requestedAmount, finalAmount, paidAmount,
      note, issuerName, rrn, paidAt, externalReference }
      -> userId    = username member sulebet (dari widget ?member=)
      -> finalAmount = nominal yang diterima
      -> qrId      = ref unik

Tanda tangan (deposit.service.ts sendDepositRequest):
    X-Deposit-Timestamp: <unix seconds>
    X-Deposit-Signature: HMAC_SHA256( `${timestamp}.${rawBody}`, depositApiKey )  (hex)

Jalankan sebagai service (lihat crontab.sample / systemd). Dengar di 127.0.0.1
saja karena app Node ada di host yang sama.

ENV:
    SULEBET_RECEIVER_HOST   default 127.0.0.1
    SULEBET_RECEIVER_PORT   default 8787
    SULEBET_RECEIVER_PATH   default /sulebet-deposit
    SULEBET_SITE_ID         default 1   (id site sulebet di autodepo.db)
    SULEBET_DEPOSIT_API_KEY WAJIB — depositApiKey milik client sulebet (secret HMAC)
    SULEBET_SIG_MAX_SKEW    default 300 (detik) toleransi umur timestamp
"""

import os
import sys
import json
import hmac
import hashlib
import logging
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db as dbmod

HOST = os.environ.get("SULEBET_RECEIVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SULEBET_RECEIVER_PORT", "8787"))
PATH = os.environ.get("SULEBET_RECEIVER_PATH", "/sulebet-deposit")
SITE_ID = int(os.environ.get("SULEBET_SITE_ID", "1"))
API_KEY = os.environ.get("SULEBET_DEPOSIT_API_KEY", "")
SIG_MAX_SKEW = int(os.environ.get("SULEBET_SIG_MAX_SKEW", "300"))
MAX_BODY = 64 * 1024  # 64 KB, payload deposit kecil

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("deposit-receiver")


def verify_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    """HMAC-SHA256 atas `${timestamp}.${rawBody}` cocok dgn header signature."""
    if not API_KEY:
        # Tanpa key, TOLAK semua — lebih aman daripada menerima buta.
        log.error("SULEBET_DEPOSIT_API_KEY belum di-set; menolak callback.")
        return False
    if not timestamp or not signature:
        return False
    # Cegah replay callback lama.
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    now = int(datetime.now().timestamp())
    if abs(now - ts) > SIG_MAX_SKEW:
        log.warning("Timestamp di luar toleransi (skew=%ss).", now - ts)
        return False
    mac = hmac.new(
        API_KEY.encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(mac, signature.strip().lower())


def enqueue(payload: dict) -> dict:
    """Masukkan ke antrian autodepo, idempoten pada transaction_id (qrId)."""
    member = str(payload.get("userId") or "").strip()
    ref = str(payload.get("qrId") or payload.get("transactionId") or "").strip()
    try:
        amount = int(payload.get("finalAmount") or payload.get("paidAmount") or 0)
    except (TypeError, ValueError):
        amount = 0

    if not member or member.lower() == "guest":
        return {"ok": False, "reason": "member_kosong", "http": 200}
    if amount <= 0:
        return {"ok": False, "reason": "amount_invalid", "http": 200}
    if not ref:
        return {"ok": False, "reason": "ref_kosong", "http": 200}

    conn = dbmod.connect()
    try:
        # Idempotensi: kalau ref sudah ada untuk site ini, jangan antri lagi.
        dup = conn.execute(
            "SELECT id FROM transactions WHERE site_id = ? AND transaction_id = ? LIMIT 1",
            (SITE_ID, ref),
        ).fetchone()
        if dup:
            return {"ok": True, "dedup": True, "id": dup["id"], "http": 200}

        paid_at = payload.get("paidAt") or None
        conn.execute(
            """INSERT INTO transactions (site_id, member_id, amount, transaction_id,
               status, paid_at) VALUES (?,?,?,?, 'paid', COALESCE(?, datetime('now')))""",
            (SITE_ID, member, amount, ref, paid_at),
        )
        conn.commit()
        tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"ok": True, "id": tid, "http": 200}
    finally:
        conn.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "SulebetDepositReceiver/1.0"

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Health check ringan.
        if self.path.split("?")[0] in (PATH, "/health", "/"):
            self._json(200, {"ok": True, "service": "sulebet-deposit-receiver"})
        else:
            self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self):
        if self.path.split("?")[0] != PATH:
            self._json(404, {"ok": False, "error": "not_found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"ok": False, "error": "bad_length"})
            return
        raw = self.rfile.read(length)

        timestamp = self.headers.get("X-Deposit-Timestamp", "")
        signature = self.headers.get("X-Deposit-Signature", "")
        if not verify_signature(raw, timestamp, signature):
            log.warning("Signature tidak valid dari %s", self.client_address[0])
            self._json(401, {"ok": False, "error": "invalid_signature"})
            return

        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"ok": False, "error": "bad_json"})
            return

        try:
            result = enqueue(payload)
        except Exception as exc:  # noqa: BLE001
            log.exception("Gagal enqueue: %s", exc)
            # 500 -> app qris-orkut akan retry sesuai jadwalnya.
            self._json(500, {"ok": False, "error": "enqueue_failed"})
            return

        if result.get("ok"):
            if result.get("dedup"):
                log.info("DEDUP ref sudah antri (id=%s) %s Rp%s",
                         result.get("id"), payload.get("userId"), payload.get("finalAmount"))
            else:
                log.info("ANTRI id=%s member=%s Rp%s ref=%s",
                         result.get("id"), payload.get("userId"),
                         payload.get("finalAmount"), payload.get("qrId"))
            self._json(200, {"success": True, "queued": True, "id": result.get("id")})
        else:
            # 200 supaya app tidak retry hal yang memang tidak bisa diproses
            # (mis. member 'guest' / amount 0). Dicatat untuk audit.
            log.warning("DITOLAK ref=%s reason=%s payload_member=%s",
                        payload.get("qrId"), result.get("reason"), payload.get("userId"))
            self._json(result.get("http", 200),
                       {"success": False, "queued": False, "reason": result.get("reason")})

    def log_message(self, fmt, *args):  # matikan akses-log bawaan; kita log sendiri
        return


def main():
    dbmod.init_db()
    if not API_KEY:
        log.error("PERINGATAN: SULEBET_DEPOSIT_API_KEY kosong -> SEMUA callback ditolak. "
                  "Set env dari client.depositApiKey sulebet.")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("Deposit receiver dengar di http://%s:%s%s (site_id=%s)", HOST, PORT, PATH, SITE_ID)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        log.info("Deposit receiver berhenti.")


if __name__ == "__main__":
    main()
