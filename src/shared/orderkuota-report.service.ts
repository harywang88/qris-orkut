// ── Laporan ke OrderKuota (service) ──────────────────────────────────────────
// CS lapor QR yg uangnya nyangkut di OrderKuota (sudah bayar, saldo tak masuk). Bot (Fase 2)
// akan cek Uang Pending tiap 2 mnt & ambil-alih bila ada mutasi UNMATCHED (nominal+akun+RRN sama).
// Fase 1 = input + daftar. Bukti disimpan sbg file (base64 -> disk), TANPA lib upload baru.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { attemptDeposit } from './deposit.service';
import { publishMutationUpdated } from './mutation-ingest.service';

const PROOF_DIR = path.join(process.cwd(), 'data', 'uploads', 'ok-reports');
const PROOF_REL_RE = /^ok-reports\/[a-f0-9]{16,}\.(jpg|png)$/;

export type ReportStatus = 'pending' | 'processed_bot' | 'processed_manual' | 'cancelled';

export interface QrLookup {
  found: boolean;
  qrId: string;
  transactionId?: string;
  qrisAccountId?: string;
  accountCode?: string;
  amount?: number;          // finalAmount
  statusPay?: string;
  statusBot?: string;
  rrn?: string | null;
  createdAt?: Date;
  alreadyCredited?: boolean; // statusBot === deposit_success
  activeReportId?: string | null; // ada report pending utk QR ini?
  message?: string;
}

// ── Simpan bukti (raw buffer jpg/png, deteksi via magic bytes) ke disk, return path relatif ──
export function saveProofBuffer(buf: Buffer): string {
  if (!buf || buf.length < 100) throw new Error('Bukti tidak valid / kosong.');
  if (buf.length > 6 * 1024 * 1024) throw new Error('Bukti maksimal 5MB.');
  let ext = '';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = 'png';
  else throw new Error('Bukti harus gambar JPG/PNG.');
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(PROOF_DIR, name), buf);
  return 'ok-reports/' + name;
}

/** Path absolut file bukti dari path relatif tersimpan (aman dari traversal). null jika invalid. */
export function resolveProofPath(rel: string | null | undefined): string | null {
  if (!rel || !PROOF_REL_RE.test(rel)) return null;
  const abs = path.join(process.cwd(), 'data', 'uploads', rel);
  return fs.existsSync(abs) ? abs : null;
}

async function accountCodeMap(ids: string[]): Promise<Record<string, string>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return {};
  const accs = await db.qrisAccount.findMany({ where: { id: { in: uniq } }, select: { id: true, code: true, merchantName: true } });
  const out: Record<string, string> = {};
  for (const a of accs) out[a.id] = a.merchantName || a.code || a.id;
  return out;
}

// ── Lookup QR by qrId (auto-isi form) ──
export async function lookupQrForReport(qrId: string): Promise<QrLookup> {
  const q = (qrId || '').trim();
  if (!q) return { found: false, qrId: q, message: 'QR ID kosong.' };
  const tx = await db.transaction.findUnique({ where: { qrId: q } });
  if (!tx) return { found: false, qrId: q, message: 'QR ID tidak ditemukan.' };
  const codeMap = await accountCodeMap([tx.qrisAccountId]);
  const active = await db.orderKuotaReport.findFirst({
    where: { qrId: q, status: 'pending' }, select: { id: true },
  });
  return {
    found: true,
    qrId: tx.qrId,
    transactionId: tx.id,
    qrisAccountId: tx.qrisAccountId,
    accountCode: codeMap[tx.qrisAccountId] || tx.qrisAccountId,
    amount: tx.finalAmount,
    statusPay: tx.statusPay,
    statusBot: tx.statusBot,
    rrn: tx.rrn,
    createdAt: tx.createdAt,
    alreadyCredited: tx.statusBot === 'deposit_success',
    activeReportId: active ? active.id : null,
  };
}

// ── Daftar QR kandidat lapor (belum sukses kredit) utk picker ──
export interface ReportableQr {
  qrId: string; amount: number; qrisAccountId: string; accountCode: string;
  statusPay: string; statusBot: string; createdAt: Date;
}
export async function listReportableQrs(scopeAccountIds: string[] | null, limit = 60): Promise<ReportableQr[]> {
  const where: Record<string, unknown> = {
    statusBot: { not: 'deposit_success' },          // belum ke-kredit
    createdAt: { gte: new Date(Date.now() - 4 * 86400000) }, // 4 hari terakhir
  };
  if (scopeAccountIds) where.qrisAccountId = { in: scopeAccountIds };
  const txs = await db.transaction.findMany({
    where, orderBy: { createdAt: 'desc' }, take: limit,
    select: { qrId: true, finalAmount: true, qrisAccountId: true, statusPay: true, statusBot: true, createdAt: true },
  });
  const codeMap = await accountCodeMap(txs.map((t) => t.qrisAccountId));
  return txs.map((t) => ({
    qrId: t.qrId, amount: t.finalAmount, qrisAccountId: t.qrisAccountId,
    accountCode: codeMap[t.qrisAccountId] || t.qrisAccountId,
    statusPay: t.statusPay, statusBot: t.statusBot, createdAt: t.createdAt,
  }));
}

// ── Buat laporan ──
export interface CreateReportInput {
  qrId: string; rrn: string; proofBuffer: Buffer; reportedBy: string; note?: string;
  scopeAccountIds: string[] | null; // null = master
}
export interface CreateReportResult { ok: boolean; id?: string; message?: string; }

export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  const qrId = (input.qrId || '').trim();
  const rrn = (input.rrn || '').trim();
  if (!qrId) return { ok: false, message: 'QR ID wajib diisi.' };
  if (!rrn) return { ok: false, message: 'RRN wajib diisi.' };
  if (rrn.length < 4 || rrn.length > 64) return { ok: false, message: 'RRN tidak valid (4–64 karakter).' };

  const tx = await db.transaction.findUnique({ where: { qrId } });
  if (!tx) return { ok: false, message: 'QR ID tidak ditemukan.' };
  if (input.scopeAccountIds && !input.scopeAccountIds.includes(tx.qrisAccountId)) {
    return { ok: false, message: 'QR ini di luar akses akun Anda.' };
  }
  if (tx.statusBot === 'deposit_success') {
    return { ok: false, message: 'QR ini SUDAH berhasil dikredit — tak perlu dilaporkan.' };
  }
  const active = await db.orderKuotaReport.findFirst({ where: { qrId, status: 'pending' }, select: { id: true } });
  if (active) return { ok: false, message: 'QR ini sudah ada laporan yang menunggu (jangan dobel).' };

  // Simpan bukti (wajib)
  let proofPath: string;
  try { proofPath = saveProofBuffer(input.proofBuffer); }
  catch (e) { return { ok: false, message: (e as Error).message }; }

  const rep = await db.orderKuotaReport.create({
    data: {
      qrId, transactionId: tx.id, qrisAccountId: tx.qrisAccountId, amount: tx.finalAmount,
      rrn, proofPath, status: 'pending', reportedBy: input.reportedBy || 'unknown',
      note: (input.note || '').trim() || null,
    },
    select: { id: true },
  });
  return { ok: true, id: rep.id };
}

// ── Daftar laporan (filter periode + status + paginasi + scope) ──
export interface ListReportsQuery {
  scopeAccountIds: string[] | null;
  from?: Date | null; to?: Date | null;
  status?: string; // '' = semua
  page: number; pageSize: number;
}
export interface ReportRow {
  id: string; qrId: string; qrisAccountId: string; accountCode: string; amount: number;
  rrn: string; proofPath: string | null; status: string; reportedBy: string; note: string | null;
  matchedMutationId: string | null; processedBy: string | null;
  reportedAt: Date; processedAt: Date | null;
}
export interface ListReportsResult {
  rows: ReportRow[]; total: number; totalPages: number; page: number;
  counts: { pending: number; processed: number; cancelled: number; all: number };
}

export async function listReports(q: ListReportsQuery): Promise<ListReportsResult> {
  const baseWhere: Record<string, unknown> = {};
  if (q.scopeAccountIds) baseWhere.qrisAccountId = { in: q.scopeAccountIds };

  // Hitungan status (abaikan filter status, hormati scope) — utk badge tab.
  const [cntPending, cntBot, cntManual, cntCancel, cntAll] = await Promise.all([
    db.orderKuotaReport.count({ where: { ...baseWhere, status: 'pending' } }),
    db.orderKuotaReport.count({ where: { ...baseWhere, status: 'processed_bot' } }),
    db.orderKuotaReport.count({ where: { ...baseWhere, status: 'processed_manual' } }),
    db.orderKuotaReport.count({ where: { ...baseWhere, status: 'cancelled' } }),
    db.orderKuotaReport.count({ where: baseWhere }),
  ]);

  const where: Record<string, unknown> = { ...baseWhere };
  if (q.from || q.to) {
    const t: Record<string, Date> = {};
    if (q.from) t.gte = q.from;
    if (q.to) t.lte = q.to;
    where.reportedAt = t;
  }
  if (q.status === 'processed') where.status = { in: ['processed_bot', 'processed_manual'] };
  else if (q.status && ['pending', 'cancelled'].includes(q.status)) where.status = q.status;

  const total = await db.orderKuotaReport.count({ where });
  const pageSize = [10, 25, 50, 100].includes(q.pageSize) ? q.pageSize : 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, q.page || 1), totalPages);
  const recs = await db.orderKuotaReport.findMany({
    where, orderBy: { reportedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
  });
  const codeMap = await accountCodeMap(recs.map((r) => r.qrisAccountId));
  const rows: ReportRow[] = recs.map((r) => ({
    id: r.id, qrId: r.qrId, qrisAccountId: r.qrisAccountId,
    accountCode: codeMap[r.qrisAccountId] || r.qrisAccountId, amount: r.amount, rrn: r.rrn,
    proofPath: r.proofPath, status: r.status, reportedBy: r.reportedBy, note: r.note,
    matchedMutationId: r.matchedMutationId, processedBy: r.processedBy,
    reportedAt: r.reportedAt, processedAt: r.processedAt,
  }));
  return {
    rows, total, totalPages, page,
    counts: { pending: cntPending, processed: cntBot + cntManual, cancelled: cntCancel, all: cntAll },
  };
}

// ── Batalkan laporan (hanya yang masih pending) ──
export async function cancelReport(id: string, scopeAccountIds: string[] | null): Promise<{ ok: boolean; message?: string }> {
  const rep = await db.orderKuotaReport.findUnique({ where: { id } });
  if (!rep) return { ok: false, message: 'Laporan tidak ditemukan.' };
  if (scopeAccountIds && !scopeAccountIds.includes(rep.qrisAccountId)) return { ok: false, message: 'Di luar akses Anda.' };
  if (rep.status !== 'pending') return { ok: false, message: 'Hanya laporan berstatus Menunggu yang bisa dibatalkan.' };
  await db.orderKuotaReport.update({ where: { id }, data: { status: 'cancelled' } });
  return { ok: true };
}

export async function getReportForProof(id: string, scopeAccountIds: string[] | null): Promise<{ proofPath: string | null } | null> {
  const rep = await db.orderKuotaReport.findUnique({ where: { id }, select: { proofPath: true, qrisAccountId: true } });
  if (!rep) return null;
  if (scopeAccountIds && !scopeAccountIds.includes(rep.qrisAccountId)) return null;
  return { proofPath: rep.proofPath };
}

// ════════════════════════════════════════════════════════════════════════════
//  SWEEP (Fase 2) — bot cek "Uang Pending" (mutasi QRIS unmatched) tiap 2 menit.
//  Cocok RRN + nominal + akun → AMBIL ALIH: klaim mutasi (atomik) + mark QR paid
//  (paidAt = waktu uang masuk) + kredit member ke panel (attemptDeposit force) +
//  report → processed_bot. Anti-dobel berlapis (klaim atomik + idempoten deposit +
//  guard matcher normal via metadata source=orderkuota_report).
// ════════════════════════════════════════════════════════════════════════════
export interface SweepResult { checked: number; processed: number; }

/** Set metadata transaksi menandai sumber = orderkuota_report (dipakai display Uang Pending + guard matcher). */
function withOkSource(metadataJson: string | null, reportId: string, moneyInAt: Date): string {
  let m: Record<string, unknown> = {};
  try { m = metadataJson ? (JSON.parse(metadataJson) as Record<string, unknown>) : {}; } catch { m = {}; }
  m.source = 'orderkuota_report';
  m.orderkuotaReportId = reportId;
  m.moneyInAt = moneyInAt.toISOString();
  return JSON.stringify(m);
}

/** Cari 1 mutasi UNMATCHED (di Uang Pending) yg cocok report (RRN+nominal+akun). null jika belum ada. */
export async function findMatchingPendingMutation(r: { qrisAccountId: string; amount: number; rrn: string }) {
  return db.mutation.findFirst({
    where: {
      qrisAccountId: r.qrisAccountId,
      amount: r.amount,
      rrn: r.rrn,
      type: 'credit',
      walletCategory: 'qris',
      matchedTransactionId: null,
      NOT: { rawDataJson: { contains: '"status":"OUT"' } },
    },
    orderBy: { transactionTime: 'asc' },
  });
}

async function processOneReport(r: { id: string; qrId: string; qrisAccountId: string; amount: number; rrn: string }): Promise<boolean> {
  const mut = await findMatchingPendingMutation(r);
  if (!mut) return false; // uang belum masuk / belum jadi pending unmatched

  const tx = await db.transaction.findUnique({ where: { qrId: r.qrId } });
  if (!tx) {
    await db.orderKuotaReport.update({ where: { id: r.id }, data: { status: 'cancelled', note: 'QR tidak ditemukan saat proses bot' } });
    return false;
  }

  // Sudah sukses lebih dulu (jalur normal) → resolve report TANPA kredit ulang (anti-dobel).
  if (tx.statusBot === 'deposit_success') {
    await db.orderKuotaReport.update({ where: { id: r.id }, data: { status: 'processed_bot', processedBy: 'bot', processedAt: new Date(), matchedMutationId: mut.id } });
    logger.info({ reportId: r.id, qrId: r.qrId }, 'okreport: QR sudah deposit_success — resolve tanpa kredit ulang');
    return true;
  }

  // Klaim mutasi ATOMIK (guard matchedTransactionId IS NULL) + mark QR paid.
  const claimed = await db.$transaction(async (trx) => {
    const c = await trx.mutation.updateMany({ where: { id: mut.id, matchedTransactionId: null }, data: { matchedTransactionId: tx.id } });
    if (c.count !== 1) return false; // sudah diklaim pihak lain (Uang Pending/matcher) → mundur
    await trx.transaction.update({
      where: { id: tx.id },
      data: {
        statusPay: 'paid',
        statusBot: 'deposit_queued',
        paidAt: tx.paidAt ?? mut.transactionTime, // ikut WAKTU UANG MASUK
        issuerName: mut.issuerName ?? tx.issuerName,
        rrn: mut.rrn ?? tx.rrn,
        metadataJson: withOkSource(tx.metadataJson, r.id, mut.transactionTime),
      },
    });
    await trx.amountLock.updateMany({ where: { transactionId: tx.id, status: 'active' }, data: { status: 'released', activeKey: null } });
    const updated = await trx.mutation.findUniqueOrThrow({ where: { id: mut.id } });
    await publishMutationUpdated(updated, 'matched', trx); // Mutasi QRIS: pending → match (live)
    return true;
  });
  if (!claimed) return false;

  // Kredit member ke panel (force) — sama seperti tombol "Retry". Idempoten (DepositAttempt).
  try {
    await attemptDeposit(tx.id, { force: true });
  } catch (err) {
    logger.error({ err, qrId: r.qrId }, 'okreport: attemptDeposit gagal (report tetap diproses, status deposit menyusul)');
  }

  await db.orderKuotaReport.update({ where: { id: r.id }, data: { status: 'processed_bot', processedBy: 'bot', processedAt: new Date(), matchedMutationId: mut.id } });
  logger.info({ reportId: r.id, qrId: r.qrId, mutationId: mut.id, amount: r.amount }, 'okreport: DIAMBIL-ALIH + dikredit member');
  return true;
}

export async function sweepOrderkuotaReports(): Promise<SweepResult> {
  const pending = await db.orderKuotaReport.findMany({ where: { status: 'pending' }, orderBy: { reportedAt: 'asc' }, take: 100 });
  let processed = 0;
  for (const r of pending) {
    try { if (await processOneReport(r)) processed++; }
    catch (err) { logger.error({ err, reportId: r.id }, 'sweepOrderkuotaReports: gagal proses 1 report'); }
  }
  if (pending.length) logger.info({ checked: pending.length, processed }, 'okreport sweep selesai');
  return { checked: pending.length, processed };
}

/** Set kunci `rrn|amount|acct` report AKTIF (pending) — utk soft-lock di Uang Pending (cegah balapan). */
export async function activeReportKeys(): Promise<Set<string>> {
  const rows = await db.orderKuotaReport.findMany({ where: { status: 'pending' }, select: { rrn: true, amount: true, qrisAccountId: true } });
  return new Set(rows.map((r) => `${r.rrn}|${r.amount}|${r.qrisAccountId}`));
}

// ── Status live (Fase 3): jumlah pending (badge sidebar) + status per-id (deteksi flip di halaman) ──
export interface ReportStatusLive {
  count: number; // total pending dalam scope (badge)
  statuses: Record<string, { status: string; processedBy: string | null; processedAt: string | null }>;
}
export async function getReportStatuses(scopeAccountIds: string[] | null, ids: string[]): Promise<ReportStatusLive> {
  const scopeWhere: Record<string, unknown> = {};
  if (scopeAccountIds) scopeWhere.qrisAccountId = { in: scopeAccountIds };
  const count = await db.orderKuotaReport.count({ where: { ...scopeWhere, status: 'pending' } });
  const statuses: ReportStatusLive['statuses'] = {};
  if (ids.length) {
    const rows = await db.orderKuotaReport.findMany({
      where: { ...scopeWhere, id: { in: ids.slice(0, 200) } },
      select: { id: true, status: true, processedBy: true, processedAt: true },
    });
    for (const r of rows) statuses[r.id] = { status: r.status, processedBy: r.processedBy, processedAt: r.processedAt ? r.processedAt.toISOString() : null };
  }
  return { count, statuses };
}
