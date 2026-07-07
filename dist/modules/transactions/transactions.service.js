"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTransactionByQrId = getTransactionByQrId;
exports.listTransactions = listTransactions;
exports.listPaidTransactions = listPaidTransactions;
exports.recheckTransaction = recheckTransaction;
exports.queueDepositRetry = queueDepositRetry;
exports.createSimulatedMutation = createSimulatedMutation;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const mutation_ingest_service_1 = require("../../shared/mutation-ingest.service");
async function hydrateTransactionReferenceFields(tx) {
    if (tx.statusPay !== 'paid' || !tx.mutations?.length) {
        return tx;
    }
    const fallbackMutation = tx.mutations.find((mutation) => mutation.rrn || mutation.issuerName) ?? tx.mutations[0];
    if (!fallbackMutation) {
        return tx;
    }
    const patch = {};
    if (!tx.rrn && fallbackMutation.rrn)
        patch.rrn = fallbackMutation.rrn;
    if (!tx.issuerName && fallbackMutation.issuerName)
        patch.issuerName = fallbackMutation.issuerName;
    if (!tx.paidAt && fallbackMutation.transactionTime)
        patch.paidAt = fallbackMutation.transactionTime;
    if (Object.keys(patch).length === 0) {
        return tx;
    }
    await database_1.db.transaction.update({
        where: { id: tx.id },
        data: patch,
    });
    return {
        ...tx,
        ...patch,
    };
}
async function getTransactionByQrId(qrId) {
    const tx = await database_1.db.transaction.findUnique({
        where: { qrId },
        include: {
            client: { select: { name: true, panelCode: true } },
            qrisAccount: { select: { code: true, merchantName: true } },
            depositAttempts: { orderBy: { createdAt: 'desc' }, take: 5 },
            mutations: {
                select: { rrn: true, issuerName: true, transactionTime: true, createdAt: true },
                orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
                take: 3,
            },
        },
    });
    if (!tx)
        return null;
    return hydrateTransactionReferenceFields(tx);
}
async function listTransactions(filter) {
    const where = {};
    if (filter?.clientId)
        where.clientId = filter.clientId;
    if (filter?.statusPay)
        where.statusPay = filter.statusPay;
    if (filter?.statusBot)
        where.statusBot = filter.statusBot;
    if (filter?.from || filter?.to) {
        where.createdAt = {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
        };
    }
    const [transactions, total] = await Promise.all([
        database_1.db.transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: filter?.limit ?? 50,
            skip: filter?.offset ?? 0,
            include: {
                client: { select: { name: true, panelCode: true } },
                qrisAccount: { select: { code: true, merchantName: true } },
            },
        }),
        database_1.db.transaction.count({ where }),
    ]);
    return { transactions, total };
}
/**
 * Lists successfully paid transactions for the Transactions dashboard page.
 */
async function listPaidTransactions(filter) {
    const where = { statusPay: 'paid' };
    if (filter?.clientId)
        where.clientId = filter.clientId;
    if (filter?.qrisAccountCode) {
        where.qrisAccount = { code: filter.qrisAccountCode };
    }
    if (filter?.from || filter?.to) {
        where.paidAt = {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
        };
    }
    const [transactions, total] = await Promise.all([
        database_1.db.transaction.findMany({
            where,
            orderBy: { paidAt: 'desc' },
            take: filter?.limit ?? 50,
            skip: filter?.offset ?? 0,
            include: {
                client: { select: { name: true, panelCode: true } },
                qrisAccount: { select: { code: true, merchantName: true } },
            },
        }),
        database_1.db.transaction.count({ where }),
    ]);
    return { transactions, total };
}
/**
 * Manually triggers a status recheck for a transaction.
 * Worker handles actual gateway recheck; this just returns current state.
 */
async function recheckTransaction(qrId) {
    const tx = await database_1.db.transaction.findUnique({ where: { qrId } });
    if (!tx)
        throw new Error('Transaksi tidak ditemukan');
    logger_1.logger.info({ qrId }, 'Manual recheck requested');
    return tx;
}
/**
 * Queues a transaction for manual deposit retry.
 * Safe to call multiple times — deposit service has idempotency key guard.
 */
async function queueDepositRetry(qrId) {
    const tx = await database_1.db.transaction.findUnique({ where: { qrId } });
    if (!tx)
        throw new Error('Transaksi tidak ditemukan');
    if (tx.statusPay !== 'paid') {
        throw new Error('Hanya transaksi yang sudah dibayar yang bisa di-retry deposit');
    }
    if (!['deposit_failed', 'manual_review'].includes(tx.statusBot)) {
        throw new Error(`Retry deposit hanya tersedia untuk status deposit_failed atau manual_review (saat ini: ${tx.statusBot})`);
    }
    await database_1.db.transaction.update({
        where: { qrId },
        data: { statusBot: 'deposit_queued' },
    });
    logger_1.logger.info({ qrId }, 'Transaction queued for deposit retry');
}
/**
 * Creates a mock mutation for a given open transaction (dev/simulation only).
 * The worker's mutation-poll loop will pick it up within 1.5 seconds.
 */
async function createSimulatedMutation(qrId) {
    const tx = await database_1.db.transaction.findUnique({
        where: { qrId },
        include: { qrisAccount: true },
    });
    if (!tx)
        throw new Error(`Transaksi tidak ditemukan: ${qrId}`);
    if (tx.statusPay !== 'open')
        throw new Error(`Transaksi sudah ${tx.statusPay}, tidak bisa disimulasikan`);
    if (new Date() > tx.expiresAt)
        throw new Error('Transaksi sudah expired');
    // Build raw data hash for dedup
    const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
    const rawData = {
        simulatedAt: new Date().toISOString(),
        amount: tx.finalAmount,
        issuer: 'MOCK_BANK',
        rrn: `SIM${Date.now()}`,
        qrId,
    };
    const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');
    const { mutation } = await (0, mutation_ingest_service_1.storeMutationIfNew)({
        qrisAccountId: tx.qrisAccountId,
        amount: tx.finalAmount,
        type: 'credit',
        balanceBefore: 1000000,
        balanceAfter: 1000000 + tx.finalAmount,
        issuerName: 'MOCK_BANK',
        rrn: rawData.rrn,
        transactionTime: new Date(),
        rawHash,
        rawDataJson: JSON.stringify(rawData),
    });
    logger_1.logger.info({ mutationId: mutation.id, qrId, amount: tx.finalAmount }, 'Simulated mutation created');
    return mutation.id;
}
//# sourceMappingURL=transactions.service.js.map