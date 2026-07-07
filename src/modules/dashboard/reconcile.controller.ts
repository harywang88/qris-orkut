import { Request, Response } from 'express';
import { reconcileTransfers } from '../../shared/reconcile-transfer.service';
import { logger } from '../../config/logger';

export async function showReconcile(req: Request, res: Response): Promise<void> {
  try {
    const days = Math.min(31, Math.max(1, parseInt(String(req.query.days || '7'), 10) || 7));
    const { hop1, hop2, summary } = await reconcileTransfers(days);
    res.render('reconcile/index', { title: 'Rekonsiliasi Saldo', hop1, hop2, summary, days });
  } catch (err) {
    logger.error({ err }, 'showReconcile error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}
