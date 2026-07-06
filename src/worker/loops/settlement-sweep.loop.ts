/**
 * Settlement Sweep Loop — runs every 60 seconds
 *
 * Finds pending settlement requests and processes them via processSettlement().
 * Processing is synchronous per request to avoid partial ledger state.
 */

import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { processSettlement } from '../../shared/settlement.service';

const INTERVAL_MS = 60_000;

let running = false;

async function tick(): Promise<void> {
  const pending = await db.settlementRequest.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take: 10,
  });

  if (pending.length === 0) return;

  logger.info({ count: pending.length }, 'Settlement sweep: processing pending requests');

  for (const { id } of pending) {
    try {
      await processSettlement(id);
    } catch (err) {
      logger.error({ err, settlementId: id }, 'Settlement sweep: processing error');
    }
  }
}

export function startSettlementSweepLoop(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Settlement sweep loop started');

  // Run once immediately on startup to process any pending settlements
  tick().catch((err) => logger.error({ err }, 'Settlement sweep initial tick error'));

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => logger.error({ err }, 'Settlement sweep loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
