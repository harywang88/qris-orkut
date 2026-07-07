export type PostgresMonitorSnapshot = {
    enabled: boolean;
    provider: string;
    databaseUrlMasked: string;
    connection: {
        database: string | null;
        user: string | null;
        schema: string | null;
        version: string | null;
        host: string | null;
        port: number | null;
        databaseSize: string | null;
        latencyMs: number;
    };
    sessionStore: {
        mode: 'postgresql' | 'sqlite';
        tableName: string | null;
        rowCount: number | null;
    };
    summary: {
        tableCount: number;
        totalEstimatedRows: number;
        mutationCount: number;
        outboxPendingCount: number;
        activeMerchantCount: number;
    };
    tableStats: Array<{
        tableName: string;
        estimatedRows: number;
    }>;
    recentMutations: Array<{
        id: string;
        accountCode: string;
        merchantName: string;
        amount: number;
        rrn: string | null;
        transactionTime: string;
    }>;
    recentOutboxEvents: Array<{
        id: string;
        topic: string;
        status: string;
        aggregateType: string;
        aggregateId: string;
        createdAt: string;
    }>;
};
export declare function getPostgresMonitorSnapshot(): Promise<PostgresMonitorSnapshot>;
