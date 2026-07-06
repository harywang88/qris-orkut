import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html import unescape
from html.parser import HTMLParser
from typing import Any


TIMEOUT_SECONDS = 20
UTC_PLUS_7 = timezone(timedelta(hours=7))
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/147.0.0.0 Safari/537.36"
)

MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "mei": 5,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "agu": 8,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "okt": 10,
    "nov": 11,
    "dec": 12,
    "des": 12,
}


def read_json_stdin() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"stdin JSON tidak valid: {exc}") from exc


def clean_text(value: str) -> str:
    value = unescape(value or "")
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def parse_amount(value: str) -> int | None:
    text = clean_text(value)
    if not text:
        return None
    sign = -1 if "(" in text and ")" in text else 1
    if "-" in text[:3]:
        sign = -1
    digits = re.sub(r"[^\d]", "", text)
    if not digits:
        return None
    return sign * int(digits)


def parse_datetime(value: str) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None

    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=UTC_PLUS_7)
        except ValueError:
            pass

    month_match = re.match(r"^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$", text)
    if month_match:
        day, mon, year, hour, minute, second = month_match.groups()
        month = MONTHS.get(mon.lower())
        if month:
            return datetime(
                int(year),
                month,
                int(day),
                int(hour),
                int(minute),
                int(second or "0"),
                tzinfo=UTC_PLUS_7,
            )

    return None


def looks_like_datetime(value: str) -> bool:
    return parse_datetime(value) is not None


def normalize_minute(value: Any) -> str:
    # System B: harus identik dengan normalizeMinuteStamp() di app-orkut.gateway.js (JS)
    # -> "DD/MM/YYYY HH:MM" (detik dibuang) supaya hash QRIS app-api & web report cocok.
    text = str(value if value is not None else "")
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})\D+(\d{1,2}):(\d{2})", text)
    if not m:
        return text.strip()
    d, mo, y, h, mi = m.groups()
    return f"{int(d):02d}/{int(mo):02d}/{y} {int(h):02d}:{mi}"


def normalize_header(value: str) -> str:
    text = clean_text(value).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return text


def find_rrn(*values: str) -> str | None:
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"(?:rrn|ref(?:erence)?|no referensi|no_referensi)[:#\s-]*([A-Z0-9]+)", text, re.I)
        if match:
            return match.group(1)
        match = re.search(r"#([0-9]{6,})", text)
        if match:
            return match.group(1)
    return None


def find_transaction_id(*values: str) -> str | None:
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"(?:trx\s*#|trxid[:#\s-]*)(\d{6,})", text, re.I)
        if match:
            return match.group(1)
    return None


def find_transfer_code(*values: str) -> str | None:
    for value in values:
        text = clean_text(value)
        if not text:
            continue
        match = re.search(r"\bP#([A-Z0-9]+)\b", text, re.I)
        if match:
            return match.group(1)
    return None


@dataclass
class TableCell:
    tag: str
    text: str


class TableCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[TableCell]]] = []
        self._current_table: list[list[TableCell]] | None = None
        self._current_row: list[TableCell] | None = None
        self._current_cell_tag: str | None = None
        self._current_cell_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._current_table = []
        elif tag == "tr" and self._current_table is not None:
            self._current_row = []
        elif tag in ("td", "th") and self._current_row is not None:
            self._current_cell_tag = tag
            self._current_cell_parts = []
        elif tag == "br" and self._current_cell_tag:
            self._current_cell_parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._current_row is not None and self._current_cell_tag == tag:
            self._current_row.append(TableCell(tag=tag, text=clean_text("".join(self._current_cell_parts))))
            self._current_cell_tag = None
            self._current_cell_parts = []
        elif tag == "tr" and self._current_table is not None and self._current_row is not None:
            if self._current_row:
                self._current_table.append(self._current_row)
            self._current_row = None
        elif tag == "table" and self._current_table is not None:
            if self._current_table:
                self.tables.append(self._current_table)
            self._current_table = None

    def handle_data(self, data: str) -> None:
        if self._current_cell_tag:
            self._current_cell_parts.append(data)


def build_headers(cookie: str, user_agent: str, referer: str) -> dict[str, str]:
    host = urllib.parse.urlparse(referer).hostname or ""
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,id-ID;q=0.8,id;q=0.7",
        "Cache-Control": "no-cache",
        "Cookie": cookie,
        "Host": host,
        "Pragma": "no-cache",
        "Referer": referer,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": user_agent or DEFAULT_USER_AGENT,
    }


def fetch_html(url: str, cookie: str, user_agent: str, referer: str | None = None) -> str:
    req = urllib.request.Request(
        url,
        headers=build_headers(cookie, user_agent, referer or url),
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            body = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            return body.decode(charset, errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} saat membuka {url}: {body[:180]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Gagal membuka {url}: {exc.reason}") from exc


def extract_total_pages(html: str, keyword: str) -> int:
    matches = re.findall(rf"{re.escape(keyword)}(?:/index/|\?page=)(\d+)", html, re.I)
    pages = [int(value) for value in matches if value.isdigit()]
    return max(pages) if pages else 1


def row_to_texts(row: list[TableCell]) -> list[str]:
    return [cell.text for cell in row]


def looks_like_candidate_table(table: list[list[TableCell]]) -> bool:
    if len(table) < 2:
        return False
    flat_rows = [row_to_texts(row) for row in table[:5]]
    if any(any(looks_like_datetime(cell) for cell in row) for row in flat_rows):
        return True
    headers = " ".join(" ".join(row) for row in flat_rows).lower()
    return any(token in headers for token in ["tanggal", "waktu", "saldo", "kredit", "debet", "mutasi"])


def extract_best_table(html: str) -> list[list[TableCell]]:
    parser = TableCollector()
    parser.feed(html)
    candidates = [table for table in parser.tables if looks_like_candidate_table(table)]
    if not candidates:
        return []
    return max(candidates, key=len)


def detect_table_pattern(table: list[list[TableCell]]) -> str | None:
    if not table:
        return None
    _, headers = find_header_row(table)
    normalized_headers = [normalize_header(header) for header in headers]
    if normalized_headers[:6] == ["tanggal", "keterangan", "nominal", "potongan", "jumlah", "saldo akhir"]:
        return "6-column settlement table"
    if normalized_headers[:4] == ["tanggal", "keterangan", "jumlah", "saldo akhir"]:
        return "4-column signed amount"
    return None


def extract_account_name(html: str) -> str | None:
    match = re.search(r'<div class="name"[^>]*>\s*([^<]+?)\s*</div>', html, re.I)
    return clean_text(match.group(1)) if match else None


def find_header_row(table: list[list[TableCell]]) -> tuple[int, list[str]]:
    for idx, row in enumerate(table[:3]):
        texts = row_to_texts(row)
        header_score = sum(1 for cell in texts if normalize_header(cell) in {
            "tanggal", "waktu", "keterangan", "mutasi", "debet", "debit", "kredit",
            "amount", "saldo", "saldo akhir", "balance", "status", "rrn", "pengirim",
        })
        if header_score >= 2 or all(cell.tag == "th" for cell in row):
            return idx, texts
    return -1, []


def find_index(headers: list[str], *candidates: str) -> int:
    normalized = [normalize_header(header) for header in headers]
    for candidate in candidates:
        cand = normalize_header(candidate)
        for idx, header in enumerate(normalized):
            if header == cand or cand in header or header in cand:
                return idx
    return -1


def build_description(parts: list[str]) -> str:
    values = [clean_text(part) for part in parts if clean_text(part)]
    return " | ".join(dict.fromkeys(values))


def parse_report_table_rows(table: list[list[TableCell]], wallet: str) -> list[dict[str, Any]]:
    if not table:
        return []

    header_idx, headers = find_header_row(table)
    normalized_headers = [normalize_header(header) for header in headers]
    expected_headers = ["tanggal", "keterangan", "nominal", "potongan", "jumlah", "saldo akhir"]
    if len(normalized_headers) < 6 or normalized_headers[:6] != expected_headers:
        return []

    results: list[dict[str, Any]] = []
    for row in table[header_idx + 1:]:
        texts = row_to_texts(row)
        if len(texts) < 6:
            continue

        date_text = texts[0]
        tx_time = parse_datetime(date_text)
        if not tx_time:
            continue

        description = clean_text(texts[1])
        nominal = parse_amount(texts[2]) or 0
        potongan = parse_amount(texts[3]) or 0
        jumlah = parse_amount(texts[4]) or 0
        balance_after = parse_amount(texts[5])
        if balance_after is None:
            continue

        is_credit = jumlah > 0
        amount = jumlah if is_credit else nominal
        if amount <= 0:
            continue

        rrn = find_rrn(description)
        is_payout = description.lower().startswith("orderkuota - pencairan saldo qris")
        issuer_name = None if is_payout else description
        balance_before = balance_after - amount if is_credit else balance_after + amount

        raw = {
            "wallet": wallet,
            "source": "report.orderkuota.com",
            "cells": texts[:6],
            "date": clean_text(date_text),
            "description": description,
            "nominal": nominal,
            "potongan": potongan,
            "jumlah": jumlah,
            "status": "IN" if is_credit else "OUT",
            "rrn": rrn or None,
            "balanceAfter": balance_after,
        }
        # System B: hash QRIS BERSAMA (identik dengan app-orkut.gateway.js) -> RRN dari web report
        # menempel ke baris app-api yang sama tanpa bikin duplikat. Detik dibuang, deskripsi/RRN
        # sengaja TIDAK ikut hash (format deskripsi beda antar sumber). saldo_akhir jadi penjamin unik.
        hash_source = (
            f"okmutasi:qris:{normalize_minute(raw['date'])}:{amount}:{balance_after}"
        )
        results.append({
            "amount": amount,
            "type": "credit" if is_credit else "debit",
            "balanceBefore": balance_before,
            "balanceAfter": balance_after,
            "issuerName": issuer_name,
            "rrn": rrn or None,
            "walletCategory": wallet,
            "transactionTime": tx_time.astimezone(UTC_PLUS_7).isoformat(),
            "rawDataJson": json.dumps(raw, ensure_ascii=False),
            "rawHash": hashlib.sha256(hash_source.encode("utf-8")).hexdigest(),
        })

    return results


def parse_main_report_table_rows(table: list[list[TableCell]], wallet: str) -> list[dict[str, Any]]:
    if not table:
        return []

    header_idx, headers = find_header_row(table)
    normalized_headers = [normalize_header(header) for header in headers]
    expected_headers = ["tanggal", "keterangan", "jumlah", "saldo akhir"]
    if len(normalized_headers) < 4 or normalized_headers[:4] != expected_headers:
        return []

    results: list[dict[str, Any]] = []
    for row in table[header_idx + 1:]:
        texts = row_to_texts(row)
        if len(texts) < 4:
            continue

        date_text = texts[0]
        tx_time = parse_datetime(date_text)
        if not tx_time:
            continue

        description = clean_text(texts[1])
        signed_amount = parse_amount(texts[2])
        balance_after = parse_amount(texts[3])
        if signed_amount is None or balance_after is None or signed_amount == 0:
            continue

        is_credit = signed_amount > 0
        amount = abs(signed_amount)
        rrn = find_rrn(description)
        transfer_code = find_transfer_code(description)
        transaction_id = find_transaction_id(description)
        balance_before = balance_after - amount if is_credit else balance_after + amount

        raw = {
            "wallet": wallet,
            "source": "report.orderkuota.com",
            "cells": texts[:4],
            "date": clean_text(date_text),
            "description": description,
            "signedAmount": signed_amount,
            "status": "IN" if is_credit else "OUT",
            "rrn": rrn or None,
            "transferCode": transfer_code or None,
            "transactionId": transaction_id or None,
            "balanceAfter": balance_after,
        }
        hash_source = (
            f"report-orderkuota:{wallet}:{description}:{raw['date']}:"
            f"{signed_amount}:{balance_after}:{rrn or ''}:{transfer_code or ''}:{transaction_id or ''}"
        )
        results.append({
            "amount": amount,
            "type": "credit" if is_credit else "debit",
            "balanceBefore": balance_before,
            "balanceAfter": balance_after,
            "issuerName": description,
            "rrn": rrn or None,
            "walletCategory": wallet,
            "transactionTime": tx_time.astimezone(UTC_PLUS_7).isoformat(),
            "rawDataJson": json.dumps(raw, ensure_ascii=False),
            "rawHash": hashlib.sha256(hash_source.encode("utf-8")).hexdigest(),
        })

    return results


def infer_balance_from_rows(rows: list[dict[str, Any]]) -> int | None:
    for row in rows:
        balance_after = row.get("balanceAfter")
        if isinstance(balance_after, int):
            return balance_after
    return None


def parse_rows(table: list[list[TableCell]], wallet: str) -> list[dict[str, Any]]:
    if not table:
        return []

    report_rows = parse_report_table_rows(table, wallet)
    if report_rows:
        return report_rows

    main_report_rows = parse_main_report_table_rows(table, wallet)
    if main_report_rows:
        return main_report_rows

    header_idx, headers = find_header_row(table)
    data_rows = table[header_idx + 1:] if header_idx >= 0 else table

    date_idx = find_index(headers, "tanggal", "waktu", "date", "time")
    desc_idx = find_index(headers, "keterangan", "deskripsi", "description", "mutasi", "note")
    sender_idx = find_index(headers, "pengirim", "sender", "nama pengirim")
    brand_idx = find_index(headers, "bank", "ewallet", "brand", "channel", "tipe")
    rrn_idx = find_index(headers, "rrn", "reference", "ref", "no referensi")
    status_idx = find_index(headers, "status")
    debit_idx = find_index(headers, "debet", "debit", "keluar")
    credit_idx = find_index(headers, "kredit", "credit", "masuk")
    amount_idx = find_index(headers, "amount", "nominal", "jumlah")
    balance_idx = find_index(headers, "saldo akhir", "saldo", "balance")

    results: list[dict[str, Any]] = []
    for row in data_rows:
        texts = row_to_texts(row)
        if not texts:
            continue

        date_text = texts[date_idx] if 0 <= date_idx < len(texts) else next((cell for cell in texts if looks_like_datetime(cell)), "")
        tx_time = parse_datetime(date_text)
        if not tx_time:
            continue

        debit_value = parse_amount(texts[debit_idx]) if 0 <= debit_idx < len(texts) else None
        credit_value = parse_amount(texts[credit_idx]) if 0 <= credit_idx < len(texts) else None
        amount_value = parse_amount(texts[amount_idx]) if 0 <= amount_idx < len(texts) else None
        balance_after = parse_amount(texts[balance_idx]) if 0 <= balance_idx < len(texts) else None
        if balance_after is None:
            numeric_cells = [parse_amount(text) for text in texts]
            numeric_cells = [value for value in numeric_cells if value is not None]
            balance_after = numeric_cells[-1] if numeric_cells else None

        status_text = texts[status_idx] if 0 <= status_idx < len(texts) else ""
        is_credit = False
        if credit_value and credit_value > 0:
            is_credit = True
        elif debit_value and debit_value > 0:
            is_credit = False
        elif amount_value is not None:
            is_credit = "out" not in status_text.lower()
        else:
            continue

        amount = credit_value if is_credit and credit_value is not None else debit_value if not is_credit and debit_value is not None else abs(amount_value or 0)
        if amount <= 0:
            continue

        sender_name = texts[sender_idx] if 0 <= sender_idx < len(texts) else ""
        brand_name = texts[brand_idx] if 0 <= brand_idx < len(texts) else ""
        description = texts[desc_idx] if 0 <= desc_idx < len(texts) else build_description([sender_name, brand_name, status_text])
        rrn = texts[rrn_idx] if 0 <= rrn_idx < len(texts) else ""
        rrn = clean_text(rrn) or find_rrn(description, sender_name, brand_name)
        issuer_name = build_description([sender_name, brand_name]) or None

        if balance_after is None:
            balance_after = amount if is_credit else 0
        balance_before = balance_after - amount if is_credit else balance_after + amount

        raw = {
            "wallet": wallet,
            "cells": texts,
            "date": clean_text(date_text),
            "description": clean_text(description),
            "senderName": clean_text(sender_name) or None,
            "brandName": clean_text(brand_name) or None,
            "status": clean_text(status_text) or ("IN" if is_credit else "OUT"),
            "rrn": rrn or None,
            "balanceAfter": balance_after,
        }
        hash_source = f"report-orderkuota:{wallet}:{raw['description']}:{raw['date']}:{amount}:{balance_after}:{rrn or ''}"
        results.append({
            "amount": amount,
            "type": "credit" if is_credit else "debit",
            "balanceBefore": balance_before,
            "balanceAfter": balance_after,
            "issuerName": issuer_name,
            "rrn": rrn or None,
            "walletCategory": wallet,
            "transactionTime": tx_time.astimezone(UTC_PLUS_7).isoformat(),
            "rawDataJson": json.dumps(raw, ensure_ascii=False),
            "rawHash": hashlib.sha256(hash_source.encode("utf-8")).hexdigest(),
        })

    return results


def fetch_paginated_rows(base_url: str, wallet: str, cookie: str, user_agent: str, max_pages: int) -> tuple[list[dict[str, Any]], int | None, dict[str, Any]]:
    html = fetch_html(base_url, cookie, user_agent)
    total_pages = min(max(extract_total_pages(html, urllib.parse.urlparse(base_url).path.strip("/")), 1), max_pages)
    best_table = extract_best_table(html)
    rows = parse_rows(best_table, wallet)
    for page in range(2, total_pages + 1):
        next_url = f"{base_url.rstrip('/')}/index/{page}"
        next_html = fetch_html(next_url, cookie, user_agent, referer=base_url)
        rows.extend(parse_rows(extract_best_table(next_html), wallet))

    deduped: dict[str, dict[str, Any]] = {}
    for row in rows:
        deduped.setdefault(row["rawHash"], row)

    sorted_rows = sorted(
        deduped.values(),
        key=lambda item: item["transactionTime"],
        reverse=True,
    )
    metadata = {
        "accountName": extract_account_name(html),
        "detectedPattern": detect_table_pattern(best_table),
        "pagesRead": total_pages,
        "pageBase": urllib.parse.urlparse(base_url).path,
    }
    return sorted_rows, infer_balance_from_rows(sorted_rows), metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape report.orderkuota.com mutasi HTML")
    parser.add_argument("--stdin", action="store_true", help="Read JSON payload from stdin")
    args = parser.parse_args()

    payload = read_json_stdin() if args.stdin else {}
    cookie = str(payload.get("cookie") or "").strip()
    if not cookie:
        raise RuntimeError("cookie web report kosong")

    user_agent = str(payload.get("userAgent") or DEFAULT_USER_AGENT).strip() or DEFAULT_USER_AGENT
    target = str(payload.get("target") or "both").strip().lower()
    max_pages = int(payload.get("maxPages") or 3)
    if max_pages < 1:
        max_pages = 1
    if max_pages > 10:
        max_pages = 10

    qris_rows: list[dict[str, Any]] = []
    utama_rows: list[dict[str, Any]] = []
    qris_balance: int | None = None
    main_balance: int | None = None
    qris_meta: dict[str, Any] = {}
    utama_meta: dict[str, Any] = {}

    if target in ("qris", "both"):
        qris_rows, qris_balance, qris_meta = fetch_paginated_rows(
            "https://report.orderkuota.com/mutasi_qris",
            "qris",
            cookie,
            user_agent,
            max_pages,
        )

    if target in ("utama", "both"):
        utama_rows, main_balance, utama_meta = fetch_paginated_rows(
            "https://report.orderkuota.com/mutasi",
            "utama",
            cookie,
            user_agent,
            max_pages,
        )

    result = {
        "ok": True,
        "target": target,
        "qris": {
            "mutations": qris_rows,
            "count": len(qris_rows),
            "balance": qris_balance,
            "meta": qris_meta,
        },
        "utama": {
            "mutations": utama_rows,
            "count": len(utama_rows),
            "balance": main_balance,
            "meta": utama_meta,
        },
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        sys.stderr.write(str(exc))
        raise
