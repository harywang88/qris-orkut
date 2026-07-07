export declare function getTransactionByQrId(qrId: string): Promise<({
    client: {
        name: string;
        panelCode: string;
    };
    qrisAccount: {
        code: string;
        merchantName: string;
    };
    mutations: {
        createdAt: Date;
        rrn: string | null;
        transactionTime: Date;
        issuerName: string | null;
    }[];
    depositAttempts: {
        status: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        errorMessage: string | null;
        transactionId: string;
        attemptNo: number;
        idempotencyKey: string;
        requestPayloadJson: string;
        responseCode: number | null;
        responseBody: string | null;
        nextRetryAt: Date | null;
    }[];
} & {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    note: string;
    rrn: string | null;
    qrisAccountId: string;
    issuerName: string | null;
    feeAmount: number;
    qrPayload: string;
    qrImageBase64: string;
    requestedAmount: number;
    uniqueCode: number;
    finalAmount: number;
    expiresAt: Date;
    qrId: string;
    clientId: string;
    userIdExt: string;
    externalReference: string | null;
    statusPay: string;
    statusBot: string;
    paidAt: Date | null;
    receiptUrl: string | null;
    metadataJson: string | null;
}) | null>;
export declare function listTransactions(filter?: {
    clientId?: string;
    statusPay?: string;
    statusBot?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
}): Promise<{
    transactions: ({
        client: {
            name: string;
            panelCode: string;
        };
        qrisAccount: {
            code: string;
            merchantName: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        note: string;
        rrn: string | null;
        qrisAccountId: string;
        issuerName: string | null;
        feeAmount: number;
        qrPayload: string;
        qrImageBase64: string;
        requestedAmount: number;
        uniqueCode: number;
        finalAmount: number;
        expiresAt: Date;
        qrId: string;
        clientId: string;
        userIdExt: string;
        externalReference: string | null;
        statusPay: string;
        statusBot: string;
        paidAt: Date | null;
        receiptUrl: string | null;
        metadataJson: string | null;
    })[];
    total: number;
}>;
/**
 * Lists successfully paid transactions for the Transactions dashboard page.
 */
export declare function listPaidTransactions(filter?: {
    clientId?: string;
    qrisAccountCode?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
}): Promise<{
    transactions: ({
        client: {
            name: string;
            panelCode: string;
        };
        qrisAccount: {
            code: string;
            merchantName: string;
        };
    } & {
        id: string;
        createdAt: Date;
        updatedAt: Date;
        note: string;
        rrn: string | null;
        qrisAccountId: string;
        issuerName: string | null;
        feeAmount: number;
        qrPayload: string;
        qrImageBase64: string;
        requestedAmount: number;
        uniqueCode: number;
        finalAmount: number;
        expiresAt: Date;
        qrId: string;
        clientId: string;
        userIdExt: string;
        externalReference: string | null;
        statusPay: string;
        statusBot: string;
        paidAt: Date | null;
        receiptUrl: string | null;
        metadataJson: string | null;
    })[];
    total: number;
}>;
/**
 * Manually triggers a status recheck for a transaction.
 * Worker handles actual gateway recheck; this just returns current state.
 */
export declare function recheckTransaction(qrId: string): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    note: string;
    rrn: string | null;
    qrisAccountId: string;
    issuerName: string | null;
    feeAmount: number;
    qrPayload: string;
    qrImageBase64: string;
    requestedAmount: number;
    uniqueCode: number;
    finalAmount: number;
    expiresAt: Date;
    qrId: string;
    clientId: string;
    userIdExt: string;
    externalReference: string | null;
    statusPay: string;
    statusBot: string;
    paidAt: Date | null;
    receiptUrl: string | null;
    metadataJson: string | null;
}>;
/**
 * Queues a transaction for manual deposit retry.
 * Safe to call multiple times — deposit service has idempotency key guard.
 */
export declare function queueDepositRetry(qrId: string): Promise<void>;
/**
 * Creates a mock mutation for a given open transaction (dev/simulation only).
 * The worker's mutation-poll loop will pick it up within 1.5 seconds.
 */
export declare function createSimulatedMutation(qrId: string): Promise<string>;
