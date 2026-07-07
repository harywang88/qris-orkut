"use strict";
/**
 * Settlement Sweep Loop — runs every 60 seconds
 *
 * Finds pending settlement requests and processes them via processSettlement().
 * Processing is synchronous per request to avoid partial ledger state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSettlementSweepLoop = startSettlementSweepLoop;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const settlement_service_1 = require("../../shared/settlement.service");
const INTERVAL_MS = 60000;
let running = false;
async function tick() {
    const pending = await database_1.db.settlementRequest.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
        take: 10,
    });
    if (pending.length === 0)
        return;
    logger_1.logger.info({ count: pending.length }, 'Settlement sweep: processing pending requests');
    for (const { id } of pending) {
        try {
            await (0, settlement_service_1.processSettlement)(id);
        }
        catch (err) {
            logger_1.logger.error({ err, settlementId: id }, 'Settlement sweep: processing error');
        }
    }
}
function startSettlementSweepLoop() {
    logger_1.logger.info({ intervalMs: INTERVAL_MS }, 'Settlement sweep loop started');
    // Run once immediately on startup to process any pending settlements
    tick().catch((err) => logger_1.logger.error({ err }, 'Settlement sweep initial tick error'));
    setInterval(() => {
        if (running)
            return;
        running = true;
        tick()
            .catch((err) => logger_1.logger.error({ err }, 'Settlement sweep loop error'))
            .finally(() => {
            running = false;
        });
    }, INTERVAL_MS);
}
//# sourceMappingURL=settlement-sweep.loop.js.map