import type { QrisAccount } from '@prisma/client';
import type { IOrkutGateway, QrGenerationResult, RecheckResult, RawMutation } from './gateway.interface';
export declare const APP_QRIS_RATE_LIMIT_COOLDOWN_MS: number;
export interface AppAccountBalance {
    mainBalance: number | null;
    qrisBalance: number | null;
}
export interface AppMutationResult {
    mutations: RawMutation[];
    balance: AppAccountBalance;
}
export interface AppQrisFetchOptions {
    knownRawHashes?: Iterable<string>;
    maxPages?: number;
    fromTime?: Date | null;
    stopOnKnown?: boolean;
}
export interface AppBalanceHistoryResult {
    mutations: RawMutation[];
    mainBalance: number | null;
}
export interface AppQrisMerchantTerms {
    qrisData: string;
    min: number;
    max: number;
    expired: number;
}
export interface AppQrisWithdrawTerms {
    mainBalance: number | null;
    qrisBalance: number | null;
    isEnabled: boolean;
    max: number;
    message: string | null;
    min: number;
    raw: Record<string, unknown>;
}
export interface AppQrisWithdrawResult {
    message: string;
    raw: Record<string, unknown>;
    success: boolean;
}
export interface AppMaderaTopupResult {
    detailsId: string | null;
    message: string;
    raw: Record<string, unknown>;
    success: boolean;
}
export interface AppBankInquiryResult {
    accountName: string | null;
    accountNumber: string | null;
    bankCode: string | null;
    bankName: string | null;
    fee: number | null;
    message: string | null;
    raw: Record<string, unknown>;
    sessionId: string | null;
    sourceWallet: 'utama' | 'madera';
    success: boolean;
}
export interface AppBankTransferResult {
    accountName: string | null;
    accountNumber: string | null;
    bankCode: string | null;
    bankName: string | null;
    fee: number | null;
    message: string | null;
    raw: Record<string, unknown>;
    referenceNo: string | null;
    redirectUrl: string | null;
    sourceWallet: 'utama' | 'madera';
    status: 'done' | 'processing' | 'failed';
    success: boolean;
}
export interface AppMaderaTransferOverview {
    accountBalance: number | null;
    banks: Record<string, {
        fee: number;
        name: string;
        status: string;
    }>;
    fee: number | null;
    max: number | null;
    message: string | null;
    min: number | null;
    raw: Record<string, unknown>;
}
export interface AppQrisMutationDetail {
    amount: number | null;
    amountNett: number | null;
    brandName: string | null;
    cpan: string | null;
    displayTime: string | null;
    feeText: string | null;
    mid: string | null;
    mpan: string | null;
    nmid: string | null;
    raw: Record<string, unknown>;
    rawId: string;
    rrn: string | null;
    senderName: string | null;
    statusCode: 'IN' | 'OUT';
}
export declare class AppOrkutRateLimitError extends Error {
    readonly retryAfterMs: number;
    constructor(message?: string, retryAfterMs?: number);
}
export declare class AppOrkutGateway implements IOrkutGateway {
    /**
     * Ambil semua mutasi QRIS dari app.orderkuota.com/api/v2/qris/mutasi/{accountId}.
     * Otomatis pagination sampai MAX_PAGES.
     */
    fetchMutations(account: QrisAccount): Promise<RawMutation[]>;
    fetchAccountSummary(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>): Promise<AppAccountBalance>;
    /**
     * Extended fetch — juga kembalikan saldo akun dari response API.
     * Dipanggil oleh orkut-fetch.loop untuk update balance snapshot.
     */
    fetchMutationsAndBalance(account: QrisAccount, options?: AppQrisFetchOptions): Promise<AppMutationResult>;
    fetchIncrementalMutationsAndBalance(account: QrisAccount, options?: AppQrisFetchOptions): Promise<AppMutationResult>;
    private _fetchPage;
    private _parsePage;
    /**
     * Ambil riwayat saldo utama dari app.orderkuota.com/api/v2/get
     * dengan requests[0]=balance & requests[balance_history][page]=N
     */
    private _appendFreshMutations;
    fetchBalanceHistory(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>): Promise<AppBalanceHistoryResult>;
    private _fetchBalancePage;
    /**
     * Ambil template QRIS statis dari OrderKuota.
     * Digunakan sebagai basis untuk generate QR dinamis dengan nominal tertentu.
     */
    fetchQrisMerchantTerms(account: QrisAccount): Promise<AppQrisMerchantTerms | null>;
    fetchQrisWithdrawTerms(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>): Promise<AppQrisWithdrawTerms | null>;
    withdrawQris(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>, amount: number): Promise<AppQrisWithdrawResult>;
    topupMadera(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>, amount: number): Promise<AppMaderaTopupResult>;
    /**
     * Fetch daftar bank yang didukung untuk transfer Madera via `action=get`.
     * Hasilnya di-cache per account selama 30 menit.
     */
    fetchMaderaBankList(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>): Promise<Record<string, {
        name: string;
        fee: number;
        status: string;
    }> | null>;
    fetchMaderaTransferOverview(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>): Promise<AppMaderaTransferOverview | null>;
    inquireBankAccount(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>, params: {
        accountNumber: string;
        amount?: number;
        bankCode: string;
        branch?: string;
        remark?: string;
        sourceWallet: 'utama' | 'madera';
    }): Promise<AppBankInquiryResult>;
    private runMaderaTransferRequest;
    private parseSimpleHtmlInputs;
    private inferPinFieldName;
    private buildBrowserHeaders;
    finalizeMaderaTransferPin(redirectUrl: string, pin: string, account?: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent'> | null): Promise<{
        success: boolean;
        message: string | null;
        raw: Record<string, unknown>;
    }>;
    private fetchSendMoneyHistory;
    transferBankFromUtama(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>, params: {
        accountNumber: string;
        amount: number;
        bankCode: string;
        branch?: string;
        remark?: string;
    }): Promise<AppBankTransferResult>;
    transferBankFromMadera(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId' | 'webCookiesEncrypted' | 'webUserAgent'>, params: {
        accountName: string;
        accountNumber: string;
        amount: number;
        bankCode: string;
        bankName?: string;
        pin?: string;
        sessionId?: string | null;
    }): Promise<AppBankTransferResult>;
    fetchQrisMutationDetail(account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>, mutationId: string | number): Promise<AppQrisMutationDetail | null>;
    generateQr(_account: QrisAccount, _finalAmount: number, _note: string): Promise<QrGenerationResult>;
    recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult>;
}
export declare const appGateway: AppOrkutGateway;
