const { db } = require('../dist/config/database.js');
const { logger } = require('../dist/config/logger.js');
const { fetchUnmatchedMutations, tryMatchMutation } = require('../dist/shared/mutation-matcher.service.js');
const { attemptDeposit } = require('../dist/shared/deposit.service.js');

const INTERVAL_MS = 1500;
let running = false;

async function tick() {
  const mutations = await fetchUnmatchedMutations(20);
  if (mutations.length === 0) return;

  logger.info({ count: mutations.length }, 'Live reconcile loop: processing unmatched QRIS mutations');

  for (const mutation of mutations) {
    const result = await tryMatchMutation(mutation);
    if (!result.matched) continue;

    try {
      await attemptDeposit(result.transactionId);
    } catch (error) {
      logger.error(
        { error, transactionId: result.transactionId },
        'Live reconcile loop: immediate deposit attempt failed after match',
      );
    }
  }
}

async function start() {
  logger.info({ intervalMs: INTERVAL_MS }, 'Live mutation reconcile loop started');

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((error) => logger.error({ error }, 'Live mutation reconcile loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}

start().catch((error) => {
  logger.error({ error }, 'Live mutation reconcile bootstrap failed');
  process.exit(1);
});
