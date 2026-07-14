import { Request, Response } from 'express';
import { reconcileTransfers, type ReconRow } from '../../shared/reconcile-transfer.service';
import { isShowAll } from '../../shared/operational-cutoff.service';
import { db } from '../../config/database';
import { siteNameForAccount, siteIdForAccount, listSites } from '../../shared/site.service';
import { logger } from '../../config/logger';

const WIB = 7 * 3600000;
function wibStartOfDay(d: Date): Date {
  const w = new Date(d.getTime() + WIB);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 0, 0, 0, 0) - WIB);
}
function wibEndOfDay(d: Date): Date {
  return new Date(wibStartOfDay(d).getTime() + 86400000 - 1);
}

export async function showReconcile(req: Request, res: Response): Promise<void> {
  try {
    const hop: 1 | 2 = String(req.query.hop) === '2' ? 2 : 1;
    const period = ['today', 'yesterday', 'custom'].includes(String(req.query.period))
      ? String(req.query.period)
      : 'today';
    const now = new Date();
    let from: Date | null = null;
    let to: Date | null = null;
    let fromValue = '';
    let toValue = '';
    if (period === 'today') {
      from = wibStartOfDay(now);
      to = wibEndOfDay(now);
    } else if (period === 'yesterday') {
      const y = new Date(now.getTime() - 86400000);
      from = wibStartOfDay(y);
      to = wibEndOfDay(y);
    } else {
      fromValue = typeof req.query.from === 'string' ? req.query.from : '';
      toValue = typeof req.query.to === 'string' ? req.query.to : '';
      from = fromValue ? new Date(`${fromValue}T00:00:00+07:00`) : null;
      to = toValue ? new Date(`${toValue}T23:59:59.999+07:00`) : null;
      if (from && Number.isNaN(from.getTime())) from = null;
      if (to && Number.isNaN(to.getTime())) to = null;
    }

    const accountCode = typeof req.query.accountCode === 'string' ? req.query.accountCode.trim() : '';
    const site = typeof req.query.site === 'string' ? req.query.site.trim() : '';
    const nominalRaw = typeof req.query.nominal === 'string' ? req.query.nominal : '';
    const nominal = parseInt(nominalRaw.replace(/[^\d]/g, ''), 10) || 0;
    const status = ['match', 'pending', 'unmatch'].includes(String(req.query.status))
      ? String(req.query.status)
      : '';

    const allowedPS = [25, 50, 100, 200, 500];
    const reqPS = parseInt(String(req.query.pageSize), 10);
    const pageSize = allowedPS.includes(reqPS) ? reqPS : 25;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);

    // Rentang hari untuk reconcileTransfers (cukup mencakup filter tanggal).
    let days = 2;
    if (from) {
      const diff = Math.ceil((now.getTime() - from.getTime()) / 86400000) + 1;
      days = Math.min(31, Math.max(1, diff));
    }

    const { hop1, hop2 } = await reconcileTransfers(days, isShowAll(req));
    // Peta akun -> site (rows pakai accountCode). Enrich siteName/siteId utk kolom + filter Site.
    const accounts = await db.qrisAccount.findMany({ select: { id: true, code: true, merchantName: true }, orderBy: { code: 'asc' } });
    let rows: (ReconRow & { siteName: string; siteId: string })[] = (hop === 2 ? hop2 : hop1).map((r) => ({ ...r, siteName: siteNameForAccount(r.accountId) || '', siteId: siteIdForAccount(r.accountId) || '' }));
    if (from) rows = rows.filter((r) => new Date(r.outTime).getTime() >= from!.getTime());
    if (to) rows = rows.filter((r) => new Date(r.outTime).getTime() <= to!.getTime());
    if (accountCode) rows = rows.filter((r) => r.accountCode === accountCode);
    if (site) rows = rows.filter((r) => r.siteId === site);
    if (nominal) rows = rows.filter((r) => r.amount === nominal);
    if (status) rows = rows.filter((r) => r.status === status);

    const summary = {
      total: rows.length,
      match: rows.filter((r) => r.status === 'match').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      unmatch: rows.filter((r) => r.status === 'unmatch').length,
      selisih: rows.filter((r) => r.status !== 'match').reduce((a, r) => a + r.amount, 0),
    };

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const curPage = Math.min(page, totalPages);
    const pageRows = rows.slice((curPage - 1) * pageSize, curPage * pageSize);

    res.render('reconcile/index', {
      title: 'Rekonsiliasi Saldo',
      hop,
      period,
      fromValue,
      toValue,
      accountCode,
      nominal: nominalRaw,
      status,
      pageSize,
      page: curPage,
      totalPages,
      total,
      rows: pageRows,
      summary,
      accounts,
      site,
      sites: listSites().map((s) => ({ id: s.id, name: s.name })),
    });
  } catch (err) {
    logger.error({ err }, 'showReconcile error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}
