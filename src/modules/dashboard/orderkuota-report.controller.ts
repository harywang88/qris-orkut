import { Request, Response } from 'express';
import { logger } from '../../config/logger';
import { logAction } from '../../shared/audit-log.service';
import { getScopeAccountIdsFromContext } from '../../core/request-context';
import { buildResolver } from '../../shared/site.service';
import {
  lookupQrForReport,
  listReportableQrs,
  createReport,
  listReports,
  cancelReport,
  getReportForProof,
  resolveProofPath,
  getReportStatuses,
} from '../../shared/orderkuota-report.service';

function sessUser(req: Request): string {
  return (req.session as unknown as { user?: { username?: string } }).user?.username || 'unknown';
}

const _WIB = 7 * 3600000;
const _sod = (d: Date) => { const w = new Date(d.getTime() + _WIB); return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), 0, 0, 0, 0) - _WIB); };
const _eod = (d: Date) => new Date(_sod(d).getTime() + 86400000 - 1);

export async function showOrderkuotaReport(req: Request, res: Response): Promise<void> {
  try {
    const scope = getScopeAccountIdsFromContext();
    // Filter periode: hari ini (default) / kemarin / semua / custom
    const period = ['today', 'yesterday', 'all', 'custom'].includes(String(req.query.period)) ? String(req.query.period) : 'today';
    const now = new Date();
    let from: Date | null = null; let to: Date | null = null; let fromValue = ''; let toValue = '';
    if (period === 'today') { from = _sod(now); to = _eod(now); }
    else if (period === 'yesterday') { const y = new Date(now.getTime() - 86400000); from = _sod(y); to = _eod(y); }
    else if (period === 'custom') {
      fromValue = typeof req.query.from === 'string' ? req.query.from : '';
      toValue = typeof req.query.to === 'string' ? req.query.to : '';
      from = fromValue ? new Date(`${fromValue}T00:00:00+07:00`) : null;
      to = toValue ? new Date(`${toValue}T23:59:59.999+07:00`) : null;
      if (from && Number.isNaN(from.getTime())) from = null;
      if (to && Number.isNaN(to.getTime())) to = null;
    }
    const status = ['pending', 'processed', 'cancelled'].includes(String(req.query.status)) ? String(req.query.status) : '';
    const _allowedPS = [10, 25, 50, 100];
    const _reqPS = parseInt(String(req.query.pageSize), 10);
    const pageSize = _allowedPS.includes(_reqPS) ? _reqPS : 25;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);

    const result = await listReports({ scopeAccountIds: scope, from, to, status, page, pageSize });
    const reportable = await listReportableQrs(scope, 60);

    // Resolve site name per baris (biar tampil akun/site seperti menu lain)
    const resolve = buildResolver();
    const rowsView = result.rows.map((r) => {
      const s = resolve(r.qrisAccountId);
      return { ...r, siteName: s && s.siteName ? s.siteName : null };
    });

    res.render('orderkuota-report/index', {
      title: 'Laporkan ke OrderKuota',
      rows: rowsView,
      counts: result.counts,
      total: result.total,
      totalPages: result.totalPages,
      page: result.page,
      pageSize,
      period,
      fromValue,
      toValue,
      status,
      reportable,
      prefillQrId: typeof req.query.qrId === 'string' ? req.query.qrId : '',
    });
  } catch (err) {
    logger.error({ err }, 'showOrderkuotaReport error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function apiLookupQr(req: Request, res: Response): Promise<void> {
  try {
    const qrId = String(req.query.qrId || '');
    const info = await lookupQrForReport(qrId);
    // Scope guard: alias tak boleh intip QR di luar akunnya
    const scope = getScopeAccountIdsFromContext();
    if (info.found && scope && info.qrisAccountId && !scope.includes(info.qrisAccountId)) {
      res.json({ found: false, qrId, message: 'QR ID di luar akses akun Anda.' });
      return;
    }
    res.json(info);
  } catch (err) {
    logger.error({ err }, 'apiLookupQr error');
    res.status(500).json({ found: false, message: 'Gagal cek QR ID.' });
  }
}

export async function handleCreateReport(req: Request, res: Response): Promise<void> {
  try {
    // Metadata via query (URL-encoded), bukti = raw binary body (express.raw). Global json/urlencoded
    // tidak menyentuh Content-Type octet-stream, jadi tak butuh naikkan limit body global.
    const qrId = String(req.query.qrId || '');
    const rrn = String(req.query.rrn || '');
    const note = String(req.query.note || '');
    const proof = req.body as Buffer;
    if (!proof || !Buffer.isBuffer(proof) || proof.length < 100) { res.status(400).json({ ok: false, message: 'Bukti transfer wajib diunggah.' }); return; }
    const scope = getScopeAccountIdsFromContext();
    const result = await createReport({
      qrId, rrn, proofBuffer: proof, note, reportedBy: sessUser(req), scopeAccountIds: scope,
    });
    if (!result.ok) { res.status(400).json(result); return; }
    void logAction(req, {
      category: 'orderkuota-report', action: 'okreport_create', severity: 'important',
      summary: 'Laporkan ke OrderKuota — QR ' + qrId.slice(0, 12) + ' · RRN ' + rrn,
      targetType: 'OrderKuotaReport', targetId: result.id, targetName: qrId,
      detail: { qrId, rrn },
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'handleCreateReport error');
    res.status(500).json({ ok: false, message: 'Gagal menyimpan laporan.' });
  }
}

export async function handleCancelReport(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id;
    const scope = getScopeAccountIdsFromContext();
    const result = await cancelReport(id, scope);
    if (!result.ok) { res.status(400).json(result); return; }
    void logAction(req, {
      category: 'orderkuota-report', action: 'okreport_cancel',
      summary: 'Batalkan laporan OrderKuota', targetType: 'OrderKuotaReport', targetId: id,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'handleCancelReport error');
    res.status(500).json({ ok: false, message: 'Gagal membatalkan.' });
  }
}

export async function apiReportStatus(req: Request, res: Response): Promise<void> {
  try {
    const scope = getScopeAccountIdsFromContext();
    const idsParam = String(req.query.ids || '');
    const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const result = await getReportStatuses(scope, ids);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'apiReportStatus error');
    res.json({ count: 0, statuses: {} });
  }
}

export async function serveProof(req: Request, res: Response): Promise<void> {
  try {
    const scope = getScopeAccountIdsFromContext();
    const rep = await getReportForProof(req.params.id, scope);
    if (!rep) { res.status(404).send('Not found'); return; }
    const abs = resolveProofPath(rep.proofPath);
    if (!abs) { res.status(404).send('Bukti tidak ada'); return; }
    res.sendFile(abs);
  } catch (err) {
    logger.error({ err }, 'serveProof error');
    res.status(500).send('Error');
  }
}
