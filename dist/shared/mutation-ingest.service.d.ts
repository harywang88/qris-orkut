import type { Mutation, Prisma } from '@prisma/client';
import { db } from '../config/database';
type PrismaLike = typeof db | Prisma.TransactionClient;
export interface MutationIngestInput {
    qrisAccountId: string;
    amount: number;
    type: string;
    balanceBefore: number;
    balanceAfter: number;
    issuerName?: string | null;
    rrn?: string | null;
    walletCategory?: string | null;
    transactionTime: Date;
    rawHash: string;
    rawDataJson: string;
    matchedTransactionId?: string | null;
}
export declare function storeMutationIfNew(input: MutationIngestInput, client?: PrismaLike): Promise<{
    created: boolean;
    mutation: Mutation;
}>;
export declare function publishMutationUpdated(mutation: Mutation, reason: 'detail_enriched' | 'matched' | 'manual_update', client?: PrismaLike): Promise<void>;
export {};
