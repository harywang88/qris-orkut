export interface DashboardGenerateQrInput {
    accountId: string;
    amount: number;
    username: string;
    createdBy: string;
}
export interface DashboardGenerateQrResult {
    transactionId: string;
    qrId: string;
    username: string;
    siteLabel: string;
    createdAt: string;
    expiresAt: string;
    amount: number;
    status: 'UNPAID';
    botLabel: '-';
    note: string;
    qrisAccount: {
        code: string;
        merchantName: string;
    };
    qrPayload: string;
    qrImageBase64: string;
}
export declare function generateDashboardQrTransaction(input: DashboardGenerateQrInput): Promise<DashboardGenerateQrResult>;
