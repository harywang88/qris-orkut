import type { Mutation } from '@prisma/client';
export type MatchResult = {
    matched: true;
    transactionId: string;
    qrId: string;
} | {
    matched: false;
    reason: string;
};
/**
 * Attempts to match a single mutation to an eligible transaction.
 *
 * Matching rules:
 * - same QRIS account
 * - same final amount
 * - payment time must fall inside the QR lifetime window
 *
 * Repair rules:
 * - if an older unmatched mutation had incorrectly marked a newer QR as paid,
 *   a fresh real mutation is allowed to replace that suspicious linkage
 */
export declare function tryMatchMutation(mutation: Mutation): Promise<MatchResult>;
/**
 * Fetches unmatched QRIS credit mutations from the DB for processing.
 */
export declare function fetchUnmatchedMutations(limit?: number): Promise<Mutation[]>;
