import type { QrisAccount } from '@prisma/client';
export type OrkutMutationCategory = 'qris' | 'utama' | 'madera';
export interface OrkutBalanceSnapshot {
    status: 'synced' | 'partial' | 'error';
    source: 'combined' | 'merged';
    accountIndex: number;
    mainBalance?: number;
    qrisBalance?: number;
    maderaBalance?: number;
    withdrawEnabled?: boolean;
    withdrawMin?: number;
    withdrawMax?: number;
    rawJson: string;
    errorMessage?: string;
    fetchedAt: string;
}
export interface OrkutBalanceSummary {
    totalAccounts: number;
    syncedAccounts: number;
    mainBalance: number;
    qrisBalance: number;
    maderaBalance: number;
    updatedAt: string | null;
}
export interface OrkutTransferBankOption {
    code: string;
    fee: number | null;
    name: string;
    status: string;
}
export interface OrkutTransferBankInquiryResult {
    accountIndex: number;
    accountName: string | null;
    accountNumber: string | null;
    bankCode: string | null;
    bankName: string | null;
    fee: number | null;
    message: string | null;
    rawJson: string;
    sessionId: string | null;
    success: boolean;
}
export interface OrkutTransferBankResult {
    accountIndex: number;
    accountName: string | null;
    accountNumber: string | null;
    bankCode: string | null;
    bankName: string | null;
    fee: number | null;
    message: string | null;
    rawJson: string;
    redirectUrl: string | null;
    referenceNo: string | null;
    status: 'done' | 'processing' | 'failed';
    success: boolean;
}
export declare function classifyOrkutMutationDescription(description: string): OrkutMutationCategory;
export declare function summarizeOrkutAccountBalances(accounts: Array<{
    lastMainBalance: number | null;
    lastQrisBalance: number | null;
    lastMaderaBalance: number | null;
    lastBalanceSyncAt: Date | null;
}>): OrkutBalanceSummary;
export declare function resolveOrkutAccountIndex(account: Pick<QrisAccount, 'orkutAccountIndex'>, fallbackIndex: number): number;
export declare function syncOrkutBalanceSnapshot(account: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent' | 'orkutAccountIndex' | 'sessionTokenEncrypted' | 'deviceId' | 'code'>, fallbackIndex: number): Promise<OrkutBalanceSnapshot | null>;
export type OrkutSettlementAction = 'withdraw' | 'topup_madera';
export type OrkutSettlementActionResult = {
    success: boolean;
    action: OrkutSettlementAction;
    accountIndex: number;
    message: string;
    referenceNo: string | null;
    rawJson: string;
};
export declare function performOrkutSettlementAction(account: Pick<QrisAccount, 'code' | 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent' | 'orkutAccountIndex'>, fallbackIndex: number, action: OrkutSettlementAction, amount: number): Promise<OrkutSettlementActionResult>;
export declare function fetchOrkutTransferBanks(account: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent' | 'orkutAccountIndex'>, fallbackIndex: number): Promise<{
    accountIndex: number;
    banks: OrkutTransferBankOption[];
    message: string | null;
    rawJson: string;
    success: boolean;
}>;
export declare function inquireOrkutBankAccount(account: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent' | 'orkutAccountIndex'>, fallbackIndex: number, params: {
    accountNumber: string;
    amount?: number;
    bankCode: string;
}): Promise<OrkutTransferBankInquiryResult>;
export declare function transferOrkutBankFromMadera(account: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent' | 'orkutAccountIndex'>, fallbackIndex: number, params: {
    accountName: string;
    accountNumber: string;
    amount: number;
    bankCode: string;
    bankName?: string;
    sessionId?: string | null;
    widgetMerchantId?: number | null;
}): Promise<OrkutTransferBankResult>;
