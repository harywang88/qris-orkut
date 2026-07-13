import { Request, Response } from 'express';
import {
  listPendingMoney,
  listBookedPendings,
  bookPendingMutation,
  setPendingTag,
  removePendingTag,
} from '../../shared/pending-money.service';
import { isShowAll } from '../../shared/operational-cutoff.service';
import { buildResolver } from '../../shared/site.service';
import { db } from '../../config/database';
import { getScopeAccountIdsFromContext } from '../../core/request-context';
import { logger } from '../../config/logger';
import { logAction } from '../../shared/audit-log.service';

export async function showPendingMoney(req: Request, res: Response): Promise<void> {
  try {
    const _all = await listPendingMoney(null, isShowAll(req));
    const lockedRows = await listBookedPendings(null, isShowAll(req));
    const resolve = buildResolver();
    for (const r of _all) {
      const s = resolve(r.qrisAccountId);
      r.siteName = s && s.siteName ? s.siteName : null;
    }
    // "Sudah Diproses": resolve site (dulu null -> selalu "Tanpa site") + paginasi terpisah.
    for (const r of lockedRows) {
      const s = resolve(r.qrisAccountId);
      r.siteName = s && s.siteName ? s.siteName : null;
    }
    const _dAllowed = [10, 50, 100];
    const _dReqPS = parseInt(String(req.query.dPageSize), 10);
    const dPageSize = _dAllowed.includes(_dReqPS) ? _dReqPS : 10;
    const dTotal = lockedRows.length;
    const dTotalPages = Math.max(1, Math.ceil(dTotal / dPageSize));
    const dPage = Math.min(Math.max(1, parseInt(String(req.query.dPage), 10) || 1), dTotalPages);
    const lockedPage = lockedRows.slice((dPage - 1) * dPageSize, dPage * dPageSize);
    // ── Filter periode (hari ini default / kemarin / semua / custom) + paginasi ──
    const _WIB = 7 * 3600000;
    const _sod = (d: Date) => { const w = new Date(d.getTime() + _WIB); return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 0, 0, 0, 0) - _WIB); };
    const _eod = (d: Date) => new Date(_sod(d).getTime() + 86400000 - 1);
    const period = ['today', 'yesterday', 'all', 'custom'].includes(String(req.query.period)) ? String(req.query.period) : 'today';
    const now = new Date();
    let _from: Date | null = null; let _to: Date | null = null; let fromValue = ''; let toValue = '';
    if (period === 'today') { _from = _sod(now); _to = _eod(now); }
    else if (period === 'yesterday') { const y = new Date(now.getTime() - 86400000); _from = _sod(y); _to = _eod(y); }
    else if (period === 'custom') {
      fromValue = typeof req.query.from === 'string' ? req.query.from : '';
      toValue = typeof req.query.to === 'string' ? req.query.to : '';
      _from = fromValue ? new Date(`${fromValue}T00:00:00+07:00`) : null;
      _to = toValue ? new Date(`${toValue}T23:59:59.999+07:00`) : null;
      if (_from && Number.isNaN(_from.getTime())) _from = null;
      if (_to && Number.isNaN(_to.getTime())) _to = null;
    }
    let _filtered = _all;
    if (_from) _filtered = _filtered.filter((r) => new Date(r.transactionTime).getTime() >= _from.getTime());
    if (_to) _filtered = _filtered.filter((r) => new Date(r.transactionTime).getTime() <= _to.getTime());
    const totalPending = _filtered.reduce((a, r) => a + r.amount, 0);
    const total = _filtered.length;
    const _allowedPS = [25, 50, 100];
    const _reqPS = parseInt(String(req.query.pageSize), 10);
    const pageSize = _allowedPS.includes(_reqPS) ? _reqPS : 25;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, parseInt(String(req.query.page), 10) || 1), totalPages);
    const rows = _filtered.slice((page - 1) * pageSize, page * pageSize);
    // Daftar Website (panel game) untuk dropdown modal Push ke Website.
    const clients = await db.client.findMany({ select: { name: true, panelCode: true }, orderBy: { name: 'asc' } });
    const websites = clients.map((c) => ({ name: c.name, code: c.panelCode || '' }));
    res.render('pending-money/index', {
      title: 'Uang Pending',
      rows,
      lockedRows: lockedPage,
      totalPending,
      websites,
      period,
      fromValue,
      toValue,
      pageSize,
      page,
      totalPages,
      total,
      dPageSize,
      dPage,
      dTotalPages,
      dTotal,
    });
  } catch (err) {
    logger.error({ err }, 'showPendingMoney error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// RBAC: alias hanya boleh sentuh mutasi (tag/untag/book) milik akun di scope-nya. master/all-alias -> true.
async function _mutInScope(mutationId: string): Promise<boolean> {
  const scope = getScopeAccountIdsFromContext();
  if (!scope) return true;
  if (!mutationId) return false;
  const m = await db.mutation.findUnique({ where: { id: mutationId }, select: { qrisAccountId: true } });
  return !!(m && m.qrisAccountId && scope.includes(m.qrisAccountId));
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
    if (!(await _mutInScope(mutationId))) { res.status(404).json({ ok: false, message: 'Mutasi tidak ditemukan' }); return; }
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
    if (!(await _mutInScope(mutationId))) { res.status(404).json({ ok: false, message: 'Mutasi tidak ditemukan' }); return; }
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
    if (!(await _mutInScope(req.params.mutationId))) { res.status(404).json({ ok: false, message: 'Mutasi tidak ditemukan' }); return; }
    removePendingTag(req.params.mutationId);
    void logAction(req, { category: 'pending', action: 'pending_untag', summary: 'Hapus tag Uang Pending', targetType: 'Mutation', targetId: req.params.mutationId });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleUntagPendingMoney error');
    res.status(500).json({ ok: false });
  }
}
