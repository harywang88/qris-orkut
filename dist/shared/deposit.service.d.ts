declare const RETRY_DELAYS_MS: number[];
declare const MAX_ATTEMPTS: number;
export interface DepositPayload {
    qrId: string;
    transactionId: string;
    userId: string;
    requestedAmount: number;
    finalAmount: number;
    paidAmount: number;
    note: string;
    issuerName: string | null;
    rrn: string | null;
    paidAt: string;
    externalReference: string | null;
}
/**
 * Executes a single deposit attempt for a transaction.
 *
 * Idempotency: if a successful attempt with the same idempotencyKey already
 * exists, the function returns immediately without making another HTTP call.
 *
 * Mock behavior: if client.depositApiUrl is empty/null, the deposit auto-succeeds.
 */
export declare function attemptDeposit(transactionId: string): Promise<void>;
/**
 * Returns the nextRetryAt time for a transaction's most recent failed deposit attempt.
 * Returns null if there is no pending retry.
 */
export declare function getNextRetryTime(transactionId: string): Promise<Date | null>;
export { MAX_ATTEMPTS, RETRY_DELAYS_MS };
