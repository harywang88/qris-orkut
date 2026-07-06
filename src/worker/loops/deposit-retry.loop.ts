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

import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { attemptDeposit } from '../../shared/deposit.service';

const INTERVAL_MS = 20_000;

let running = false;

async function tick(): Promise<void> {
  const now = new Date();

  // Find transactions that need a retry:
  // statusBot=deposit_queued AND most recent failed attempt's nextRetryAt <= now
  // We use a sub-query approach: find transactions with a failed DepositAttempt
  // whose nextRetryAt has passed.
  const candidateAttempts = await db.depositAttempt.findMany({
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

  if (candidateAttempts.length === 0) return;

  logger.info({ count: candidateAttempts.length }, 'Deposit retry loop: processing candidates');

  for (const { transactionId } of candidateAttempts) {
    try {
      await attemptDeposit(transactionId);
    } catch (err) {
      logger.error({ err, transactionId }, 'Deposit retry attempt error');
    }
  }
}

export function startDepositRetryLoop(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Deposit retry loop started');

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => logger.error({ err }, 'Deposit retry loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
