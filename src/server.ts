import { createApp } from './app';
import { config } from './config';
import { initDatabase, db } from './config/database';
import { logger } from './config/logger';
import { startRuntimeHeartbeat } from './shared/runtime-heartbeat';

async function start(): Promise<void> {
  // Initialize database (WAL mode, pragmas)
  await initDatabase();

  const app = createApp();
  const stopHeartbeat = startRuntimeHeartbeat('qris-app', 5000, () => ({
    port: config.PORT,
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  const server = app.listen(config.PORT, () => {
    logger.info(`🚀 QRIS Dashboard running at http://localhost:${config.PORT}`);
    logger.info(`   Environment: ${config.NODE_ENV}`);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopHeartbeat();

    server.close(async () => {
      logger.info('HTTP server closed');
      await db.$disconnect();
      logger.info('Database disconnected');
      process.exit(0);
    });

    // Force exit after 10 seconds if server doesn't close cleanly
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — shutting down');
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
