/**
 * Mutation Poll Loop — runs every 1500ms
 *
 * Reads unmatched credit mutations from the database and attempts to match
 * each one to an open transaction. On a successful match the transaction
 * is marked paid and queued for deposit.
 *
 * This DB-driven approach is the correct mock equivalent of polling a live
 * banking gateway: simulate-payment.ts injects the mutation row, and this
 * loop picks it up within 1.5 seconds.
 */

import { logger } from '../../config/logger';
import { fetchUnmatchedMutations, tryMatchMutation } from '../../shared/mutation-matcher.service';
import { attemptDeposit } from '../../shared/deposit.service';

const INTERVAL_MS = 1_500;

let running = false;

async function tick(): Promise<void> {
  const mutations = await fetchUnmatchedMutations(20);
  if (mutations.length === 0) return;

  logger.debug({ count: mutations.length }, 'Mutation poll: processing unmatched mutations');

  for (const mutation of mutations) {
    const result = await tryMatchMutation(mutation);

    if (result.matched) {
      // Immediately attempt the first deposit after matching
      try {
        await attemptDeposit(result.transactionId);
      } catch (depositErr) {
        logger.error(
          { depositErr, transactionId: result.transactionId },
          'Immediate deposit attempt failed after match',
        );
      }
    }
  }
}

export function startMutationPollLoop(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Mutation poll loop started');

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => logger.error({ err }, 'Mutation poll loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
