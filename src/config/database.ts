import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { config } from './index';
import { getScopeAccountIdsFromContext } from '../core/request-context';

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

// Pintu BACA terpisah (read-only reader). Koneksi Prisma KEDUA ke file SQLite yang sama.
// Handler yang MURNI baca (menu mutasi/laporan) pakai `dbRead` supaya TIDAK antre di belakang
// tulisan pada koneksi tunggal `db` (connection_limit=1). WAL: banyak pembaca + 1 penulis berdampingan.
const globalForPrismaRead = global as unknown as { prismaRead: PrismaClient };
export const dbRead =
  globalForPrismaRead.prismaRead ||
  new PrismaClient({
    log: [{ emit: 'event', level: 'error' }],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrismaRead.prismaRead = dbRead;
}

// ── SCOPE GLOBAL (RBAC site-tenant): auto-filter READ query per akun-site utk alias-tenant. ──
// Sumber scope = AsyncLocalStorage (diisi middleware per-request di app.ts). master / alias "semua site"
// / worker (tanpa request) -> null -> NO-OP. Hanya READ (findMany/findFirst/count/aggregate/groupBy);
// findUnique & tulis TIDAK disentuh. where di-AND-wrap (aman thd OR). Dipasang di db (writer) DAN dbRead (reader).
const _SCOPE_FIELD: Record<string, string> = { Transaction: 'qrisAccountId', Mutation: 'qrisAccountId', QrisAccount: 'id' };
const _SCOPE_READ = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']);
function _applyScopeGuard(client: PrismaClient): void {
  client.$use(async (params, next) => {
    const field = params.model ? _SCOPE_FIELD[params.model] : undefined;
    if (field && _SCOPE_READ.has(params.action as string)) {
      const ids = getScopeAccountIdsFromContext();
      if (ids) {
        params.args = params.args || {};
        params.args.where = { AND: [params.args.where ?? {}, { [field]: { in: ids } }] };
      }
    }
    return next(params);
  });
}
_applyScopeGuard(db);
_applyScopeGuard(dbRead);

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
    // PRAGMA bersifat PER-KONEKSI: WAJIB dipasang di KEDUA client (db + dbRead). Terutama busy_timeout —
    // tanpa itu di dbRead, tulis (bila ada) langsung SQLITE_BUSY. journal_mode=WAL persist di file.
    for (const client of [db, dbRead]) {
      await client.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      await client.$queryRawUnsafe('PRAGMA synchronous=NORMAL');
      await client.$queryRawUnsafe('PRAGMA busy_timeout=15000');
    }
    await db.$queryRawUnsafe('PRAGMA cache_size=-65536');
    await dbRead.$queryRawUnsafe('PRAGMA cache_size=-16384');
    logger.info('Database initialized (WAL; db=writer, dbRead=reader terpisah)');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize database pragmas');
    throw err;
  }
}
