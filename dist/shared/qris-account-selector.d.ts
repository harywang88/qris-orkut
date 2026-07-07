import type { QrisAccount, PrismaClient } from '@prisma/client';
/** Thrown when no QRIS account is available for assignment. */
export declare class NoEligibleAccountError extends Error {
    constructor();
}
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
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
export declare function selectQrisAccount(tx: TxClient): Promise<QrisAccount>;
/**
 * Convenience wrapper: runs selectQrisAccount outside a transaction
 * (creates its own). Use this only when you don't need to combine it
 * with other writes atomically.
 */
export declare function selectQrisAccountStandalone(): Promise<QrisAccount>;
export {};
