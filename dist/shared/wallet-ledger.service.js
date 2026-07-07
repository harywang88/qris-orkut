"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWalletBalance = getWalletBalance;
exports.recordWalletEntry = recordWalletEntry;
exports.getWalletLedger = getWalletLedger;
const database_1 = require("../config/database");
const logger_1 = require("../config/logger");
/**
 * Returns the current balance of a wallet by summing all ledger entries.
 * Returns 0 if no entries exist.
 */
async function getWalletBalance(walletCode) {
    const result = await database_1.db.walletLedger.aggregate({
        where: { walletCode },
        _sum: { amount: true },
    });
    return result._sum.amount ?? 0;
}
/**
 * Credits (positive amount) or debits (negative amount) a wallet atomically.
 * Returns the new balanceAfter value.
 */
async function recordWalletEntry(opts) {
    const { walletCode, amount, refType, refId, description } = opts;
    // Compute running balance — use aggregate for correctness
    const currentBalance = await getWalletBalance(walletCode);
    const balanceAfter = currentBalance + amount;
    await database_1.db.walletLedger.create({
        data: {
            walletCode,
            amount,
            refType,
            refId: refId ?? null,
            description: description ?? null,
            balanceAfter,
        },
    });
    logger_1.logger.debug({ walletCode, amount, refType, balanceAfter }, 'Wallet ledger entry created');
    return balanceAfter;
}
/**
 * Returns recent ledger entries for a wallet with pagination.
 */
async function getWalletLedger(walletCode, limit = 50, offset = 0) {
    const [entries, total] = await Promise.all([
        database_1.db.walletLedger.findMany({
            where: { walletCode },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        }),
        database_1.db.walletLedger.count({ where: { walletCode } }),
    ]);
    return { entries, total };
}
//# sourceMappingURL=wallet-ledger.service.js.map