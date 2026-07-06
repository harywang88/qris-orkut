import type { QrisAccount } from '@prisma/client';
import { config } from '../config';
import { logger } from '../config/logger';
import { decrypt } from '../core/encryption';

type WebReportStatus = 'IN' | 'OUT';

export interface WebReportPayment {
  amount: number;
  balanceAfter: number | null;
  brand: string | null;
  raw: Record<string, unknown>;
  rrn: string | null;
  senderName: string | null;
  statusCode: WebReportStatus;
  timestamp: string | null;
  transactionTime: Date | null;
}

export interface PresentedQrisMutation {
  accountCode: string;
  amount: number;
  balanceAfter: number;
  bankEwallet: string;
  brandName: string | null;
  category: string;
  createdAt: Date;
  description: string;
  displayTime: string;
  id: string;
  issuerName: string | null;
  matched: boolean;
  merchant: string;
  rawDataJson: string;
  rrn: string | null;
  senderName: string;
  source: string;
  statusCode: string;
  statusKind: string;
  statusLabel: string;
  statusText: string;
  time: Date;
  type: string;
  siteName?: string | null;
  userIdExt?: string | null;
}

function parseAmountValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d-]/g, '').trim();
    if (!cleaned) return null;
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTimestamp(value: unknown): Date | null {
  const raw = readString(value);
  if (!raw) return null;

  const dmy = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (dmy) {
    const [, dd, mm, yyyy, HH, MM, SS = '00'] = dmy;
    return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+07:00`);
  }

  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (ymd) {
    const [, yyyy, mm, dd, HH, MM, SS = '00'] = ymd;
    return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+07:00`);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimestamp(value: Date): string {
  return value.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }) + ' ' + value.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });
}

function hasSeconds(value: string | null | undefined): boolean {
  return typeof value === 'string' && /\d{2}:\d{2}:\d{2}$/.test(value.trim());
}

function normalizeStatus(value: unknown): WebReportStatus {
  return readString(value).toUpperCase() === 'OUT' ? 'OUT' : 'IN';
}

function buildDefaultWebReportUrlTemplate(): string | null {
  if (!config.ORKUT_BALANCE_BASE_URL) return null;
  const trimmed = config.ORKUT_BALANCE_BASE_URL.replace(/\/+$/, '');
  return `${trimmed}/mutasi-qr?action=fetch_web&account={account}&cache=0&_={ts}`;
}

function getWebReportUrlTemplate(): string | null {
  return config.ORKUT_QRIS_WEB_REPORT_URL_TEMPLATE || buildDefaultWebReportUrlTemplate();
}

function buildWebReportUrl(accountIndex: number): string | null {
  const template = getWebReportUrlTemplate();
  if (!template) return null;
  const resolved = template
    .replace(/\{account\}/g, String(accountIndex))
    .replace(/\{ts\}/g, String(Date.now()));
  try {
    return new URL(resolved).toString();
  } catch {
    logger.warn({ accountIndex, resolved }, 'web-report: invalid URL template result');
    return null;
  }
}

function parseWebReportPayload(payload: unknown): WebReportPayment[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const paymentsValue = Array.isArray(record.payments)
    ? record.payments
    : Array.isArray(payload)
      ? payload
      : [];

  return paymentsValue
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const raw = item as Record<string, unknown>;
      const amount = parseAmountValue(raw.amount);
      if (!amount || amount <= 0) return null;

      const transactionTime =
        parseTimestamp(raw.timestamp) ??
        parseTimestamp(raw.paid_at) ??
        parseTimestamp(raw.tanggal) ??
        null;

      return {
        amount,
        balanceAfter: parseAmountValue(raw.balance_after),
        brand: readString(raw.brand) || null,
        raw,
        rrn:
          readString(raw.rrn) ||
          readString(raw.ref) ||
          readString(raw.reference) ||
          readString(raw.reference_no) ||
          readString(raw.no_referensi) ||
          null,
        senderName:
          readString(raw.sender_name) ||
          readString(raw.description) ||
          readString(raw.keterangan) ||
          null,
        statusCode: normalizeStatus(raw.status),
        timestamp:
          readString(raw.timestamp) ||
          readString(raw.paid_at) ||
          (transactionTime ? formatTimestamp(transactionTime) : null),
        transactionTime,
      } satisfies WebReportPayment;
    })
    .filter((item): item is WebReportPayment => item !== null);
}

function buildHeaders(
  account: Pick<QrisAccount, 'code' | 'cookiesEncrypted'>,
  url: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json,text/javascript,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
    Referer: url,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  };

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const shouldSendOrderkuotaCookies =
    host === 'orderkuota.com' ||
    host.endsWith('.orderkuota.com');

  if (shouldSendOrderkuotaCookies && account.cookiesEncrypted) {
    try {
      headers.Cookie = decrypt(account.cookiesEncrypted);
    } catch (err) {
      logger.warn({ accountCode: account.code, err }, 'web-report: failed to decrypt cookies');
    }
  }

  return headers;
}

function parseRawMutationId(rawDataJson: string): string {
  try {
    const parsed = JSON.parse(rawDataJson) as Record<string, unknown>;
    const id = parsed.id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  } catch {
    // ignore malformed JSON
  }
  return '';
}

function parsePresentedTime(row: PresentedQrisMutation): Date | null {
  const fromDisplay = parseTimestamp(row.displayTime);
  if (fromDisplay) return fromDisplay;
  const fromTime = new Date(row.time);
  return Number.isNaN(fromTime.getTime()) ? null : fromTime;
}

function scoreWebReportMatch(row: PresentedQrisMutation, payment: WebReportPayment): number {
  if (payment.amount !== row.amount) return -1;
  if (payment.statusCode !== row.statusCode.toUpperCase()) return -1;

  let score = 0;

  if (payment.balanceAfter !== null && payment.balanceAfter === row.balanceAfter) score += 3;

  const rowTime = parsePresentedTime(row);
  if (rowTime && payment.transactionTime) {
    const diffSeconds = Math.abs(payment.transactionTime.getTime() - rowTime.getTime()) / 1000;
    if (diffSeconds === 0) score += 6;
    else if (diffSeconds <= 5) score += 5;
    else if (diffSeconds <= 60) score += 3;
    else if (diffSeconds <= 120) score += 1;
    else return -1;
  }

  if (payment.senderName && row.senderName && payment.senderName.toLowerCase() === row.senderName.toLowerCase()) {
    score += 2;
  }

  if (payment.brand && row.bankEwallet.toLowerCase().includes(payment.brand.toLowerCase())) {
    score += 1;
  }

  return score;
}

function pickPreferredMutation(
  current: PresentedQrisMutation,
  candidate: PresentedQrisMutation,
): PresentedQrisMutation {
  const currentScore =
    (current.rrn ? 4 : 0) +
    (hasSeconds(current.displayTime) ? 2 : 0) +
    (current.matched ? 1 : 0) +
    (current.senderName && current.senderName !== 'Tidak terbaca' ? 1 : 0);
  const candidateScore =
    (candidate.rrn ? 4 : 0) +
    (hasSeconds(candidate.displayTime) ? 2 : 0) +
    (candidate.matched ? 1 : 0) +
    (candidate.senderName && candidate.senderName !== 'Tidak terbaca' ? 1 : 0);

  return candidateScore > currentScore ? candidate : current;
}

function buildDedupKey(row: PresentedQrisMutation): string {
  const rawId = parseRawMutationId(row.rawDataJson);
  if (rawId) return `${row.accountCode}|${rawId}`;
  if (row.rrn) return `${row.accountCode}|rrn|${row.rrn}|${row.amount}`;
  return [
    row.accountCode,
    row.statusCode,
    row.amount,
    row.balanceAfter,
    row.displayTime,
    row.category,
  ].join('|');
}

export function dedupePresentedQrisMutations(rows: PresentedQrisMutation[]): PresentedQrisMutation[] {
  const seen = new Map<string, PresentedQrisMutation>();

  for (const row of rows) {
    const key = buildDedupKey(row);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, row);
      continue;
    }
    seen.set(key, pickPreferredMutation(existing, row));
  }

  return [...seen.values()].sort((a, b) => b.time.getTime() - a.time.getTime());
}

export function enrichPresentedQrisMutationsWithWebReport(
  rows: PresentedQrisMutation[],
  payments: WebReportPayment[],
): PresentedQrisMutation[] {
  if (!rows.length || !payments.length) return rows;

  const used = new Set<number>();

  return rows.map((row) => {
    let bestIndex = -1;
    let bestScore = -1;

    payments.forEach((payment, index) => {
      if (used.has(index)) return;
      const score = scoreWebReportMatch(row, payment);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex === -1 || bestScore < 3) return row;

    used.add(bestIndex);
    const match = payments[bestIndex];
    return {
      ...row,
      bankEwallet: match.brand && !row.bankEwallet.toLowerCase().includes(match.brand.toLowerCase())
        ? `${match.brand} / ${row.bankEwallet}`
        : row.bankEwallet,
      brandName: match.brand || row.brandName,
      displayTime:
        match.timestamp && (!hasSeconds(row.displayTime) || hasSeconds(match.timestamp))
          ? match.timestamp
          : row.displayTime,
      rrn: match.rrn || row.rrn,
      senderName: match.senderName || row.senderName,
    };
  });
}

export async function fetchOrkutWebReportPayments(
  account: Pick<QrisAccount, 'code' | 'cookiesEncrypted'>,
  accountIndex: number,
): Promise<WebReportPayment[]> {
  const url = buildWebReportUrl(accountIndex);
  if (!url) return [];

  try {
    const response = await fetch(url, {
      headers: buildHeaders(account, url),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      logger.debug(
        { accountCode: account.code, accountIndex, status: response.status, url },
        'web-report: request returned non-200 status',
      );
      return [];
    }

    const payload = await response.json() as unknown;
    const payments = parseWebReportPayload(payload);
    logger.debug(
      { accountCode: account.code, accountIndex, total: payments.length },
      'web-report: fetched QRIS payments',
    );
    return payments;
  } catch (err) {
    logger.debug({ accountCode: account.code, accountIndex, err }, 'web-report: request failed');
    return [];
  }
}
