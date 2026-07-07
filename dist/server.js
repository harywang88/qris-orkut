"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const config_1 = require("./config");
const database_1 = require("./config/database");
const logger_1 = require("./config/logger");
const runtime_heartbeat_1 = require("./shared/runtime-heartbeat");
async function start() {
    // Initialize database (WAL mode, pragmas)
    await (0, database_1.initDatabase)();
    const app = (0, app_1.createApp)();
    const stopHeartbeat = (0, runtime_heartbeat_1.startRuntimeHeartbeat)('qris-app', 5000, () => ({
        port: config_1.config.PORT,
        uptimeSeconds: Math.floor(process.uptime()),
    }));
    const server = app.listen(config_1.config.PORT, () => {
        logger_1.logger.info(`🚀 QRIS Dashboard running at http://localhost:${config_1.config.PORT}`);
        logger_1.logger.info(`   Environment: ${config_1.config.NODE_ENV}`);
    });
    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        logger_1.logger.info({ signal }, 'Shutdown signal received');
        stopHeartbeat();
        server.close(async () => {
            logger_1.logger.info('HTTP server closed');
            await database_1.db.$disconnect();
            logger_1.logger.info('Database disconnected');
            process.exit(0);
        });
        // Force exit after 10 seconds if server doesn't close cleanly
        setTimeout(() => {
            logger_1.logger.error('Forced shutdown after timeout');
            process.exit(1);
        }, 10000).unref();
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger_1.logger.error({ reason }, 'Unhandled Promise rejection');
    });
    process.on('uncaughtException', (err) => {
        logger_1.logger.error({ err }, 'Uncaught exception — shutting down');
        process.exit(1);
    });
}
start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map