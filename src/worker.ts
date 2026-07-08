/**
 * QRIS Worker Process
 *
 * Runs background loops alongside the main Express server:
 *
 *   mutation-poll   — every 1500ms  — match unmatched DB mutations to open transactions
 *   expiry-sweep    — every 30s     — expire open QRs, release locks, purge nonces
 *   deposit-retry   — every 20s     — retry failed deposits
 *   settlement-sweep — every 60s   — process pending settlement requests
 *
 * Start: npm run dev:worker  (development)
 *        npm run start:worker (production)
 */

import { initDatabase, db } from './config/database';
import { logger } from './config/logger';
import { startMutationPollLoop } from './worker/loops/mutation-poll.loop';
import { startExpirySweepLoop } from './worker/loops/expiry-sweep.loop';
import { startDepositRetryLoop } from './worker/loops/deposit-retry.loop';
import { startSettlementSweepLoop } from './worker/loops/settlement-sweep.loop';
import { startOrkutFetchLoop } from './worker/loops/orkut-fetch.loop';
import { startLogPurgeLoop } from './worker/loops/log-purge.loop';
import { startRuntimeHeartbeat } from './shared/runtime-heartbeat';

async function startWorker(): Promise<void> {
  logger.info('⚙️  QRIS Worker starting...');

  await initDatabase();
  const stopHeartbeat = startRuntimeHeartbeat('qris-worker', 5000, () => ({
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  // Start all background loops
  startMutationPollLoop();
  startExpirySweepLoop();
  startDepositRetryLoop();
  startSettlementSweepLoop();
  startOrkutFetchLoop();
  startLogPurgeLoop();

  logger.info('⚙️  QRIS Worker running — all loops active. Press Ctrl+C to stop.');

  // Keep process alive
  process.stdin.resume();

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutdown signal received');
    stopHeartbeat();
    await db.$disconnect();
    logger.info('Worker database disconnected');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Worker: unhandled Promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Worker: uncaught exception — restarting is recommended');
    process.exit(1);
  });
}

startWorker().catch((err) => {
  console.error('Failed to start worker:', err);
  process.exit(1);
});
