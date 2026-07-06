import type { RequestHandler } from 'express';
import session, { type SessionOptions } from 'express-session';
import ConnectSQLite3 from 'connect-sqlite3';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import { config } from './index';
import { logger } from './logger';

const SQLiteStore = ConnectSQLite3(session);
const PostgresStore = connectPgSimple(session);
const globalForSessionPool = global as unknown as { qrisSessionPool?: Pool };

const sessionDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir, { recursive: true });
}

function getSessionStore(): session.Store {
  if (config.DATABASE_PROVIDER === 'postgresql') {
    const pool =
      globalForSessionPool.qrisSessionPool ||
      new Pool({
        connectionString: config.DATABASE_URL,
        max: 5,
        idleTimeoutMillis: 30_000,
      });

    if (!globalForSessionPool.qrisSessionPool) {
      pool.on('error', (err) => {
        logger.error({ err }, 'PostgreSQL session pool error');
      });
      globalForSessionPool.qrisSessionPool = pool;
    }

    return new PostgresStore({
      pool,
      tableName: 'user_sessions',
      schemaName: 'public',
      createTableIfMissing: true,
      pruneSessionInterval: 15 * 60,
      errorLog: (...args: unknown[]) => {
        logger.error({ args }, 'PostgreSQL session store error');
      },
    }) as session.Store;
  }

  return new SQLiteStore({
    db: 'sessions.db',
    dir: sessionDir,
    concurrentDB: 'true',
  }) as session.Store;
}

export function createSessionMiddleware(): RequestHandler {
  const options: SessionOptions = {
    proxy: config.NODE_ENV === 'production',
    store: getSessionStore(),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    name: 'qris.sid',
    cookie: {
      maxAge: 8 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production' ? 'auto' : false,
    },
  };

  return session(options);
}
