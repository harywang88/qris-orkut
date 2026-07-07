"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountFullError = void 0;
exports.findUniqueCode = findUniqueCode;
exports.createAmountLock = createAmountLock;
exports.reserveUniqueCode = reserveUniqueCode;
const logger_1 = require("../config/logger");
/** Thrown when all 999 unique codes for an account are currently in use. */
class AccountFullError extends Error {
    constructor(accountCode) {
        super(`QRIS account ${accountCode} has no available unique codes. All 999 slots are locked.`);
        this.name = 'AccountFullError';
    }
}
exports.AccountFullError = AccountFullError;
/**
 * Phase 1: Find an available unique code for the account (read-only).
 * Must be called inside a Prisma $transaction before the Transaction record is created.
 */
async function findUniqueCode(tx, qrisAccountId, accountCode, requestedAmount) {
    const activeLocks = await tx.amountLock.findMany({
        where: {
            qrisAccountId,
            status: 'active',
            expiresAt: { gt: new Date() },
        },
        select: { uniqueCode: true },
    });
    const occupiedCodes = new Set(activeLocks.map((l) => l.uniqueCode));
    let uniqueCode = null;
    for (let code = 1; code <= 999; code++) {
        if (!occupiedCodes.has(code)) {
            uniqueCode = code;
            break;
        }
    }
    if (uniqueCode === null) {
        throw new AccountFullError(accountCode);
    }
    return { uniqueCode, finalAmount: requestedAmount + uniqueCode };
}
/**
 * Phase 2: Persist the AmountLock after the Transaction record already exists.
 * The Transaction must be inserted first to satisfy the FK constraint.
 */
async function createAmountLock(tx, opts) {
    const { qrisAccountId, requestedAmount, uniqueCode, finalAmount, expiresAt, transactionId } = opts;
    const lock = await tx.amountLock.create({
        data: {
            qrisAccountId,
            requestedAmount,
            uniqueCode,
            finalAmount,
            activeKey: `${qrisAccountId}:${finalAmount}`,
            transactionId,
            expiresAt,
            status: 'active',
        },
    });
    logger_1.logger.debug({ uniqueCode, finalAmount, requestedAmount }, 'Amount lock reserved');
    return { uniqueCode, finalAmount, lockId: lock.id };
}
/**
 * Convenience wrapper: find a unique code and immediately persist the lock.
 * Only safe to call AFTER the Transaction record has been inserted in the same tx.
 */
async function reserveUniqueCode(opts) {
    const { tx, qrisAccountId, accountCode, requestedAmount, expiresAt, transactionId } = opts;
    const { uniqueCode, finalAmount } = await findUniqueCode(tx, qrisAccountId, accountCode, requestedAmount);
    return createAmountLock(tx, {
        qrisAccountId,
        requestedAmount,
        uniqueCode,
        finalAmount,
        expiresAt,
        transactionId,
    });
}
//# sourceMappingURL=amount-lock.service.js.map