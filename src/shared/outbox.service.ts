import type { Prisma } from '@prisma/client';
import { db } from '../config/database';

type PrismaLike = typeof db | Prisma.TransactionClient;

export interface PublishOutboxEventInput {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  qrisAccountId?: string | null;
  availableAt?: Date;
}

function serializePayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export async function publishOutboxEvent(
  input: PublishOutboxEventInput,
  client: PrismaLike = db,
) {
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

export async function listOutboxEventsSince(
  since: Date,
  lastEventId?: string,
  qrisAccountId?: string,
) {
  return db.outboxEvent.findMany({
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

export function parseOutboxPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
