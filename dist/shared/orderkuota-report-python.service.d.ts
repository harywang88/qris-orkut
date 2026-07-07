import type { QrisAccount } from '@prisma/client';
type WalletTarget = 'qris' | 'utama' | 'both';
type RawPythonMutation = {
    amount: number;
    type: 'credit' | 'debit';
    balanceBefore: number;
    balanceAfter: number;
    issuerName: string | null;
    rrn: string | null;
    walletCategory: 'qris' | 'utama' | 'madera' | null;
    transactionTime: string;
    rawHash: string;
    rawDataJson: string;
};
type PythonWalletPayload = {
    mutations: RawPythonMutation[];
    count: number;
    balance: number | null;
    meta?: {
        accountName?: string | null;
        detectedPattern?: string | null;
        pagesRead?: number | null;
        pageBase?: string | null;
    };
};
type PythonScrapeResult = {
    ok: boolean;
    target: WalletTarget;
    qris: PythonWalletPayload;
    utama: PythonWalletPayload;
};
export type ReportSyncStats = {
    mainBalance: number | null;
    qrisBalance: number | null;
    newQrisMutations: number;
    newUtamaMutations: number;
};
export declare function probeMerchantMutationsFromReport(account: Pick<QrisAccount, 'code' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>, target?: WalletTarget): Promise<PythonScrapeResult>;
export declare function probeMerchantMutationsFromRawReportInput(input: {
    cookie: string;
    userAgent?: string | null;
    target?: WalletTarget;
}): Promise<PythonScrapeResult>;
export type { PythonScrapeResult, WalletTarget };
export declare function syncMerchantMutationsFromReport(account: Pick<QrisAccount, 'id' | 'code' | 'lastMainBalance' | 'lastQrisBalance' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>, target?: WalletTarget): Promise<ReportSyncStats>;
export declare function syncMerchantMutationsFromReportIfStale(account: Pick<QrisAccount, 'id' | 'code' | 'lastMainBalance' | 'lastQrisBalance' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>, target?: WalletTarget, maxAgeMs?: number): Promise<ReportSyncStats | null>;
