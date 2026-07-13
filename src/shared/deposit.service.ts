import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { URL } from 'url';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { recordWalletEntry } from './wallet-ledger.service';

// ── Retry schedule (delays in ms after each failed attempt) ─────────────────
// Jadwal retry: 4 percobaan dalam ~70 detik (0s, 20s, 40s, 70s). Sesudah itu bot
// menyerah -> manual_review. Selaras dengan DEPOSIT_TIMEOUT_MS di bawah.
const RETRY_DELAYS_MS = [0, 20_000, 40_000, 70_000]; // attempt 1, 2, 3, 4
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
// Batas 'PROSES': lewat ini transaksi paid yang belum berhasil dipaksa ke
// manual_review (bot BERHENTI, TIDAK mengirim) -> giliran operator.
export const DEPOSIT_TIMEOUT_MS = 90_000; // 1 menit 30 detik

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
      const timeoutErr = new Error('Deposit request timed out after 10s');
      // Tandai khusus: timeout TIDAK boleh diretry otomatis. Panel mungkin sudah
      // menerima & mengkredit member (respons cuma lambat balik) → retry = dobel-kredit.
      (timeoutErr as Error & { isTimeout?: boolean }).isTimeout = true;
      req.destroy(timeoutErr);
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
export async function attemptDeposit(
  transactionId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const force = opts.force === true;
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

  // Timeout 90 detik: bot menyerah -> manual_review (TIDAK kirim ke panel).
  // Lindungi dari dobel-kredit pada transaksi lama/nyangkut (mis. orphan 0-attempt)
  // yang mungkin sudah ditangani operator. Sesudah ini giliran operator (force=true).
  if (!force && tx.statusBot === 'deposit_queued' && tx.paidAt &&
      Date.now() - tx.paidAt.getTime() > DEPOSIT_TIMEOUT_MS) {
    await db.transaction.updateMany({
      where: { id: transactionId, statusBot: 'deposit_queued' },
      data: { statusBot: 'manual_review' },
    });
    logger.warn({ transactionId }, 'Deposit timeout 90s -> manual_review (tidak dikirim)');
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

  if (!force && attemptNo > MAX_ATTEMPTS) {
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
  // Timeout = panel bisa jadi SUDAH mengkredit (respons lambat). Jangan retry
  // otomatis → escalate ke manual_review agar operator verifikasi dulu (anti dobel).
  let timedOut = false;

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
      timedOut = (err as Error & { isTimeout?: boolean })?.isTimeout === true;
      errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn({ transactionId, attemptNo, error: errorMessage, timedOut }, 'Deposit request failed');
    }
  }

  // ── Compute next retry time ───────────────────────────────────────────────
  // Timeout TIDAK dijadwalkan retry: panel mungkin sudah kredit → biar operator
  // yang verifikasi (manual_review). Hanya kegagalan non-timeout yang diretry.
  const nextRetryDelayMs = RETRY_DELAYS_MS[attemptNo]; // undefined if at max
  const nextRetryAt = !success && !timedOut && nextRetryDelayMs !== undefined
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
  } else if (timedOut) {
    // Timeout: STOP. Jangan kirim ulang (panel bisa jadi sudah kredit). Operator
    // verifikasi manual apakah member sudah menerima; kalau belum, kredit manual.
    await db.transaction.update({
      where: { id: transactionId },
      data: { statusBot: 'manual_review' },
    });
    logger.warn(
      { transactionId, attemptNo },
      'Deposit TIMEOUT → manual_review (TIDAK diretry: hindari dobel-kredit)',
    );
  } else if (force || attemptNo >= MAX_ATTEMPTS) {
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

/**
 * Kredit Manual (operator): tandai transaksi BERHASIL TANPA mengirim ke panel.
 * Dipakai saat operator sudah mengkreditkan member sendiri di panel game.
 * Idempoten & anti-dobel: dalam 1 transaksi DB -> flip ke deposit_success (hanya
 * jika belum success) + tulis DepositAttempt success (kunci idempotency) sehingga
 * bot mana pun setelahnya otomatis berhenti (early-return di attemptDeposit).
 */
export async function manualCreditDeposit(qrId: string, actorLabel: string): Promise<void> {
  const tx = await db.transaction.findUnique({ where: { qrId } });
  if (!tx) throw new Error('Transaksi tidak ditemukan');
  if (tx.statusPay !== 'paid') throw new Error('Hanya transaksi PAID yang bisa dikredit manual');
  if (tx.statusBot === 'deposit_success') throw new Error('Transaksi ini sudah BERHASIL (tidak diproses ulang)');

  const idempotencyKey = buildIdempotencyKey(tx.qrId);
  await db.$transaction(async (trx) => {
    // Gerbang idempoten: hanya SATU pihak yang boleh menandai berhasil.
    const flip = await trx.transaction.updateMany({
      where: { id: tx.id, statusBot: { not: 'deposit_success' } },
      data: { statusBot: 'deposit_success' },
    });
    if (flip.count !== 1) throw new Error('Transaksi sudah diproses pihak lain, dibatalkan');
    const attemptCount = await trx.depositAttempt.count({ where: { transactionId: tx.id } });
    await trx.depositAttempt.create({
      data: {
        transactionId: tx.id,
        attemptNo: attemptCount + 1,
        idempotencyKey,
        requestPayloadJson: JSON.stringify({ manual: true, by: actorLabel }),
        responseCode: 200,
        responseBody: `MANUAL CREDIT oleh ${actorLabel}`,
        status: 'success',
        errorMessage: null,
        nextRetryAt: null,
      },
    });
  });

  // Catat wallet 'utama' agar akuntansi setara deposit bot.
  const netAmount = tx.finalAmount - tx.feeAmount;
  try {
    await recordWalletEntry({
      walletCode: 'utama',
      amount: netAmount,
      refType: 'deposit_success',
      refId: tx.id,
      description: `Kredit MANUAL (${actorLabel}) — QR ${tx.qrId.slice(0, 8)}`,
    });
  } catch (walletErr) {
    logger.error({ walletErr, transactionId: tx.id }, 'manualCreditDeposit: gagal catat wallet ledger');
  }
  logger.info({ qrId, actorLabel }, 'Manual credit applied (deposit_success)');
}

export { MAX_ATTEMPTS, RETRY_DELAYS_MS };
