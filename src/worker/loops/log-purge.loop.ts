/**
 * Log Purge Loop — Admin Log Fase 1
 *
 * Auto-hapus catatan log lama (audit_log + login_log) yang lebih tua dari
 * RETENTION_DAYS supaya DB tetap ramping. Jalan saat start + tiap 6 jam.
 * Fire-and-forget: kegagalan tak mengganggu worker lain.
 */

import { db } from '../../config/database';
import { logger } from '../../config/logger';

const RETENTION_DAYS = 90;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 jam

async function purgeOldLogs(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const audit = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    const login = await db.loginLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (audit.count > 0 || login.count > 0) {
      logger.info(
        { auditDeleted: audit.count, loginDeleted: login.count, retentionDays: RETENTION_DAYS },
        'Log purge: hapus catatan lama',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Log purge error (diisolasi)');
  }
}

export function startLogPurgeLoop(): void {
  logger.info({ retentionDays: RETENTION_DAYS, intervalHours: 6 }, 'Log purge loop started');
  void purgeOldLogs();
  setInterval(() => void purgeOldLogs(), PURGE_INTERVAL_MS);
}
