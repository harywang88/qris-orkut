"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.initDatabase = initDatabase;
const client_1 = require("@prisma/client");
const logger_1 = require("./logger");
const index_1 = require("./index");
// Singleton pattern — prevents multiple PrismaClient instances in hot-reload
const globalForPrisma = global;
exports.db = globalForPrisma.prisma ||
    new client_1.PrismaClient({
        log: process.env.NODE_ENV === 'development'
            ? [
                { emit: 'event', level: 'warn' },
                { emit: 'event', level: 'error' },
            ]
            : [{ emit: 'event', level: 'error' }],
    });
if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = exports.db;
}
/**
 * Initialize SQLite pragmas for optimal performance.
 * Must be called once at startup before accepting requests.
 */
async function initDatabase() {
    if (index_1.config.DATABASE_PROVIDER !== 'sqlite') {
        try {
            await exports.db.$connect();
            const rows = await exports.db.$queryRawUnsafe(`SELECT current_database()::text AS database, current_user::text AS "user", current_schema()::text AS schema`);
            logger_1.logger.info({
                provider: index_1.config.DATABASE_PROVIDER,
                database: rows[0]?.database ?? null,
                user: rows[0]?.user ?? null,
                schema: rows[0]?.schema ?? null,
            }, 'Database initialized');
        }
        catch (err) {
            logger_1.logger.error({ err, provider: index_1.config.DATABASE_PROVIDER }, 'Failed to connect to database');
            throw err;
        }
        return;
    }
    try {
        // WAL mode allows concurrent reads while writing (app + worker processes).
        // SQLite PRAGMAs return result sets so we use $queryRawUnsafe, not $executeRaw.
        await exports.db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
        await exports.db.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
        // busy_timeout: tulis MENUNGGU lock sampai 15 dtk (app + worker + sync loop nulis ke 1 file SQLite).
        // Tanpa ini, tulis bersamaan langsung SQLITE_BUSY → Prisma P1008 "Operations timed out".
        await exports.db.$queryRawUnsafe('PRAGMA busy_timeout=15000');
        await exports.db.$queryRawUnsafe('PRAGMA cache_size=-65536');
        logger_1.logger.info('Database initialized (WAL mode, synchronous=NORMAL)');
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Failed to initialize database pragmas');
        throw err;
    }
}
//# sourceMappingURL=database.js.map