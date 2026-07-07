"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storeMutationIfNew = storeMutationIfNew;
exports.publishMutationUpdated = publishMutationUpdated;
const database_1 = require("../config/database");
const outbox_service_1 = require("./outbox.service");
function buildMutationPayload(mutation) {
    return {
        mutationId: mutation.id,
        qrisAccountId: mutation.qrisAccountId,
        amount: mutation.amount,
        type: mutation.type,
        balanceAfter: mutation.balanceAfter,
        rrn: mutation.rrn,
        issuerName: mutation.issuerName,
        walletCategory: mutation.walletCategory,
        matchedTransactionId: mutation.matchedTransactionId,
        transactionTime: mutation.transactionTime.toISOString(),
        createdAt: mutation.createdAt.toISOString(),
    };
}
async function storeMutationIfNew(input, client = database_1.db) {
    const existing = await client.mutation.findUnique({ where: { rawHash: input.rawHash } });
    if (existing) {
        return { created: false, mutation: existing };
    }
    const mutation = await client.mutation.create({
        data: {
            qrisAccountId: input.qrisAccountId,
            amount: input.amount,
            type: input.type,
            balanceBefore: input.balanceBefore,
            balanceAfter: input.balanceAfter,
            issuerName: input.issuerName ?? null,
            rrn: input.rrn ?? null,
            walletCategory: input.walletCategory ?? null,
            transactionTime: input.transactionTime,
            rawHash: input.rawHash,
            rawDataJson: input.rawDataJson,
            matchedTransactionId: input.matchedTransactionId ?? null,
        },
    });
    await (0, outbox_service_1.publishOutboxEvent)({
        topic: 'mutation.created',
        aggregateType: 'mutation',
        aggregateId: mutation.id,
        qrisAccountId: mutation.qrisAccountId,
        payload: buildMutationPayload(mutation),
    }, client);
    return { created: true, mutation };
}
async function publishMutationUpdated(mutation, reason, client = database_1.db) {
    await (0, outbox_service_1.publishOutboxEvent)({
        topic: 'mutation.updated',
        aggregateType: 'mutation',
        aggregateId: mutation.id,
        qrisAccountId: mutation.qrisAccountId,
        payload: {
            ...buildMutationPayload(mutation),
            reason,
        },
    }, client);
}
//# sourceMappingURL=mutation-ingest.service.js.map