import { Request, Response } from 'express';
import { db } from '../../config/database';
import { logger } from '../../config/logger';

const WIB_MS = 7 * 60 * 60 * 1000;
function wibTodayStart(): Date {
  return new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
}

type EntryWhere = {
  category?: string | null;
  actorName?: string;
  status?: string;
  severity?: string;
  createdAt?: { gte?: Date; lte?: Date; gt?: Date };
  OR?: Array<Record<string, unknown>>;
};

// Bangun klausa where dari query string (dipakai entries + export CSV).
function buildWhere(q: Request['query']): EntryWhere {
  const where: EntryWhere = {};
  const category = String(q.category || '').trim();
  const actor = String(q.actor || '').trim();
  const status = String(q.status || '').trim();
  const severity = String(q.severity || '').trim();
  const search = String(q.q || '').trim();
  const from = String(q.from || '').trim();
  const to = String(q.to || '').trim();
  const since = String(q.since || '').trim();

  if (category) where.category = category === 'lain' ? null : category;
  if (actor) where.actorName = actor;
  if (status === 'success' || status === 'failed') where.status = status;
  if (severity === 'info' || severity === 'important' || severity === 'critical') where.severity = severity;

  // Rentang tanggal + cursor live digabung (AND): live tetap hormati batas atas/bawah.
  if (from || to || since) {
    where.createdAt = {};
    if (from) { const df = new Date(from + 'T00:00:00+07:00'); if (!isNaN(df.getTime())) where.createdAt.gte = df; }
    if (to) { const dt = new Date(to + 'T23:59:59+07:00'); if (!isNaN(dt.getTime())) where.createdAt.lte = dt; }
    if (since) { const d = new Date(since); if (!isNaN(d.getTime())) where.createdAt.gt = d; }
  }

  if (search) {
    where.OR = [
      { summary: { contains: search, mode: 'insensitive' } },
      { actorName: { contains: search, mode: 'insensitive' } },
      { targetName: { contains: search, mode: 'insensitive' } },
      { action: { contains: search, mode: 'insensitive' } },
      { ipAddress: { contains: search, mode: 'insensitive' } },
    ];
  }
  return where;
}

type AuditRow = {
  id: string; userId: string | null; actorName: string | null; action: string;
  category: string | null; summary: string | null; status: string; severity: string;
  entityType: string | null; entityId: string | null; targetName: string | null;
  detailJson: string | null; ipAddress: string | null; createdAt: Date;
};

function shape(r: AuditRow): Record<string, unknown> {
  let detail: unknown = null;
  if (r.detailJson) { try { detail = JSON.parse(r.detailJson); } catch { detail = r.detailJson; } }
  return {
    id: r.id,
    actor: r.actorName,
    action: r.action,
    category: r.category || 'lain',
    summary: r.summary || r.action,
    status: r.status || 'success',
    severity: r.severity || 'info',
    targetType: r.entityType,
    targetId: r.entityId,
    targetName: r.targetName,
    ip: r.ipAddress,
    detail,
    createdAt: r.createdAt.toISOString(),
  };
}

// ── Halaman ───────────────────────────────────────────────────────────────────
export async function showAdminLog(req: Request, res: Response): Promise<void> {
  try {
    const opsRaw = await db.auditLog.findMany({
      where: { actorName: { not: null } },
      distinct: ['actorName'],
      select: { actorName: true },
      orderBy: { actorName: 'asc' },
    });
    const operators = opsRaw.map((o) => o.actorName).filter(Boolean);
    res.render('admin-log/index', { title: 'Admin Log', operators });
  } catch (err) {
    logger.error({ err }, 'showAdminLog error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── API: entri (paginated / filtered / live) ───────────────────────────────────
export async function getAdminLogEntriesApi(req: Request, res: Response): Promise<void> {
  try {
    const where = buildWhere(req.query);
    const isLive = !!String(req.query.since || '').trim();
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '30'), 10) || 30));

    if (isLive) {
      const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60 });
      res.json({ ok: true, live: true, entries: (rows as AuditRow[]).map(shape) });
      return;
    }

    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    res.json({
      ok: true,
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      entries: (rows as AuditRow[]).map(shape),
    });
  } catch (err) {
    logger.error({ err }, 'getAdminLogEntriesApi error');
    res.status(500).json({ ok: false, error: 'Gagal memuat log' });
  }
}

// ── API: statistik header + faset ──────────────────────────────────────────────
export async function getAdminLogStatsApi(req: Request, res: Response): Promise<void> {
  try {
    const todayStart = wibTodayStart();
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [total, today, critical7d, opsRaw, byCategory, bySeverity] = await Promise.all([
      db.auditLog.count(),
      db.auditLog.count({ where: { createdAt: { gte: todayStart } } }),
      db.auditLog.count({ where: { severity: 'critical', createdAt: { gte: weekAgo } } }),
      db.auditLog.findMany({ where: { actorName: { not: null } }, distinct: ['actorName'], select: { actorName: true } }),
      db.auditLog.groupBy({ by: ['category'], _count: { _all: true } }),
      db.auditLog.groupBy({ by: ['severity'], _count: { _all: true } }),
    ]);
    const catCounts: Record<string, number> = {};
    for (const c of byCategory) catCounts[c.category || 'lain'] = c._count._all;
    const sevCounts: Record<string, number> = {};
    for (const s of bySeverity) sevCounts[s.severity || 'info'] = s._count._all;
    res.json({
      ok: true,
      total,
      today,
      critical7d,
      operators: opsRaw.length,
      byCategory: catCounts,
      bySeverity: sevCounts,
    });
  } catch (err) {
    logger.error({ err }, 'getAdminLogStatsApi error');
    res.status(500).json({ ok: false, error: 'Gagal memuat statistik' });
  }
}

// ── Export CSV (menghormati filter yang sama) ──────────────────────────────────
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Netralkan formula/DDE injection (CWE-1236): awali dgn kutip-satu bila diawali pemicu formula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
}
export async function exportAdminLogCsv(req: Request, res: Response): Promise<void> {
  try {
    const where = buildWhere(req.query);
    const rows = (await db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: 5000 })) as AuditRow[];
    const header = ['Waktu (WIB)', 'Operator', 'Kategori', 'Aksi', 'Ringkasan', 'Status', 'Tingkat', 'Target', 'IP'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      const waktu = new Date(r.createdAt.getTime() + WIB_MS).toISOString().replace('T', ' ').slice(0, 19);
      lines.push([
        waktu, r.actorName, r.category || 'lain', r.action, r.summary,
        r.status, r.severity, r.targetName || r.entityId, r.ipAddress,
      ].map(csvCell).join(','));
    }
    const csv = '﻿' + lines.join('\r\n'); // BOM utk Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="admin-log-' + Date.now() + '.csv"');
    res.send(csv);
  } catch (err) {
    logger.error({ err }, 'exportAdminLogCsv error');
    res.status(500).json({ ok: false, error: 'Gagal export CSV' });
  }
}
