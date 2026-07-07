import type { QrisAccount } from '@prisma/client';
type WebReportStatus = 'IN' | 'OUT';
export interface WebReportPayment {
    amount: number;
    balanceAfter: number | null;
    brand: string | null;
    raw: Record<string, unknown>;
    rrn: string | null;
    senderName: string | null;
    statusCode: WebReportStatus;
    timestamp: string | null;
    transactionTime: Date | null;
}
export interface PresentedQrisMutation {
    accountCode: string;
    amount: number;
    balanceAfter: number;
    bankEwallet: string;
    brandName: string | null;
    category: string;
    createdAt: Date;
    description: string;
    displayTime: string;
    id: string;
    issuerName: string | null;
    matched: boolean;
    merchant: string;
    rawDataJson: string;
    rrn: string | null;
    senderName: string;
    source: string;
    statusCode: string;
    statusKind: string;
    statusLabel: string;
    statusText: string;
    time: Date;
    type: string;
    siteName?: string | null;
    userIdExt?: string | null;
}
export declare function dedupePresentedQrisMutations(rows: PresentedQrisMutation[]): PresentedQrisMutation[];
export declare function enrichPresentedQrisMutationsWithWebReport(rows: PresentedQrisMutation[], payments: WebReportPayment[]): PresentedQrisMutation[];
export declare function fetchOrkutWebReportPayments(account: Pick<QrisAccount, 'code' | 'cookiesEncrypted'>, accountIndex: number): Promise<WebReportPayment[]>;
export {};
