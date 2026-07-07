export type WalletCode = 'utama' | 'madera';
export type RefType = 'deposit_success' | 'settlement_in' | 'settlement_out' | 'adjustment';
/**
 * Returns the current balance of a wallet by summing all ledger entries.
 * Returns 0 if no entries exist.
 */
export declare function getWalletBalance(walletCode: WalletCode): Promise<number>;
/**
 * Credits (positive amount) or debits (negative amount) a wallet atomically.
 * Returns the new balanceAfter value.
 */
export declare function recordWalletEntry(opts: {
    walletCode: WalletCode;
    amount: number;
    refType: RefType;
    refId?: string;
    description?: string;
}): Promise<number>;
/**
 * Returns recent ledger entries for a wallet with pagination.
 */
export declare function getWalletLedger(walletCode: WalletCode, limit?: number, offset?: number): Promise<{
    entries: {
        id: string;
        createdAt: Date;
        description: string | null;
        walletCode: string;
        amount: number;
        balanceAfter: number;
        refType: string;
        refId: string | null;
    }[];
    total: number;
}>;
