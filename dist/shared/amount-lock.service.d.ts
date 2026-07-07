import type { PrismaClient } from '@prisma/client';
/** Thrown when all 999 unique codes for an account are currently in use. */
export declare class AccountFullError extends Error {
    constructor(accountCode: string);
}
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
interface ReserveOptions {
    tx: TxClient;
    qrisAccountId: string;
    accountCode: string;
    requestedAmount: number;
    expiresAt: Date;
    transactionId: string;
}
interface ReserveResult {
    uniqueCode: number;
    finalAmount: number;
    lockId: string;
}
/**
 * Phase 1: Find an available unique code for the account (read-only).
 * Must be called inside a Prisma $transaction before the Transaction record is created.
 */
export declare function findUniqueCode(tx: TxClient, qrisAccountId: string, accountCode: string, requestedAmount: number): Promise<{
    uniqueCode: number;
    finalAmount: number;
}>;
/**
 * Phase 2: Persist the AmountLock after the Transaction record already exists.
 * The Transaction must be inserted first to satisfy the FK constraint.
 */
export declare function createAmountLock(tx: TxClient, opts: Omit<ReserveOptions, 'tx' | 'accountCode'> & {
    uniqueCode: number;
    finalAmount: number;
}): Promise<ReserveResult>;
/**
 * Convenience wrapper: find a unique code and immediately persist the lock.
 * Only safe to call AFTER the Transaction record has been inserted in the same tx.
 */
export declare function reserveUniqueCode(opts: ReserveOptions): Promise<ReserveResult>;
export {};
