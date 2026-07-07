"use strict";
/**
 * Expiry Sweep Loop — runs every 30 seconds
 *
 * Expires open QR transactions that have passed their expiresAt deadline,
 * releases their amount locks, and purges stale HMAC nonces.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startExpirySweepLoop = startExpirySweepLoop;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const hmac_1 = require("../../core/hmac");
const INTERVAL_MS = 30000;
let running = false;
async function tick() {
    const now = new Date();
    // 1. Expire open transactions past their deadline
    const expiredTx = await database_1.db.transaction.updateMany({
        where: {
            statusPay: 'open',
            expiresAt: { lt: now },
        },
        data: { statusPay: 'expired' },
    });
    if (expiredTx.count > 0) {
        logger_1.logger.info({ count: expiredTx.count }, 'Expiry sweep: transactions expired');
    }
    // 2. Release amount locks for expired transactions
    const releasedLocks = await database_1.db.amountLock.updateMany({
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
        logger_1.logger.debug({ count: releasedLocks.count }, 'Expiry sweep: amount locks released');
    }
    // 3. Purge expired HMAC nonces
    const purgeCnt = await (0, hmac_1.purgeExpiredNonces)();
    if (purgeCnt > 0) {
        logger_1.logger.debug({ count: purgeCnt }, 'Expiry sweep: nonces purged');
    }
}
function startExpirySweepLoop() {
    logger_1.logger.info({ intervalMs: INTERVAL_MS }, 'Expiry sweep loop started');
    // Run once immediately on startup, then on interval
    tick().catch((err) => logger_1.logger.error({ err }, 'Expiry sweep initial tick error'));
    setInterval(() => {
        if (running)
            return;
        running = true;
        tick()
            .catch((err) => logger_1.logger.error({ err }, 'Expiry sweep loop error'))
            .finally(() => {
            running = false;
        });
    }, INTERVAL_MS);
}
//# sourceMappingURL=expiry-sweep.loop.js.map