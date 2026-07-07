"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_DELAYS_MS = exports.MAX_ATTEMPTS = void 0;
exports.attemptDeposit = attemptDeposit;
exports.getNextRetryTime = getNextRetryTime;
const crypto_1 = __importDefault(require("crypto"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const url_1 = require("url");
const database_1 = require("../config/database");
const logger_1 = require("../config/logger");
const wallet_ledger_service_1 = require("./wallet-ledger.service");
// ── Retry schedule (delays in ms after each failed attempt) ─────────────────
const RETRY_DELAYS_MS = [0, 30000, 120000, 300000]; // attempt 1, 2, 3, 4
exports.RETRY_DELAYS_MS = RETRY_DELAYS_MS;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
exports.MAX_ATTEMPTS = MAX_ATTEMPTS;
function buildIdempotencyKey(qrId) {
    return `dep:${qrId}`;
}
function buildPayload(tx) {
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
async function sendDepositRequest(depositApiUrl, payload, depositApiKey) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const parsedUrl = new url_1.URL(depositApiUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
        };
        // Sign the callback so the operator can verify it genuinely came from us.
        // Signature = HMAC-SHA256( `${timestamp}.${body}` ) using the shared
        // depositApiKey as the secret. The operator recomputes and compares.
        if (depositApiKey) {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const signature = crypto_1.default
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
        const transport = isHttps ? https_1.default : http_1.default;
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk.toString()));
            res.on('end', () => {
                const statusCode = res.statusCode ?? 0;
                resolve({ success: statusCode >= 200 && statusCode < 300, statusCode, body: data });
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => {
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
async function attemptDeposit(transactionId) {
    const tx = await database_1.db.transaction.findUnique({
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
        },
    });
    if (!tx) {
        logger_1.logger.warn({ transactionId }, 'attemptDeposit: transaction not found');
        return;
    }
    if (tx.statusPay !== 'paid') {
        logger_1.logger.warn({ transactionId, statusPay: tx.statusPay }, 'attemptDeposit: not paid yet');
        return;
    }
    const idempotencyKey = buildIdempotencyKey(tx.qrId);
    // ── Idempotency guard: skip if already succeeded ─────────────────────────
    const existing = await database_1.db.depositAttempt.findFirst({
        where: { idempotencyKey, status: 'success' },
    });
    if (existing) {
        logger_1.logger.debug({ transactionId, idempotencyKey }, 'Deposit already succeeded, skipping');
        // Ensure transaction state is consistent
        await database_1.db.transaction.update({
            where: { id: transactionId },
            data: { statusBot: 'deposit_success' },
        });
        return;
    }
    // ── Determine attempt number ──────────────────────────────────────────────
    const attemptCount = await database_1.db.depositAttempt.count({ where: { transactionId } });
    const attemptNo = attemptCount + 1;
    if (attemptNo > MAX_ATTEMPTS) {
        logger_1.logger.warn({ transactionId, attemptNo }, 'Max deposit attempts exceeded, moving to manual_review');
        await database_1.db.transaction.update({
            where: { id: transactionId },
            data: { statusBot: 'manual_review' },
        });
        return;
    }
    const payload = buildPayload(tx);
    const requestPayloadJson = JSON.stringify(payload);
    let responseCode = null;
    let responseBody = null;
    let success = false;
    let errorMessage = null;
    // ── Execute deposit ───────────────────────────────────────────────────────
    if (!tx.client.depositApiUrl) {
        // Mock auto-success when no URL configured
        success = true;
        responseCode = 200;
        responseBody = JSON.stringify({ success: true, message: 'Mock auto-success (no depositApiUrl configured)' });
        logger_1.logger.info({ transactionId, attemptNo }, 'Deposit mock auto-success');
    }
    else {
        try {
            const result = await sendDepositRequest(tx.client.depositApiUrl, payload, tx.client.depositApiKey);
            success = result.success;
            responseCode = result.statusCode;
            responseBody = result.body.slice(0, 2000); // truncate for storage
            if (!success) {
                errorMessage = `HTTP ${result.statusCode}: ${result.body.slice(0, 200)}`;
            }
        }
        catch (err) {
            success = false;
            errorMessage = err instanceof Error ? err.message : String(err);
            logger_1.logger.warn({ transactionId, attemptNo, error: errorMessage }, 'Deposit request failed');
        }
    }
    // ── Compute next retry time ───────────────────────────────────────────────
    const nextRetryDelayMs = RETRY_DELAYS_MS[attemptNo]; // undefined if at max
    const nextRetryAt = !success && nextRetryDelayMs !== undefined
        ? new Date(Date.now() + nextRetryDelayMs)
        : null;
    // ── Persist attempt record ────────────────────────────────────────────────
    await database_1.db.depositAttempt.create({
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
        await database_1.db.transaction.update({
            where: { id: transactionId },
            data: { statusBot: 'deposit_success' },
        });
        // Credit the utama wallet with the net amount
        const netAmount = tx.finalAmount - tx.feeAmount;
        try {
            await (0, wallet_ledger_service_1.recordWalletEntry)({
                walletCode: 'utama',
                amount: netAmount,
                refType: 'deposit_success',
                refId: transactionId,
                description: `Deposit dari ${tx.client.name} — QR ${tx.qrId.slice(0, 8)}`,
            });
        }
        catch (walletErr) {
            logger_1.logger.error({ walletErr, transactionId }, 'Failed to record wallet ledger entry');
        }
        logger_1.logger.info({ transactionId, attemptNo, idempotencyKey }, 'Deposit succeeded');
    }
    else if (attemptNo >= MAX_ATTEMPTS) {
        await database_1.db.transaction.update({
            where: { id: transactionId },
            data: { statusBot: 'manual_review' },
        });
        logger_1.logger.warn({ transactionId, attemptNo }, 'Deposit failed after max attempts → manual_review');
    }
    else {
        // Leave as deposit_queued; nextRetryAt is set in the DepositAttempt record
        // The deposit-retry loop will pick it up based on nextRetryAt
        logger_1.logger.warn({ transactionId, attemptNo, nextRetryAt }, 'Deposit failed, scheduled for retry');
    }
}
/**
 * Returns the nextRetryAt time for a transaction's most recent failed deposit attempt.
 * Returns null if there is no pending retry.
 */
async function getNextRetryTime(transactionId) {
    const latest = await database_1.db.depositAttempt.findFirst({
        where: { transactionId, status: 'failed' },
        orderBy: { createdAt: 'desc' },
        select: { nextRetryAt: true },
    });
    return latest?.nextRetryAt ?? null;
}
//# sourceMappingURL=deposit.service.js.map