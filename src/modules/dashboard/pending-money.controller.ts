import { Request, Response } from 'express';
import {
  listPendingMoney,
  listBookedPendings,
  bookPendingMutation,
  setPendingTag,
  removePendingTag,
} from '../../shared/pending-money.service';
import { buildResolver } from '../../shared/site.service';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { logAction } from '../../shared/audit-log.service';

export async function showPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    const rows = await listPendingMoney(null);
    const lockedRows = await listBookedPendings(null);
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
      lockedRows,
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
    void logAction(req, { category: 'pending', action: 'pending_tag', summary: 'Tag Uang Pending' + (body.userIdExt ? (' \u2014 user ' + body.userIdExt) : '') + (body.website ? (' @ ' + body.website) : ''), targetType: 'Mutation', targetId: mutationId, detail: { status: body.status, mode: body.mode, website: body.website, userIdExt: body.userIdExt } });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleTagPendingMoney error');
    res.status(500).json({ ok: false, message: 'gagal simpan tag' });
  }
}

export async function handleBookPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    const mutationId = req.params.mutationId;
    const body = (req.body || {}) as { website?: string; userIdExt?: string; note?: string; mode?: string };
    const processedBy = (req.session as unknown as { user?: { username?: string } }).user?.username || 'unknown';
    if (!mutationId) {
      res.status(400).json({ ok: false, message: 'mutationId kosong' });
      return;
    }
    const website = (body.website || '').trim();
    if (!website) {
      res.status(400).json({ ok: false, message: 'Website wajib dipilih.' });
      return;
    }
    const result = await bookPendingMutation(mutationId, {
      website,
      userIdExt: (body.userIdExt || '').trim(),
      note: (body.note || '').trim(),
      mode: (body.mode || 'manual').trim() || 'manual',
      processedBy,
    });
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    void logAction(req, {
      category: 'pending',
      action: 'pending_book',
      severity: 'important',
      summary: 'Booking Uang Pending → Transaksi' + (website ? (' @ ' + website) : '') + (body.userIdExt ? (' — user ' + body.userIdExt) : ''),
      targetType: 'Mutation',
      targetId: mutationId,
      targetName: result.transactionId,
      detail: { website, userIdExt: body.userIdExt, mode: body.mode || 'manual', transactionId: result.transactionId },
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'handleBookPendingMoney error');
    res.status(500).json({ ok: false, message: 'Gagal membukukan uang pending.' });
  }
}

export async function handleUntagPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    removePendingTag(req.params.mutationId);
    void logAction(req, { category: 'pending', action: 'pending_untag', summary: 'Hapus tag Uang Pending', targetType: 'Mutation', targetId: req.params.mutationId });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleUntagPendingMoney error');
    res.status(500).json({ ok: false });
  }
}
