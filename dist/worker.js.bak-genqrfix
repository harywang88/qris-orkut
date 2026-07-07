"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = require("./config/database");
const logger_1 = require("./config/logger");
const mutation_poll_loop_1 = require("./worker/loops/mutation-poll.loop");
const expiry_sweep_loop_1 = require("./worker/loops/expiry-sweep.loop");
const deposit_retry_loop_1 = require("./worker/loops/deposit-retry.loop");
const settlement_sweep_loop_1 = require("./worker/loops/settlement-sweep.loop");
const orkut_fetch_loop_1 = require("./worker/loops/orkut-fetch.loop");
const runtime_heartbeat_1 = require("./shared/runtime-heartbeat");
async function startWorker() {
    logger_1.logger.info('⚙️  QRIS Worker starting...');
    await (0, database_1.initDatabase)();
    const stopHeartbeat = (0, runtime_heartbeat_1.startRuntimeHeartbeat)('qris-worker', 5000, () => ({
        uptimeSeconds: Math.floor(process.uptime()),
    }));
    // Start all background loops
    (0, mutation_poll_loop_1.startMutationPollLoop)();
    (0, expiry_sweep_loop_1.startExpirySweepLoop)();
    (0, deposit_retry_loop_1.startDepositRetryLoop)();
    (0, settlement_sweep_loop_1.startSettlementSweepLoop)();
    (0, orkut_fetch_loop_1.startOrkutFetchLoop)();
    logger_1.logger.info('⚙️  QRIS Worker running — all loops active. Press Ctrl+C to stop.');
    // Keep process alive
    process.stdin.resume();
    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        logger_1.logger.info({ signal }, 'Worker shutdown signal received');
        stopHeartbeat();
        await database_1.db.$disconnect();
        logger_1.logger.info('Worker database disconnected');
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger_1.logger.error({ reason }, 'Worker: unhandled Promise rejection');
    });
    process.on('uncaughtException', (err) => {
        logger_1.logger.error({ err }, 'Worker: uncaught exception — restarting is recommended');
        process.exit(1);
    });
}
startWorker().catch((err) => {
    console.error('Failed to start worker:', err);
    process.exit(1);
});
//# sourceMappingURL=worker.js.map