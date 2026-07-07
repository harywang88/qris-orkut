import { z } from 'zod';
export declare const CreateSettlementSchema: z.ZodObject<{
    fromWallet: z.ZodEnum<["qris", "utama", "madera"]>;
    toWallet: z.ZodEnum<["utama", "madera", "bank"]>;
    amount: z.ZodNumber;
    qrisAccountId: z.ZodOptional<z.ZodString>;
    bankCode: z.ZodOptional<z.ZodString>;
    bankAccount: z.ZodOptional<z.ZodString>;
    bankName: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    amount: number;
    fromWallet: "utama" | "madera" | "qris";
    toWallet: "utama" | "madera" | "bank";
    note?: string | undefined;
    bankCode?: string | undefined;
    bankName?: string | undefined;
    qrisAccountId?: string | undefined;
    bankAccount?: string | undefined;
}, {
    amount: number;
    fromWallet: "utama" | "madera" | "qris";
    toWallet: "utama" | "madera" | "bank";
    note?: string | undefined;
    bankCode?: string | undefined;
    bankName?: string | undefined;
    qrisAccountId?: string | undefined;
    bankAccount?: string | undefined;
}>;
export type CreateSettlementInput = z.infer<typeof CreateSettlementSchema>;
export type ProcessSettlementResult = {
    message?: string | null;
    redirectUrl?: string | null;
    referenceNo?: string | null;
    settlementId: string;
    status: 'pending' | 'processing' | 'done' | 'failed';
};
/**
 * Creates a new settlement request with status=pending.
 */
export declare function createSettlement(input: CreateSettlementInput, userId?: string, ip?: string): Promise<string>;
/**
 * Processes a single pending settlement request.
 * Called by the settlement-sweep worker loop.
 *
 * Flow:
 *   1. Mark as processing
 *   2. Validate source balance (for wallet-to-wallet transfers)
 *   3. Debit fromWallet / Credit toWallet via WalletLedger
 *   4. Mark as done (or failed on error)
 *   5. Create SettlementItem entries if linked to transactions
 */
export declare function processSettlement(settlementId: string): Promise<ProcessSettlementResult | void>;
export declare function inquireSettlementBankAccount(input: {
    amount?: number;
    bankAccount: string;
    bankCode: string;
    fromWallet: 'utama' | 'madera';
    qrisAccountId: string;
}): Promise<{
    accountName: string;
    accountNumber: string;
    bankCode: string;
    bankName: string;
    fee: number | null;
    message: string | null;
}>;
export declare function listSettlementTransferBanks(qrisAccountId: string): Promise<Array<{
    code: string;
    fee: number;
    name: string;
    status: string;
}>>;
export declare function reconcileProcessingMaderaTransfers(accountId?: string): Promise<number>;
/**
 * Lists settlement requests with optional filters.
 */
export declare function listSettlements(opts?: {
    status?: string;
    limit?: number;
    offset?: number;
}): Promise<{
    settlements: {
        status: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        amount: number;
        note: string | null;
        bankCode: string | null;
        bankName: string | null;
        referenceNo: string | null;
        fromWallet: string;
        toWallet: string;
        qrisAccountId: string | null;
        bankAccount: string | null;
        processedAt: Date | null;
    }[];
    total: number;
}>;
