"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPostgresMonitorSnapshot = getPostgresMonitorSnapshot;
const database_1 = require("../config/database");
const config_1 = require("../config");
function maskDatabaseUrl(databaseUrl) {
    try {
        const parsed = new URL(databaseUrl);
        if (parsed.password) {
            parsed.password = '****';
        }
        return parsed.toString();
    }
    catch {
        return databaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@');
    }
}
function readNumber(value) {
    if (typeof value === 'bigint')
        return Number(value);
    if (typeof value === 'number')
        return value;
    if (typeof value === 'string' && value.trim() !== '')
        return Number.parseInt(value, 10);
    return 0;
}
async function getPostgresMonitorSnapshot() {
    if (config_1.config.DATABASE_PROVIDER !== 'postgresql') {
        return {
            enabled: false,
            provider: config_1.config.DATABASE_PROVIDER,
            databaseUrlMasked: maskDatabaseUrl(config_1.config.DATABASE_URL),
            connection: {
                database: null,
                user: null,
                schema: null,
                version: null,
                host: null,
                port: null,
                databaseSize: null,
                latencyMs: 0,
            },
            sessionStore: {
                mode: 'sqlite',
                tableName: null,
                rowCount: null,
            },
            summary: {
                tableCount: 0,
                totalEstimatedRows: 0,
                mutationCount: 0,
                outboxPendingCount: 0,
                activeMerchantCount: 0,
            },
            tableStats: [],
            recentMutations: [],
            recentOutboxEvents: [],
        };
    }
    const startedAt = Date.now();
    const [connectionRows, tableRows, sessionTableRows, mutationCount, outboxPendingCount, activeMerchantCount, recentMutations, recentOutboxEvents] = await Promise.all([
        database_1.db.$queryRawUnsafe(`
          SELECT
            current_database()::text AS database,
            current_user::text AS "user",
            current_schema()::text AS schema,
            version()::text AS version,
            COALESCE(inet_server_addr()::text, '') AS host,
            inet_server_port()::int AS port,
            pg_size_pretty(pg_database_size(current_database()))::text AS "databaseSize"
        `),
        database_1.db.$queryRawUnsafe(`
          SELECT
            t.table_name::text AS "tableName",
            COALESCE(s.n_live_tup, 0)::bigint AS "estimatedRows"
          FROM information_schema.tables t
          LEFT JOIN pg_stat_user_tables s
            ON s.schemaname = t.table_schema
           AND s.relname = t.table_name
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          ORDER BY t.table_name
        `),
        database_1.db.$queryRawUnsafe(`SELECT to_regclass('public.user_sessions')::text AS "tableName"`),
        database_1.db.mutation.count(),
        database_1.db.outboxEvent.count({ where: { status: 'pending' } }),
        database_1.db.qrisAccount.count({ where: { status: 'active' } }),
        database_1.db.mutation.findMany({
            take: 10,
            orderBy: { transactionTime: 'desc' },
            select: {
                id: true,
                amount: true,
                rrn: true,
                transactionTime: true,
                qrisAccount: {
                    select: {
                        code: true,
                        merchantName: true,
                    },
                },
            },
        }),
        database_1.db.outboxEvent.findMany({
            take: 10,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                topic: true,
                status: true,
                aggregateType: true,
                aggregateId: true,
                createdAt: true,
            },
        }),
    ]);
    const sessionTableName = sessionTableRows[0]?.tableName || null;
    const sessionCountRows = sessionTableName
        ? await database_1.db.$queryRawUnsafe(`SELECT COUNT(*)::bigint AS count FROM public.user_sessions`)
        : [];
    const tableStats = tableRows.map((row) => ({
        tableName: row.tableName,
        estimatedRows: readNumber(row.estimatedRows),
    }));
    return {
        enabled: true,
        provider: config_1.config.DATABASE_PROVIDER,
        databaseUrlMasked: maskDatabaseUrl(config_1.config.DATABASE_URL),
        connection: {
            database: connectionRows[0]?.database ?? null,
            user: connectionRows[0]?.user ?? null,
            schema: connectionRows[0]?.schema ?? null,
            version: connectionRows[0]?.version ?? null,
            host: connectionRows[0]?.host || '127.0.0.1',
            port: connectionRows[0]?.port ?? 5432,
            databaseSize: connectionRows[0]?.databaseSize ?? null,
            latencyMs: Date.now() - startedAt,
        },
        sessionStore: {
            mode: 'postgresql',
            tableName: sessionTableName,
            rowCount: sessionTableName ? readNumber(sessionCountRows[0]?.count) : null,
        },
        summary: {
            tableCount: tableStats.length,
            totalEstimatedRows: tableStats.reduce((sum, row) => sum + row.estimatedRows, 0),
            mutationCount,
            outboxPendingCount,
            activeMerchantCount,
        },
        tableStats,
        recentMutations: recentMutations.map((item) => ({
            id: item.id,
            accountCode: item.qrisAccount.code,
            merchantName: item.qrisAccount.merchantName,
            amount: item.amount,
            rrn: item.rrn,
            transactionTime: item.transactionTime.toISOString(),
        })),
        recentOutboxEvents: recentOutboxEvents.map((item) => ({
            id: item.id,
            topic: item.topic,
            status: item.status,
            aggregateType: item.aggregateType,
            aggregateId: item.aggregateId,
            createdAt: item.createdAt.toISOString(),
        })),
    };
}
//# sourceMappingURL=postgres-monitor.service.js.map