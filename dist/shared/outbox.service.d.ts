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
export declare function publishOutboxEvent(input: PublishOutboxEventInput, client?: PrismaLike): Promise<{
    status: string;
    id: string;
    createdAt: Date;
    errorMessage: string | null;
    qrisAccountId: string | null;
    processedAt: Date | null;
    topic: string;
    aggregateType: string;
    aggregateId: string;
    payloadJson: string;
    availableAt: Date;
    attemptCount: number;
}>;
export declare function listOutboxEventsSince(since: Date, lastEventId?: string, qrisAccountId?: string): Promise<{
    status: string;
    id: string;
    createdAt: Date;
    errorMessage: string | null;
    qrisAccountId: string | null;
    processedAt: Date | null;
    topic: string;
    aggregateType: string;
    aggregateId: string;
    payloadJson: string;
    availableAt: Date;
    attemptCount: number;
}[]>;
export declare function parseOutboxPayload(payloadJson: string): Record<string, unknown>;
export {};
