"use strict";
/**
 * Deposit Retry Loop — runs every 20 seconds
 *
 * Finds paid transactions in deposit_queued state whose most recent failed
 * attempt has a nextRetryAt in the past, and retries the deposit.
 *
 * Retry schedule (from deposit.service.ts):
 *   attempt 1 → immediate (handled by mutation-poll loop)
 *   attempt 2 → 30s after attempt 1 failure
 *   attempt 3 → 120s after attempt 2 failure
 *   attempt 4 → 300s after attempt 3 failure
 *   → manual_review after 4 failures
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDepositRetryLoop = startDepositRetryLoop;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const deposit_service_1 = require("../../shared/deposit.service");
const INTERVAL_MS = 20000;
let running = false;
async function tick() {
    const now = new Date();
    // Find transactions that need a retry:
    // statusBot=deposit_queued AND most recent failed attempt's nextRetryAt <= now
    // We use a sub-query approach: find transactions with a failed DepositAttempt
    // whose nextRetryAt has passed.
    const candidateAttempts = await database_1.db.depositAttempt.findMany({
        where: {
            status: 'failed',
            nextRetryAt: { lte: now },
            transaction: {
                statusPay: 'paid',
                statusBot: 'deposit_queued',
            },
        },
        select: { transactionId: true },
        distinct: ['transactionId'],
    });
    if (candidateAttempts.length === 0)
        return;
    logger_1.logger.info({ count: candidateAttempts.length }, 'Deposit retry loop: processing candidates');
    for (const { transactionId } of candidateAttempts) {
        try {
            await (0, deposit_service_1.attemptDeposit)(transactionId);
        }
        catch (err) {
            logger_1.logger.error({ err, transactionId }, 'Deposit retry attempt error');
        }
    }
}
function startDepositRetryLoop() {
    logger_1.logger.info({ intervalMs: INTERVAL_MS }, 'Deposit retry loop started');
    setInterval(() => {
        if (running)
            return;
        running = true;
        tick()
            .catch((err) => logger_1.logger.error({ err }, 'Deposit retry loop error'))
            .finally(() => {
            running = false;
        });
    }, INTERVAL_MS);
}
//# sourceMappingURL=deposit-retry.loop.js.map