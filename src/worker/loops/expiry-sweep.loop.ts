/**
 * Expiry Sweep Loop — runs every 30 seconds
 *
 * Expires open QR transactions that have passed their expiresAt deadline,
 * releases their amount locks, and purges stale HMAC nonces.
 */

import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { purgeExpiredNonces } from '../../core/hmac';

const INTERVAL_MS = 30_000;

let running = false;

async function tick(): Promise<void> {
  const now = new Date();

  // 1. Expire open transactions past their deadline
  const expiredTx = await db.transaction.updateMany({
    where: {
      statusPay: 'open',
      expiresAt: { lt: now },
    },
    data: { statusPay: 'expired' },
  });

  if (expiredTx.count > 0) {
    logger.info({ count: expiredTx.count }, 'Expiry sweep: transactions expired');
  }

  // 2. Release amount locks for expired transactions
  const releasedLocks = await db.amountLock.updateMany({
    where: {
      status: 'active',
      expiresAt: { lt: now },
    },
    data: {
      status: 'expired',
      activeKey: null,
    },
  });

  if (releasedLocks.count > 0) {
    logger.debug({ count: releasedLocks.count }, 'Expiry sweep: amount locks released');
  }

  // 3. Purge expired HMAC nonces
  const purgeCnt = await purgeExpiredNonces();
  if (purgeCnt > 0) {
    logger.debug({ count: purgeCnt }, 'Expiry sweep: nonces purged');
  }
}

export function startExpirySweepLoop(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Expiry sweep loop started');

  // Run once immediately on startup, then on interval
  tick().catch((err) => logger.error({ err }, 'Expiry sweep initial tick error'));

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => logger.error({ err }, 'Expiry sweep loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
