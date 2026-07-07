import { Request, Response } from 'express';
import {
  listPendingMoney,
  setPendingTag,
  removePendingTag,
} from '../../shared/pending-money.service';
import { buildResolver } from '../../shared/site.service';
import { db } from '../../config/database';
import { logger } from '../../config/logger';

export async function showPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listPendingMoney(null);
    const resolve = buildResolver();
    for (const r of rows) {
      const s = resolve(r.qrisAccountId);
      r.siteName = s && s.siteName ? s.siteName : null;
    }
    const totalPending = rows.reduce((a, r) => a + r.amount, 0);
    // Daftar Website (panel game) untuk dropdown modal Push ke Website.
    const clients = await db.client.findMany({ select: { name: true, panelCode: true }, orderBy: { name: 'asc' } });
    const websites = clients.map((c) => ({ name: c.name, code: c.panelCode || '' }));
    res.render('pending-money/index', {
      title: 'Uang Pending',
      rows,
      totalPending,
      websites,
    });
  } catch (err) {
    logger.error({ err }, 'showPendingMoney error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function handleTagPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    const mutationId = req.params.mutationId;
    const body = (req.body || {}) as {
      status?: string;
      mode?: string;
      website?: string;
      userIdExt?: string;
      note?: string;
    };
    const taggedBy = (req.session as unknown as { user?: { username?: string } }).user?.username || 'unknown';
    if (!mutationId) {
      res.status(400).json({ ok: false, message: 'mutationId kosong' });
      return;
    }
    setPendingTag(mutationId, {
      status: (body.status || '').trim() || undefined,
      mode: (body.mode || '').trim() || undefined,
      website: (body.website || '').trim() || undefined,
      userIdExt: (body.userIdExt || '').trim() || undefined,
      note: (body.note || '').trim() || undefined,
      taggedBy,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleTagPendingMoney error');
    res.status(500).json({ ok: false, message: 'gagal simpan tag' });
  }
}

export async function handleUntagPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    removePendingTag(req.params.mutationId);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleUntagPendingMoney error');
    res.status(500).json({ ok: false });
  }
}
