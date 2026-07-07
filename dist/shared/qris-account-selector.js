"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NoEligibleAccountError = void 0;
exports.selectQrisAccount = selectQrisAccount;
exports.selectQrisAccountStandalone = selectQrisAccountStandalone;
const database_1 = require("../config/database");
const logger_1 = require("../config/logger");
/** Thrown when no QRIS account is available for assignment. */
class NoEligibleAccountError extends Error {
    constructor() {
        super('No eligible QRIS account available. All accounts may be inactive, unhealthy, or at daily limit.');
        this.name = 'NoEligibleAccountError';
    }
}
exports.NoEligibleAccountError = NoEligibleAccountError;
/**
 * Selects the most eligible QRIS account using round-robin (oldest lastAssignedAt first).
 *
 * Selection criteria:
 *   1. status = 'active'
 *   2. healthStatus = 'healthy'
 *   3. usedToday < dailyLimit (or dailyLimit = 0 for unlimited)
 *
 * After selection, updates lastAssignedAt to now() so the next call
 * picks a different account (round-robin). Must be called inside a
 * Prisma transaction to guarantee atomicity.
 *
 * @param tx  A Prisma transaction client (from db.$transaction callback).
 */
async function selectQrisAccount(tx) {
    const accounts = await tx.qrisAccount.findMany({
        where: {
            status: 'active',
            healthStatus: 'healthy',
        },
        orderBy: { lastAssignedAt: 'asc' }, // oldest-assigned first = round-robin
    });
    const eligible = accounts.filter((a) => a.dailyLimit === 0 || a.usedToday < a.dailyLimit);
    if (eligible.length === 0) {
        logger_1.logger.warn({ totalAccounts: accounts.length }, 'No eligible QRIS account found (all at limit or inactive)');
        throw new NoEligibleAccountError();
    }
    const selected = eligible[0];
    // Update lastAssignedAt in the same transaction to ensure atomicity
    await tx.qrisAccount.update({
        where: { id: selected.id },
        data: { lastAssignedAt: new Date() },
    });
    logger_1.logger.debug({ accountCode: selected.code }, 'QRIS account selected');
    return selected;
}
/**
 * Convenience wrapper: runs selectQrisAccount outside a transaction
 * (creates its own). Use this only when you don't need to combine it
 * with other writes atomically.
 */
async function selectQrisAccountStandalone() {
    return database_1.db.$transaction((tx) => selectQrisAccount(tx));
}
//# sourceMappingURL=qris-account-selector.js.map