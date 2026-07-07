"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionMiddleware = createSessionMiddleware;
const express_session_1 = __importDefault(require("express-session"));
const connect_sqlite3_1 = __importDefault(require("connect-sqlite3"));
const connect_pg_simple_1 = __importDefault(require("connect-pg-simple"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const pg_1 = require("pg");
const index_1 = require("./index");
const logger_1 = require("./logger");
const SQLiteStore = (0, connect_sqlite3_1.default)(express_session_1.default);
const PostgresStore = (0, connect_pg_simple_1.default)(express_session_1.default);
const globalForSessionPool = global;
const sessionDir = path_1.default.join(process.cwd(), 'data');
if (!fs_1.default.existsSync(sessionDir)) {
    fs_1.default.mkdirSync(sessionDir, { recursive: true });
}
function getSessionStore() {
    if (index_1.config.DATABASE_PROVIDER === 'postgresql') {
        const pool = globalForSessionPool.qrisSessionPool ||
            new pg_1.Pool({
                connectionString: index_1.config.DATABASE_URL,
                max: 5,
                idleTimeoutMillis: 30000,
            });
        if (!globalForSessionPool.qrisSessionPool) {
            pool.on('error', (err) => {
                logger_1.logger.error({ err }, 'PostgreSQL session pool error');
            });
            globalForSessionPool.qrisSessionPool = pool;
        }
        return new PostgresStore({
            pool,
            tableName: 'user_sessions',
            schemaName: 'public',
            createTableIfMissing: true,
            pruneSessionInterval: 15 * 60,
            errorLog: (...args) => {
                logger_1.logger.error({ args }, 'PostgreSQL session store error');
            },
        });
    }
    return new SQLiteStore({
        db: 'sessions.db',
        dir: sessionDir,
        concurrentDB: 'true',
    });
}
function createSessionMiddleware() {
    const options = {
        proxy: index_1.config.NODE_ENV === 'production',
        store: getSessionStore(),
        secret: index_1.config.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        rolling: true,
        name: 'qris.sid',
        cookie: {
            maxAge: 8 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
            secure: index_1.config.NODE_ENV === 'production' ? 'auto' : false,
        },
    };
    return (0, express_session_1.default)(options);
}
//# sourceMappingURL=session.js.map