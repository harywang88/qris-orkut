type LiveCheck = {
    ok: boolean;
    label: string;
    detail: string;
};
export type MerchantConnectionReport = {
    success: boolean;
    mode: 'app' | 'web' | 'payload-only' | 'unconfigured';
    account: {
        id: string;
        code: string;
        merchantName: string;
        accountNumber: string;
        status: string;
    };
    readiness: {
        hasSessionToken: boolean;
        hasCookies: boolean;
        hasWebCookies: boolean;
        hasDeviceId: boolean;
        hasPayload: boolean;
        generateReady: boolean;
        mutationReady: boolean;
    };
    checks: LiveCheck[];
    message: string;
};
export type MerchantSyncReport = MerchantConnectionReport & {
    stats: {
        newQrisMutations: number;
        newUtamaMutations: number;
        detailRefreshed: number;
        matchedTransactions: number;
        mainBalance: number | null;
        qrisBalance: number | null;
        maderaBalance: number | null;
        payloadRefreshed: boolean;
    };
};
export type ReportLoginTestReport = {
    success: boolean;
    message: string;
    normalized: {
        cookie: string | null;
        userAgent: string | null;
    };
    badges: Array<{
        key: 'qris' | 'utama' | 'session' | 'cookie';
        label: string;
        ok: boolean;
        detail: string;
    }>;
    preview: {
        accountName: string | null;
        mainBalance: number | null;
        qrisBalance: number | null;
        qrisCount: number;
        utamaCount: number;
        qrisPagesRead: number | null;
        utamaPagesRead: number | null;
    };
    detectedPattern: {
        qris: string | null;
        utama: string | null;
    };
};
export type SourceComparisonReport = {
    success: boolean;
    message: string;
    mode: 'app' | 'web' | 'hybrid' | 'unconfigured';
    report: {
        ok: boolean;
        accountName: string | null;
        mainBalance: number | null;
        qrisBalance: number | null;
        qrisCount: number;
        utamaCount: number;
        qrisPagesRead: number | null;
        utamaPagesRead: number | null;
        detectedPattern: {
            qris: string | null;
            utama: string | null;
        };
    };
    live: {
        ok: boolean;
        mainBalance: number | null;
        qrisBalance: number | null;
        qrisCount: number;
        utamaCount: number;
    };
    delta: {
        mainBalanceDiff: number | null;
        qrisBalanceDiff: number | null;
        qrisCountDiff: number | null;
        utamaCountDiff: number | null;
    };
};
export declare function testReportLogin(input: {
    rawHeaders?: string | null;
    webCookies?: string | null;
    webUserAgent?: string | null;
}): Promise<ReportLoginTestReport>;
export declare function compareReportVsLiveSources(input: {
    rawHeaders?: string | null;
    webCookies?: string | null;
    webUserAgent?: string | null;
    sessionToken?: string | null;
    cookies?: string | null;
    deviceId?: string | null;
}): Promise<SourceComparisonReport>;
export declare function testMerchantConnection(id: string): Promise<MerchantConnectionReport>;
export declare function syncMerchantNow(id: string): Promise<MerchantSyncReport>;
export {};
