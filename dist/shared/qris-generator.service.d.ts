import { z } from 'zod';
import { NoEligibleAccountError } from './qris-account-selector';
import { AccountFullError } from './amount-lock.service';
export declare const GenerateQrSchema: z.ZodObject<{
    userId: z.ZodString;
    amount: z.ZodNumber;
    externalReference: z.ZodOptional<z.ZodString>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    userId: string;
    amount: number;
    externalReference?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}, {
    userId: string;
    amount: number;
    externalReference?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
}>;
export type GenerateQrInput = z.infer<typeof GenerateQrSchema>;
export interface GenerateQrOutput {
    qrId: string;
    requestedAmount: number;
    uniqueCode: number;
    finalAmount: number;
    fee: number;
    expiresAt: string;
    statusPay: string;
    qrPayload: string;
    qrImageBase64: string;
    note: string;
    qrisAccount: {
        code: string;
        merchantName: string;
    };
}
/**
 * Orchestrates the full QR generation flow:
 *
 *  1. Validate input (Zod)
 *  2. Generate a pre-computed Transaction ID (crypto.randomUUID)
 *  3. Open a Prisma $transaction:
 *     a. selectQrisAccount (round-robin, updates lastAssignedAt)
 *     b. reserveUniqueCode (inserts AmountLock)
 *     c. buildNote
 *  4. Generate QR image outside the transaction (async I/O, avoids holding lock)
 *  5. Compute fee
 *  6. Re-open (or extend) transaction to insert Transaction + update usedToday
 *
 * Note: Steps 3 and 6 are merged into one $transaction for full atomicity.
 * The QR image generation (step 4) is async CPU work that completes quickly
 * and is acceptable inside the transaction in this implementation.
 */
export declare function generateQr(clientId: string, rawInput: unknown): Promise<GenerateQrOutput>;
/** Re-exports for convenience */
export { NoEligibleAccountError, AccountFullError };
