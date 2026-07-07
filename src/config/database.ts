import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { config } from './index';

// Singleton pattern — prevents multiple PrismaClient instances in hot-reload
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [{ emit: 'event', level: 'error' }],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}

/**
 * Initialize SQLite pragmas for optimal performance.
 * Must be called once at startup before accepting requests.
 */
export async function initDatabase(): Promise<void> {
  if (config.DATABASE_PROVIDER !== 'sqlite') {
    try {
      await db.$connect();
      const rows = await db.$queryRawUnsafe<
        Array<{
          database: string;
          user: string;
          schema: string;
        }>
      >(
        `SELECT current_database()::text AS database, current_user::text AS "user", current_schema()::text AS schema`,
      );
      logger.info(
        {
          provider: config.DATABASE_PROVIDER,
          database: rows[0]?.database ?? null,
          user: rows[0]?.user ?? null,
          schema: rows[0]?.schema ?? null,
        },
        'Database initialized',
      );
    } catch (err) {
      logger.error({ err, provider: config.DATABASE_PROVIDER }, 'Failed to connect to database');
      throw err;
    }
    return;
  }

  try {
    // WAL mode allows concurrent reads while writing (app + worker processes).
    // SQLite PRAGMAs return result sets so we use $queryRawUnsafe, not $executeRaw.
    await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
    await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
    // busy_timeout: tulis MENUNGGU lock sampai 15 dtk (app + worker + sync loop nulis ke 1 file SQLite).
    // Tanpa ini, tulis bersamaan langsung SQLITE_BUSY → Prisma P1008 "Operations timed out".
    await db.$queryRawUnsafe('PRAGMA busy_timeout=15000');
    await db.$queryRawUnsafe('PRAGMA cache_size=-65536');
    logger.info('Database initialized (WAL mode, synchronous=NORMAL)');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize database pragmas');
    throw err;
  }
}
