import { Request, Response } from 'express';
import { config } from '../../config';
import { logger } from '../../config/logger';
import { withBasePath } from '../../core/base-path';
import { getPostgresMonitorSnapshot } from '../../shared/postgres-monitor.service';

export async function showPostgresMonitor(req: Request, res: Response): Promise<void> {
  try {
    const snapshot = await getPostgresMonitorSnapshot();
    res.render('settings/postgres-monitor', {
      title: 'PostgreSQL Monitor',
      snapshot,
      apiUrl: withBasePath('/dashboard/api/postgres-monitor', config.APP_BASE_PATH),
    });
  } catch (err) {
    logger.error({ err }, 'showPostgresMonitor error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function getPostgresMonitorJson(req: Request, res: Response): Promise<void> {
  try {
    const snapshot = await getPostgresMonitorSnapshot();
    res.json({ ok: true, snapshot });
  } catch (err) {
    logger.error({ err }, 'getPostgresMonitorJson error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil monitor PostgreSQL' });
  }
}
