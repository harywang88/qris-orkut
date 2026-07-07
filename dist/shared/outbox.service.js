"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishOutboxEvent = publishOutboxEvent;
exports.listOutboxEventsSince = listOutboxEventsSince;
exports.parseOutboxPayload = parseOutboxPayload;
const database_1 = require("../config/database");
function serializePayload(payload) {
    return JSON.stringify(payload);
}
async function publishOutboxEvent(input, client = database_1.db) {
    return client.outboxEvent.create({
        data: {
            topic: input.topic,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            qrisAccountId: input.qrisAccountId ?? null,
            payloadJson: serializePayload(input.payload),
            availableAt: input.availableAt ?? new Date(),
        },
    });
}
async function listOutboxEventsSince(since, lastEventId, qrisAccountId) {
    return database_1.db.outboxEvent.findMany({
        where: {
            topic: { startsWith: 'mutation.' },
            ...(qrisAccountId ? { qrisAccountId } : {}),
            OR: [
                { createdAt: { gt: since } },
                ...(lastEventId ? [{ createdAt: since, id: { gt: lastEventId } }] : []),
            ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 100,
    });
}
function parseOutboxPayload(payloadJson) {
    try {
        const parsed = JSON.parse(payloadJson);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=outbox.service.js.map