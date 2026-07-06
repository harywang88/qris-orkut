import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';

dotenv.config({ path: path.join(process.cwd(), '.env') });

function resolveDatabasePath(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    throw new Error(`Only SQLite file URLs are supported, received: ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice('file:'.length).split('?')[0];

  if (!rawPath) {
    throw new Error('DATABASE_URL is missing SQLite file path');
  }

  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(process.cwd(), rawPath);
}

function openDatabase(filePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(db);
    });
  });
}

function execSql(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const shouldReset = process.argv.includes('--reset');
  const databasePath = resolveDatabasePath(databaseUrl);
  const databaseDir = path.dirname(databasePath);

  fs.mkdirSync(databaseDir, { recursive: true });

  if (shouldReset) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const target = `${databasePath}${suffix}`;
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
      }
    }
  }

  const migrationRoot = path.join(process.cwd(), 'prisma', 'migrations');
  const migrationFiles = fs
    .readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(migrationRoot, entry.name, 'migration.sql'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();

  if (!migrationFiles.length) {
    throw new Error('No migration.sql files found under prisma/migrations');
  }

  const sql = [
    'PRAGMA foreign_keys = OFF;',
    ...migrationFiles.map((filePath) => fs.readFileSync(filePath, 'utf8')),
    'PRAGMA foreign_keys = ON;',
  ].join('\n');

  const db = await openDatabase(databasePath);

  try {
    await execSql(db, sql);
  } finally {
    await closeDatabase(db);
  }

  console.log(`SQLite bootstrap completed: ${databasePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
