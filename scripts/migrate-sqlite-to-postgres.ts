import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import sqlite3 from 'sqlite3';
import { Client } from 'pg';

dotenv.config({ path: path.join(process.cwd(), '.env'), override: true });

type SqliteRow = Record<string, unknown>;
type SqliteColumn = { name: string };
type PostgresColumn = { column_name: string; data_type: string };

const TABLE_COPY_ORDER = [
  'Permission',
  'Role',
  'User',
  'Client',
  'QrisAccount',
  'RolePermission',
  'UserRole',
  'Transaction',
  'AmountLock',
  'Mutation',
  'OutboxEvent',
  'DepositAttempt',
  'SettlementRequest',
  'SettlementItem',
  'LoginLog',
  'AuditLog',
  'WalletLedger',
  'RequestNonce',
] as const;

function resolveSqlitePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(`SQLITE_SOURCE_URL harus berupa file:, diterima: ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice('file:'.length).split('?')[0];
  if (!rawPath) {
    throw new Error('SQLITE_SOURCE_URL tidak punya path file');
  }

  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function openSqlite(filePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(db);
    });
  });
}

function sqliteAll<T = SqliteRow>(db: sqlite3.Database, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve((rows as T[]) ?? []);
    });
  });
}

function closeSqlite(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function normalizeValue(value: unknown, dataType: string): unknown {
  if (value === undefined || value === null) return null;

  if (dataType === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === '1' || normalized === 'true' || normalized === 't';
    }
  }

  if (dataType === 'integer' || dataType === 'smallint' || dataType === 'bigint') {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
    if (typeof value === 'string' && value.trim() !== '') return Number.parseInt(value, 10);
  }

  if (dataType.includes('timestamp')) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const epochMs = value > 9_999_999_999 ? value : value * 1000;
      return new Date(epochMs).toISOString();
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d{10,13}$/.test(trimmed)) {
        const numeric = Number.parseInt(trimmed, 10);
        const epochMs = trimmed.length >= 13 ? numeric : numeric * 1000;
        return new Date(epochMs).toISOString();
      }
      return trimmed;
    }
  }

  return value;
}

async function tableExistsInSqlite(db: sqlite3.Database, tableName: string): Promise<boolean> {
  const rows = await sqliteAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}'`,
  );
  return rows.length > 0;
}

async function getSqliteColumns(db: sqlite3.Database, tableName: string): Promise<string[]> {
  const rows = await sqliteAll<SqliteColumn>(db, `PRAGMA table_info("${tableName}")`);
  return rows.map((row) => row.name);
}

async function getPostgresColumns(client: Client, tableName: string): Promise<PostgresColumn[]> {
  const result = await client.query<PostgresColumn>(
    `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return result.rows;
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SQLITE_SOURCE_URL || 'file:./prisma/data/dev.db';
  const targetUrl = process.env.DATABASE_URL;
  const provider = process.env.DATABASE_PROVIDER;

  if (provider !== 'postgresql') {
    throw new Error(`DATABASE_PROVIDER harus postgresql, diterima: ${provider ?? '(kosong)'}`);
  }

  if (!targetUrl) {
    throw new Error('DATABASE_URL wajib diisi');
  }

  const sqlitePath = resolveSqlitePath(sourceUrl);
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`File SQLite source tidak ditemukan: ${sqlitePath}`);
  }

  const sqlite = await openSqlite(sqlitePath);
  const pg = new Client({ connectionString: targetUrl });

  console.log(`Source SQLite  : ${sqlitePath}`);
  console.log(`Target Postgres: ${targetUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:****@')}`);

  try {
    await pg.connect();
    await pg.query('BEGIN');

    const truncateTargets = [...TABLE_COPY_ORDER].reverse().map((tableName) => `"${tableName}"`).join(', ');
    await pg.query(`TRUNCATE TABLE ${truncateTargets} RESTART IDENTITY CASCADE`);

    for (const tableName of TABLE_COPY_ORDER) {
      const exists = await tableExistsInSqlite(sqlite, tableName);
      if (!exists) {
        console.log(`- Skip ${tableName}: tabel tidak ada di SQLite source`);
        continue;
      }

      const rows = await sqliteAll<SqliteRow>(sqlite, `SELECT * FROM "${tableName}"`);
      if (!rows.length) {
        console.log(`- Skip ${tableName}: 0 row`);
        continue;
      }

      const sqliteColumns = await getSqliteColumns(sqlite, tableName);
      const postgresColumns = await getPostgresColumns(pg, tableName);
      const postgresColumnMap = new Map(postgresColumns.map((column) => [column.column_name, column.data_type]));
      const commonColumns = sqliteColumns.filter((column) => postgresColumnMap.has(column));

      if (!commonColumns.length) {
        console.log(`- Skip ${tableName}: tidak ada kolom yang cocok`);
        continue;
      }

      const columnSql = commonColumns.map((column) => `"${column}"`).join(', ');
      const placeholderSql = commonColumns.map((_, index) => `$${index + 1}`).join(', ');
      const insertSql = `INSERT INTO "${tableName}" (${columnSql}) VALUES (${placeholderSql})`;

      for (const row of rows) {
        const values = commonColumns.map((column) =>
          normalizeValue(row[column], postgresColumnMap.get(column) ?? 'text'),
        );
        await pg.query(insertSql, values);
      }

      console.log(`- Copied ${tableName}: ${rows.length} row`);
    }

    await pg.query('COMMIT');
    console.log('Migrasi SQLite -> PostgreSQL selesai.');
  } catch (error) {
    await pg.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await closeSqlite(sqlite);
    await pg.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
