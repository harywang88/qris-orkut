import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { recordWalletEntry } from './wallet-ledger.service';

// ── Retry schedule (delays in ms after each failed attempt) ─────────────────
const RETRY_DELAYS_MS = [0, 30_000, 120_000, 300_000]; // attempt 1, 2, 3, 4
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

export interface DepositPayload {
  qrId: string;
  transactionId: string;
  userId: string;
  requestedAmount: number;
  finalAmount: number;
  paidAmount: number;
  note: string;
  issuerName: string | null;
  rrn: string | null;
  paidAt: string; // ISO 8601
  externalReference: string | null;
}

function buildIdempotencyKey(qrId: string): string {
  return `dep:${qrId}`;
}

// Stempel waktu WIB (UTC+7) format YYYYMMDDHHMMSS, mis. 20260708083821.
function wibStamp(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    t.getUTCFullYear().toString() +
    p(t.getUTCMonth() + 1) + p(t.getUTCDate()) +
    p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds())
  );
}

// Note auto-deposit seragam untuk Transaction (History Generate QR kolom Note/Issuer)
// SEKALIGUS dikirim ke panel game: "QRIS Auto-<Merchant>-<user>-<YYYYMMDDHHMMSS> | <nominal>".
function buildAutoDepositNote(tx: {
  userIdExt: string;
  finalAmount: number;
  paidAt: Date | null;
  qrisAccount?: { merchantName: string | null; code: string | null } | null;
}): string {
  const merchant = (tx.qrisAccount?.merchantName || tx.qrisAccount?.code || 'QRIS').trim();
  const user = (tx.userIdExt || '-').trim();
  const stamp = wibStamp(tx.paidAt ?? new Date());
  return `QRIS Auto-${merchant}-${user}-${stamp} | ${tx.finalAmount}`;
}

function buildPayload(tx: {
  qrId: string;
  id: string;
  userIdExt: string;
  requestedAmount: number;
  finalAmount: number;
  note: string;
  issuerName: string | null;
  rrn: string | null;
  paidAt: Date | null;
  externalReference: string | null;
}): DepositPayload {
  return {
    qrId: tx.qrId,
    transactionId: tx.id,
    userId: tx.userIdExt,
    requestedAmount: tx.requestedAmount,
    finalAmount: tx.finalAmount,
    paidAmount: tx.finalAmount,
    note: tx.note,
    issuerName: tx.issuerName,
    rrn: tx.rrn,
    paidAt: tx.paidAt?.toISOString() ?? new Date().toISOString(),
    externalReference: tx.externalReference,
  };
}

/**
 * Sends an HTTP POST to the client's depositApiUrl.
 * Returns { success, statusCode, body }.
 * Throws only on network-level errors; HTTP 4xx/5xx → returns success=false.
 */
async function sendDepositRequest(
  depositApiUrl: string,
  payload: DepositPayload,
  depositApiKey: string | null,
): Promise<{ success: boolean; statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const parsedUrl = new URL(depositApiUrl);
    const isHttps = parsedUrl.protocol === 'https:';

    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };

    // Sign the callback so the operator can verify it genuinely came from us.
    // Signature = HMAC-SHA256( `${timestamp}.${body}` ) using the shared
    // depositApiKey as the secret. The operator recomputes and compares.
    if (depositApiKey) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = crypto
        .createHmac('sha256', depositApiKey)
        .update(`${timestamp}.${bodyStr}`)
        .digest('hex');
      headers['X-Deposit-Timestamp'] = timestamp;
      headers['X-Deposit-Signature'] = signature;
    }

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        resolve({ success: statusCode >= 200 && statusCode < 300, statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Deposit request timed out after 10s'));
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Executes a single deposit attempt for a transaction.
 *
 * Idempotency: if a successful attempt with the same idempotencyKey already
 * exists, the function returns immediately without making another HTTP call.
 *
 * Mock behavior: if client.depositApiUrl is empty/null, the deposit auto-succeeds.
 */
export async function attemptDeposit(transactionId: string): Promise<void> {
  const tx = await db.transaction.findUnique({
    where: { id: transactionId },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          depositApiUrl: true,
          depositApiKey: true,
        },
      },
      qrisAccount: { select: { merchantName: true, code: true } },
    },
  });

  if (!tx) {
    logger.warn({ transactionId }, 'attemptDeposit: transaction not found');
    return;
  }

  if (tx.statusPay !== 'paid') {
    logger.warn({ transactionId, statusPay: tx.statusPay }, 'attemptDeposit: not paid yet');
    return;
  }

  // Note seragam: tulis ke Transaction.note (→ History Generate QR) & ikut ke payload
  // (buildPayload memakai tx.note) → panel game menerima note yang sama.
  const autoNote = buildAutoDepositNote(tx);
  if (tx.note !== autoNote) {
    tx.note = autoNote;
    await db.transaction.update({ where: { id: transactionId }, data: { note: autoNote } });
  }

  const idempotencyKey = buildIdempotencyKey(tx.qrId);

  // ── Idempotency guard: skip if already succeeded ─────────────────────────
  const existing = await db.depositAttempt.findFirst({
    where: { idempotencyKey, status: 'success' },
  });
  if (existing) {
    logger.debug({ transactionId, idempotencyKey }, 'Deposit already succeeded, skipping');
    // Ensure transaction state is consistent
    await db.transaction.update({
      where: { id: transactionId },
      data: { statusBot: 'deposit_success' },
    });
    return;
  }

  // ── Determine attempt number ──────────────────────────────────────────────
  const attemptCount = await db.depositAttempt.count({ where: { transactionId } });
  const attemptNo = attemptCount + 1;

  if (attemptNo > MAX_ATTEMPTS) {
    logger.warn({ transactionId, attemptNo }, 'Max deposit attempts exceeded, moving to manual_review');
    await db.transaction.update({
      where: { id: transactionId },
      data: { statusBot: 'manual_review' },
    });
    return;
  }

  const payload = buildPayload(tx);
  const requestPayloadJson = JSON.stringify(payload);

  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let success = false;
  let errorMessage: string | null = null;

  // ── Execute deposit ───────────────────────────────────────────────────────
  if (!tx.client.depositApiUrl) {
    // Mock auto-success when no URL configured
    success = true;
    responseCode = 200;
    responseBody = JSON.stringify({ success: true, message: 'Mock auto-success (no depositApiUrl configured)' });
    logger.info({ transactionId, attemptNo }, 'Deposit mock auto-success');
  } else {
    try {
      const result = await sendDepositRequest(tx.client.depositApiUrl, payload, tx.client.depositApiKey);
      success = result.success;
      responseCode = result.statusCode;
      responseBody = result.body.slice(0, 2000); // truncate for storage
      if (!success) {
        errorMessage = `HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`;
      }
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn({ transactionId, attemptNo, error: errorMessage }, 'Deposit request failed');
    }
  }

  // ── Compute next retry time ───────────────────────────────────────────────
  const nextRetryDelayMs = RETRY_DELAYS_MS[attemptNo]; // undefined if at max
  const nextRetryAt = !success && nextRetryDelayMs !== undefined
    ? new Date(Date.now() + nextRetryDelayMs)
    : null;

  // ── Persist attempt record ────────────────────────────────────────────────
  await db.depositAttempt.create({
    data: {
      transactionId,
      attemptNo,
      idempotencyKey,
      requestPayloadJson,
      responseCode,
      responseBody,
      status: success ? 'success' : 'failed',
      errorMessage,
      nextRetryAt,
    },
  });

  // ── Update transaction state ──────────────────────────────────────────────
  if (success) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { statusBot: 'deposit_success' },
    });

    // Credit the utama wallet with the net amount
    const netAmount = tx.finalAmount - tx.feeAmount;
    try {
      await recordWalletEntry({
        walletCode: 'utama',
        amount: netAmount,
        refType: 'deposit_success',
        refId: transactionId,
        description: `Deposit dari ${tx.client.name} — QR ${tx.qrId.slice(0, 8)}`,
      });
    } catch (walletErr) {
      logger.error({ walletErr, transactionId }, 'Failed to record wallet ledger entry');
    }

    logger.info({ transactionId, attemptNo, idempotencyKey }, 'Deposit succeeded');
  } else if (attemptNo >= MAX_ATTEMPTS) {
    await db.transaction.update({
      where: { id: transactionId },
      data: { statusBot: 'manual_review' },
    });
    logger.warn({ transactionId, attemptNo }, 'Deposit failed after max attempts → manual_review');
  } else {
    // Leave as deposit_queued; nextRetryAt is set in the DepositAttempt record
    // The deposit-retry loop will pick it up based on nextRetryAt
    logger.warn({ transactionId, attemptNo, nextRetryAt }, 'Deposit failed, scheduled for retry');
  }
}

/**
 * Returns the nextRetryAt time for a transaction's most recent failed deposit attempt.
 * Returns null if there is no pending retry.
 */
export async function getNextRetryTime(transactionId: string): Promise<Date | null> {
  const latest = await db.depositAttempt.findFirst({
    where: { transactionId, status: 'failed' },
    orderBy: { createdAt: 'desc' },
    select: { nextRetryAt: true },
  });
  return latest?.nextRetryAt ?? null;
}

export { MAX_ATTEMPTS, RETRY_DELAYS_MS };
