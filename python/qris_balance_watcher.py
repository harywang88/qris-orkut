import argparse
import gzip
import hashlib
import hmac
import json
import os
import signal
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


APP_BASE = "https://app.orderkuota.com"
APP_VERSION_CODE = "260204"
APP_VERSION_NAME = "26.02.04"
PHONE_MODEL = "sdk_gphone_x86"
PHONE_ANDROID_VER = "11"
UI_MODE = "light"
MAX_PAGES = 10
RATE_LIMIT_SECONDS = 300
TIMEOUT_SECONDS = 20
UTC_PLUS_7 = timezone(timedelta(hours=7))

STOP = False
COOLDOWNS: dict[str, float] = {}


def load_env_file(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.exists():
        return values
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_config() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
    file_values = load_env_file(root / ".env")
    merged = {**file_values, **os.environ}
    required = ["DATABASE_URL", "APP_ENCRYPTION_KEY"]
    missing = [key for key in required if not merged.get(key)]
    if missing:
        raise RuntimeError(f"Missing env: {', '.join(missing)}")
    return merged


def normalize_postgres_url(database_url: str) -> str:
    parsed = urllib.parse.urlparse(database_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    filtered = [(key, value) for key, value in query if key.lower() != "schema"]
    rebuilt = parsed._replace(query=urllib.parse.urlencode(filtered))
    return urllib.parse.urlunparse(rebuilt)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def to_db_utc_naive(value: datetime) -> datetime:
    aware = ensure_aware(value) or now_utc()
    return aware.astimezone(timezone.utc).replace(tzinfo=None)


def ensure_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def now_ms() -> int:
    return int(time.time() * 1000)


def parse_amount(value: Any) -> int:
    if value is None:
      return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        cleaned = "".join(ch for ch in value if ch.isdigit())
        return int(cleaned) if cleaned else 0
    return 0


def read_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def parse_session_token(raw: str) -> dict[str, str]:
    parts = raw.split(":")
    if len(parts) == 3:
        auth_username, account_id, token_secret = parts
        return {
            "auth_username": auth_username,
            "account_id": account_id,
            "token_secret": token_secret,
            "auth_token": f"{account_id}:{token_secret}",
        }
    if len(parts) == 2:
        account_id, token_secret = parts
        return {
            "auth_username": account_id,
            "account_id": account_id,
            "token_secret": token_secret,
            "auth_token": raw,
        }
    raise ValueError("Invalid session token format")


def decrypt_value(stored: str, key_hex: str) -> str:
    iv_hex, auth_tag_hex, encrypted_hex = stored.split(":")
    aesgcm = AESGCM(bytes.fromhex(key_hex))
    nonce = bytes.fromhex(iv_hex)
    ciphertext = bytes.fromhex(encrypted_hex) + bytes.fromhex(auth_tag_hex)
    return aesgcm.decrypt(nonce, ciphertext, None).decode("utf-8")


def build_signature(timestamp: str, token_secret: str) -> str:
    return hmac.new(token_secret.encode("utf-8"), timestamp.encode("utf-8"), hashlib.sha512).hexdigest()


def parse_date(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        return to_db_utc_naive(now_utc())
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M"):
        try:
            return to_db_utc_naive(datetime.strptime(text, fmt).replace(tzinfo=UTC_PLUS_7))
        except ValueError:
            continue
    try:
        return to_db_utc_naive(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return to_db_utc_naive(now_utc())


def format_history_from_time(value: datetime | None, overlap_seconds: int = 120) -> str:
    if value is None:
        return ""
    aware = ensure_aware(value)
    if aware is None:
        return ""
    shifted = aware.astimezone(UTC_PLUS_7) - timedelta(seconds=overlap_seconds)
    return shifted.strftime("%d/%m/%Y %H:%M:%S")


def is_rate_limited(status: int, payload: dict[str, Any]) -> bool:
    message = (
        read_string(payload.get("message"))
        or read_string(payload.get("msg"))
        or read_string(payload.get("error"))
    ).lower()
    return status == 469 or "terlalu sering membuka menu qris merchant" in message or "coba kembali 5 menit" in message


def request_form(url: str, body: dict[str, str], token_secret: str) -> tuple[int, dict[str, Any]]:
    timestamp = str(now_ms())
    signature = build_signature(timestamp, token_secret)
    data = urllib.parse.urlencode(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Accept-Encoding": "gzip",
            "Connection": "Keep-Alive",
            "Content-Type": "application/x-www-form-urlencoded",
            "Host": "app.orderkuota.com",
            "Signature": signature,
            "Timestamp": timestamp,
            "User-Agent": "okhttp/5.3.2",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            status = response.getcode()
            raw_body = response.read()
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                raw_body = gzip.decompress(raw_body)
            payload = json.loads(raw_body.decode("utf-8"))
            return status, payload
    except urllib.error.HTTPError as exc:
        raw_body = exc.read()
        if exc.headers.get("Content-Encoding", "").lower() == "gzip":
            raw_body = gzip.decompress(raw_body)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            payload = {"success": False, "message": str(exc)}
        return exc.code, payload


@dataclass
class MerchantRow:
    id: str
    code: str
    merchant_name: str
    status: str
    session_token_encrypted: str | None
    cookies_encrypted: str | None
    device_id: str | None
    last_main_balance: int | None
    last_qris_balance: int | None
    balance_watch_active_seconds: int
    last_watch_probe_at: datetime | None
    last_balance_sync_at: datetime | None


def fetch_merchants(conn: psycopg.Connection[Any]) -> list[MerchantRow]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
              id,
              code,
              "merchantName",
              status,
              "sessionTokenEncrypted",
              "cookiesEncrypted",
              "deviceId",
              "lastMainBalance",
              "lastQrisBalance",
              "balanceWatchActiveSeconds",
              "lastWatchProbeAt",
              "lastBalanceSyncAt"
            FROM "QrisAccount"
            WHERE status = 'active'
              AND "sessionTokenEncrypted" IS NOT NULL
            ORDER BY code ASC
            """
        )
        rows = cur.fetchall()
    return [
        MerchantRow(
            id=row[0],
            code=row[1],
            merchant_name=row[2],
            status=row[3],
            session_token_encrypted=row[4],
            cookies_encrypted=row[5],
            device_id=row[6],
            last_main_balance=row[7],
            last_qris_balance=row[8],
            balance_watch_active_seconds=row[9],
            last_watch_probe_at=row[10],
            last_balance_sync_at=row[11],
        )
        for row in rows
    ]


def merchant_has_open_transaction(conn: psycopg.Connection[Any], account_id: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM "Transaction"
            WHERE "qrisAccountId" = %s
              AND "statusPay" = 'open'
              AND "expiresAt" > NOW()
            LIMIT 1
            """,
            (account_id,),
        )
        return cur.fetchone() is not None


def get_recent_qris_window(conn: psycopg.Connection[Any], account_id: str, limit: int = 40) -> tuple[datetime | None, set[str], int | None]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "transactionTime", "rawHash", "balanceAfter"
            FROM "Mutation"
            WHERE "qrisAccountId" = %s
              AND COALESCE("walletCategory", 'qris') = 'qris'
            ORDER BY "transactionTime" DESC
            LIMIT %s
            """,
            (account_id, limit),
        )
        rows = cur.fetchall()

    latest_time = rows[0][0] if rows else None
    known_hashes = {str(row[1]) for row in rows if row[1]}
    latest_balance_after = int(rows[0][2]) if rows and rows[0][2] is not None else None
    return latest_time, known_hashes, latest_balance_after


def update_probe_status(
    conn: psycopg.Connection[Any],
    account_id: str,
    *,
    status: str,
    error: str | None,
    main_balance: int | None = None,
    qris_balance: int | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "QrisAccount"
            SET
              "lastWatchProbeAt" = NOW(),
              "lastWatchProbeStatus" = %s,
              "lastWatchProbeError" = %s,
              "lastMainBalance" = COALESCE(%s, "lastMainBalance"),
              "lastQrisBalance" = COALESCE(%s, "lastQrisBalance")
            WHERE id = %s
            """,
            (status, error, main_balance, qris_balance, account_id),
        )
    conn.commit()


def update_sync_status(
    conn: psycopg.Connection[Any],
    account_id: str,
    *,
    status: str,
    error: str | None,
    main_balance: int | None,
    qris_balance: int | None,
    raw_json: str,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "QrisAccount"
            SET
              "lastBalanceSyncAt" = NOW(),
              "lastBalanceSyncStatus" = %s,
              "lastBalanceSyncError" = %s,
              "lastBalanceSyncRawJson" = %s,
              "lastMainBalance" = COALESCE(%s, "lastMainBalance"),
              "lastQrisBalance" = COALESCE(%s, "lastQrisBalance")
            WHERE id = %s
            """,
            (status, error, raw_json, main_balance, qris_balance, account_id),
        )
    conn.commit()


def parse_mutation_entry(raw: dict[str, Any], wallet_category: str = "qris") -> dict[str, Any] | None:
    kredit = parse_amount(raw.get("kredit") or raw.get("credit"))
    debet = parse_amount(raw.get("debet") or raw.get("debit"))
    is_credit = kredit > 0
    amount = kredit if is_credit else debet
    if amount == 0:
        return None

    balance_after = parse_amount(
        raw.get("saldo") or raw.get("saldo_akhir") or raw.get("balance_after") or raw.get("saldo_sekarang")
    )
    balance_before = balance_after - kredit + debet if is_credit else balance_after + debet - kredit

    date_str = str(raw.get("tanggal") or raw.get("date") or raw.get("created_at") or raw.get("waktu") or "")
    description = str(raw.get("keterangan") or raw.get("description") or raw.get("note") or raw.get("ket") or "")

    brand = raw.get("brand")
    brand_value = ""
    if isinstance(brand, dict):
        brand_value = str(brand.get("name") or "")
    issuer_fallback = raw.get("bank") or raw.get("bank_name") or raw.get("issuer") or raw.get("bank_ewallet") or raw.get("pengirim") or ""
    issuer_name = str(brand_value or issuer_fallback or "") or None

    rrn = (
        raw.get("rrn")
        or raw.get("ref")
        or raw.get("reference")
        or raw.get("reference_no")
        or raw.get("no_referensi")
    )
    rrn = str(rrn) if rrn else None

    hash_source = f"app-orkut:{wallet_category}:{description}:{date_str}:{amount}:{balance_after}"
    raw_hash = hashlib.sha256(hash_source.encode("utf-8")).hexdigest()

    return {
        "amount": amount,
        "type": "credit" if is_credit else "debit",
        "balance_before": balance_before,
        "balance_after": balance_after,
        "issuer_name": issuer_name,
        "rrn": rrn,
        "wallet_category": wallet_category,
        "transaction_time": parse_date(date_str),
        "raw_data_json": json.dumps(raw, ensure_ascii=False),
        "raw_hash": raw_hash,
    }


def publish_outbox(conn: psycopg.Connection[Any], mutation_id: str, account_id: str, payload: dict[str, Any]) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "OutboxEvent" ("id", topic, "aggregateType", "aggregateId", "qrisAccountId", "payloadJson", status, "availableAt", "createdAt", "attemptCount")
            VALUES (gen_random_uuid()::text, 'mutation.created', 'mutation', %s, %s, %s, 'pending', NOW(), NOW(), 0)
            """,
            (mutation_id, account_id, json.dumps(payload, ensure_ascii=False)),
        )


def insert_mutations(conn: psycopg.Connection[Any], merchant: MerchantRow, mutations: list[dict[str, Any]]) -> int:
    created = 0
    with conn.cursor() as cur:
        for mutation in mutations:
            cur.execute('SELECT id FROM "Mutation" WHERE "rawHash" = %s', (mutation["raw_hash"],))
            if cur.fetchone():
                continue
            cur.execute(
                """
                INSERT INTO "Mutation"
                ("id", "qrisAccountId", amount, type, "balanceBefore", "balanceAfter", "issuerName", rrn, "walletCategory", "transactionTime", "rawHash", "rawDataJson", "createdAt")
                VALUES
                (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                RETURNING id, "createdAt"
                """,
                (
                    merchant.id,
                    mutation["amount"],
                    mutation["type"],
                    mutation["balance_before"],
                    mutation["balance_after"],
                    mutation["issuer_name"],
                    mutation["rrn"],
                    mutation["wallet_category"],
                    mutation["transaction_time"],
                    mutation["raw_hash"],
                    mutation["raw_data_json"],
                ),
            )
            row = cur.fetchone()
            mutation_id = row[0]
            created_at = row[1]
            publish_outbox(
                conn,
                mutation_id,
                merchant.id,
                {
                    "mutationId": mutation_id,
                    "qrisAccountId": merchant.id,
                    "amount": mutation["amount"],
                    "type": mutation["type"],
                    "balanceAfter": mutation["balance_after"],
                    "rrn": mutation["rrn"],
                    "issuerName": mutation["issuer_name"],
                    "walletCategory": mutation["wallet_category"],
                    "matchedTransactionId": None,
                    "transactionTime": mutation["transaction_time"].isoformat(),
                    "createdAt": created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at),
                },
            )
            created += 1
    conn.commit()
    return created


def build_auth_context(merchant: MerchantRow, key_hex: str) -> dict[str, str]:
    if not merchant.session_token_encrypted:
        raise RuntimeError(f"{merchant.code}: session token kosong")
    raw_token = decrypt_value(merchant.session_token_encrypted, key_hex)
    parsed = parse_session_token(raw_token)
    app_reg_id = parsed["account_id"]
    if merchant.cookies_encrypted:
        app_reg_id = decrypt_value(merchant.cookies_encrypted, key_hex)
    phone_uuid = merchant.device_id or parsed["account_id"]
    return {
        **parsed,
        "app_reg_id": app_reg_id,
        "phone_uuid": phone_uuid,
    }


def fetch_account_summary(ctx: dict[str, str]) -> tuple[int, int, dict[str, Any]]:
    status, payload = request_form(
        f"{APP_BASE}/api/v2/get",
        {
            "request_time": str(now_ms()),
            "app_reg_id": ctx["app_reg_id"],
            "phone_android_version": PHONE_ANDROID_VER,
            "app_version_code": APP_VERSION_CODE,
            "phone_uuid": ctx["phone_uuid"],
            "auth_username": ctx["auth_username"],
            "auth_token": ctx["auth_token"],
            "app_version_name": APP_VERSION_NAME,
            "ui_mode": UI_MODE,
            "requests[0]": "account",
            "phone_model": PHONE_MODEL,
        },
        ctx["token_secret"],
    )
    if not payload.get("success", True) or not 200 <= status < 300:
        if is_rate_limited(status, payload):
            raise RuntimeError("RATE_LIMIT")
        raise RuntimeError(read_string(payload.get("message")) or "Gagal membaca account summary")
    account_data = payload.get("account") or {}
    if isinstance(account_data, dict):
        account_data = account_data.get("results") or account_data
    main_balance = parse_amount(account_data.get("balance"))
    qris_balance = parse_amount(account_data.get("qris_balance"))
    return main_balance, qris_balance, payload


def fetch_qris_history(
    ctx: dict[str, str],
    *,
    from_time: datetime | None = None,
    known_hashes: set[str] | None = None,
    max_pages: int = 3,
) -> tuple[list[dict[str, Any]], int | None, int | None]:
    url = f"{APP_BASE}/api/v2/qris/mutasi/{ctx['account_id']}"
    all_mutations: list[dict[str, Any]] = []
    main_balance = None
    qris_balance = None
    known_hashes = known_hashes or set()
    from_date = format_history_from_time(from_time)
    page_limit = max(1, min(max_pages, MAX_PAGES))
    encountered_known = False

    for page in range(1, page_limit + 1):
        status, payload = request_form(
            url,
            {
                "app_reg_id": ctx["app_reg_id"],
                "phone_uuid": ctx["phone_uuid"],
                "phone_model": PHONE_MODEL,
                "requests[qris_history][keterangan]": "",
                "requests[qris_history][jumlah]": "",
                "request_time": str(now_ms()),
                "phone_android_version": PHONE_ANDROID_VER,
                "app_version_code": APP_VERSION_CODE,
                "auth_username": ctx["auth_username"],
                "requests[qris_history][page]": str(page),
                "auth_token": ctx["auth_token"],
                "app_version_name": APP_VERSION_NAME,
                "ui_mode": UI_MODE,
                "requests[qris_history][dari_tanggal]": from_date,
                "requests[0]": "account",
                "requests[qris_history][ke_tanggal]": "",
            },
            ctx["token_secret"],
        )
        if not payload.get("success", True) or not 200 <= status < 300:
            if is_rate_limited(status, payload):
                raise RuntimeError("RATE_LIMIT")
            raise RuntimeError(read_string(payload.get("message")) or "Gagal membaca qris_history")

        account_data = payload.get("account") or {}
        if isinstance(account_data, dict):
            account_data = account_data.get("results") or account_data
        main_balance = parse_amount(account_data.get("balance")) or main_balance
        qris_balance = parse_amount(account_data.get("qris_balance")) or qris_balance

        qris_history = payload.get("qris_history") or {}
        if isinstance(qris_history, dict):
            results = qris_history.get("results") or []
            total_pages = int(qris_history.get("pages") or 1)
        else:
            results = []
            total_pages = 1

        if not isinstance(results, list):
            results = []

        for raw in results:
            if isinstance(raw, dict):
                parsed = parse_mutation_entry(raw, "qris")
                if parsed:
                    if parsed["raw_hash"] in known_hashes:
                        encountered_known = True
                        break
                    all_mutations.append(parsed)

        if encountered_known or page >= total_pages:
            break

    return all_mutations, main_balance, qris_balance


def process_merchant(conn: psycopg.Connection[Any], merchant: MerchantRow, key_hex: str, once: bool = False) -> None:
    if COOLDOWNS.get(merchant.id, 0) > time.time():
        return

    now = now_utc()
    last_probe_at = ensure_aware(merchant.last_watch_probe_at)
    probe_interval = max(1, merchant.balance_watch_active_seconds)
    next_probe_due = not last_probe_at or (now - last_probe_at).total_seconds() >= probe_interval

    if not next_probe_due and not once:
        return

    ctx = build_auth_context(merchant, key_hex)

    try:
        main_balance, qris_balance, _ = fetch_account_summary(ctx)
        changed = (
            merchant.last_qris_balance is None
            or qris_balance != merchant.last_qris_balance
            or (merchant.last_main_balance is not None and main_balance != merchant.last_main_balance)
        )
        update_probe_status(
            conn,
            merchant.id,
            status="changed" if changed else "steady",
            error=None,
            main_balance=main_balance,
            qris_balance=qris_balance,
        )

        latest_time, known_hashes, latest_balance_after = get_recent_qris_window(conn, merchant.id)
        needs_history_fetch = (
            changed
            or once
            or (latest_balance_after is not None and qris_balance != latest_balance_after)
        )

        if needs_history_fetch:
            mutations, hist_main, hist_qris = fetch_qris_history(
                ctx,
                from_time=latest_time,
                known_hashes=known_hashes,
                max_pages=3,
            )
            created = insert_mutations(conn, merchant, mutations)
            update_sync_status(
                conn,
                merchant.id,
                status="synced",
                error=None,
                main_balance=hist_main or main_balance,
                qris_balance=hist_qris or qris_balance,
                raw_json=json.dumps(
                    {
                        "watcher": "python_balance",
                        "createdMutations": created,
                        "reason": (
                            "manual_once"
                            if once
                            else "balance_changed"
                            if changed
                            else "balance_mismatch"
                        ),
                        "incremental": True,
                        "fromTime": latest_time.isoformat() if latest_time and hasattr(latest_time, "isoformat") else None,
                    }
                ),
            )
            print(f"[OK] {merchant.code} probe={qris_balance} changed={changed} needs_history={needs_history_fetch} created={created}")
        else:
            print(f"[OK] {merchant.code} probe={qris_balance} changed=false")
    except RuntimeError as err:
        message = str(err)
        if message == "RATE_LIMIT":
            COOLDOWNS[merchant.id] = time.time() + RATE_LIMIT_SECONDS
            update_probe_status(conn, merchant.id, status="rate_limited", error="Provider menahan akses QRIS sementara (469).")
            update_sync_status(
                conn,
                merchant.id,
                status="rate_limited",
                error="Provider menahan akses QRIS sementara (469).",
                main_balance=merchant.last_main_balance,
                qris_balance=merchant.last_qris_balance,
                raw_json=json.dumps({"watcher": "python_balance", "error": "rate_limited"}),
            )
            print(f"[WARN] {merchant.code} rate limited 469")
        else:
            update_probe_status(conn, merchant.id, status="error", error=message)
            print(f"[ERR] {merchant.code} {message}")


def signal_handler(signum: int, frame: Any) -> None:
    global STOP
    STOP = True


def main() -> int:
    parser = argparse.ArgumentParser(description="QRIS Python balance watcher")
    parser.add_argument("--once", action="store_true", help="Jalankan sekali lalu keluar")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    env = read_config()
    database_url = normalize_postgres_url(env["DATABASE_URL"])
    encryption_key = env["APP_ENCRYPTION_KEY"]

    with psycopg.connect(database_url) as conn:
        conn.autocommit = False
        while not STOP:
            merchants = fetch_merchants(conn)
            if not merchants:
                print("[INFO] tidak ada merchant aktif dengan kredensial app yang siap dipantau")
            for merchant in merchants:
                process_merchant(conn, merchant, encryption_key, once=args.once)

            if args.once:
                break
            time.sleep(1)

    return 0


if __name__ == "__main__":
    sys.exit(main())
