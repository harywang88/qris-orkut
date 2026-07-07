/**
 * Uang Pending — mutasi KREDIT QRIS yang belum ter-match ke transaksi
 * (matchedTransactionId = null), umur > 2 menit.
 *
 * Ini uang fisik yang masuk ke saldo tapi tak ada order-nya: bayar QR statis 2×,
 * bayar QR yang sudah kadaluarsa, dsb. Tujuan: buku tak selisih + tahu pelakunya.
 *
 * - Dugaan member: cari Transaction di HARI mutasi, akun sama, finalAmount == amount
 *   → userIdExt. Akurat karena nominal unik stabil seharian.
 * - Tag "Kaitkan ke member" (Fase A): TAG saja di JSON sidecar (data/pending-tags.json),
 *   TANPA auto-kredit — koko kredit/refund manual. Tidak mengubah DB / transaksi.
 */
import fs from 'fs';
import path from 'path';
import { db } from '../config/database';
import { logger } from '../config/logger';

const PENDING_MIN_AGE_MS = 2 * 60 * 1000; // 2 menit
const WIB_MS = 7 * 60 * 60 * 1000;
const DATA_DIR = path.join(process.cwd(), 'data');
const TAGS_FILE = path.join(DATA_DIR, 'pending-tags.json');

export interface PendingTag {
  status?: string; // 'pending' | 'claimed'
  mode?: string; // 'manual' | 'auto'
  website?: string;
  userIdExt?: string;
  note?: string;
  taggedAt: number;
  taggedBy?: string;
}
type PendingTagMap = Record<string, PendingTag>;

/** Ciri entri BUKAN pembayaran customer (uang keluar / internal): pencairan saldo QRIS. */
function isDisbursement(issuerName: string | null): boolean {
  const s = (issuerName || '').toLowerCase();
  return s.includes('pencairan');
}

// ── Pengirim: PORT PERSIS dari views/mutations/qris.ejs (getPengirim/getBank/stripNobuText) ──
// Supaya kolom Pengirim di Uang Pending IDENTIK dengan menu Mutasi QRIS ("DANA / HA******").
function stripNobuText(value: string): string {
  return String(value || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => p.toUpperCase() !== 'NOBU')
    .join(' / ');
}

function getBankLabel(raw: Record<string, unknown>, issuerName: string | null): string {
  const brand = raw.brand as { name?: string } | undefined;
  const brandName = brand && typeof brand === 'object' ? String(brand.name || '') : '';
  const desc = String(raw.description || raw.keterangan || '');
  const parts = desc.split('/').map((p) => p.trim()).filter(Boolean);
  const bankParts = [brandName, raw.bank as string, raw.bank_name as string, parts[0], issuerName]
    .filter(Boolean)
    .filter((part, index, arr) => arr.indexOf(part) === index && part !== 'Orderkuota QRIS') as string[];
  const full = bankParts.join(' / ') || 'OrderKuota';
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const p of full.split('/').map((s) => s.trim()).filter(Boolean)) {
    const k = p.toUpperCase();
    if (!seen.has(k)) { seen.add(k); uniq.push(p); }
  }
  return stripNobuText(uniq.join(' / ') || full);
}

function computePengirim(rawDataJson: string | null, issuerName: string | null): string {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(rawDataJson || '{}'); } catch { raw = {}; }
  const bankLabel = getBankLabel(raw, issuerName);
  let sender = stripNobuText(String(raw.sender_name || raw.senderName || ''));
  if (!sender) {
    const desc = String(raw.description || raw.keterangan || '');
    if (desc.includes('/')) {
      const parts = desc.split('/').map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) sender = stripNobuText(parts.slice(1).join(' / '));
    }
    if (!sender) sender = stripNobuText(desc || issuerName || 'Tidak terbaca');
  }
  if (!bankLabel) return sender || 'Tidak terbaca';
  if (!sender) return bankLabel;
  if (sender.toUpperCase() === bankLabel.toUpperCase()) return sender;
  return bankLabel + ' / ' + sender;
}

function ensureDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function readTags(): PendingTagMap {
  try {
    if (!fs.existsSync(TAGS_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as PendingTagMap) : {};
  } catch (err) {
    logger.error({ err }, 'pending-money: gagal baca tags');
    return {};
  }
}

function writeTags(map: PendingTagMap): void {
  ensureDir();
  const tmp = TAGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, TAGS_FILE);
}

export function setPendingTag(
  mutationId: string,
  tag: { status?: string; mode?: string; website?: string; userIdExt?: string; note?: string; taggedBy?: string },
): void {
  const map = readTags();
  map[mutationId] = {
    status: tag.status || 'pending',
    mode: tag.mode || undefined,
    website: tag.website || undefined,
    userIdExt: tag.userIdExt || undefined,
    note: tag.note || undefined,
    taggedBy: tag.taggedBy || undefined,
    taggedAt: Date.now(),
  };
  writeTags(map);
}

export function removePendingTag(mutationId: string): void {
  const map = readTags();
  if (map[mutationId]) {
    delete map[mutationId];
    writeTags(map);
  }
}

function wibDayRange(t: Date): { start: Date; end: Date } {
  const startMs = Math.floor((t.getTime() + WIB_MS) / 86400000) * 86400000 - WIB_MS;
  return { start: new Date(startMs), end: new Date(startMs + 86400000) };
}

export interface PendingGuess {
  userIdExt: string;
  qrId: string;
  finalAmount: number;
  requestedAmount: number;
  statusPay: string;
}

export interface PendingMoneyRow {
  id: string;
  qrisAccountId: string;
  accountCode: string;
  merchantName: string | null;
  siteName: string | null;
  amount: number;
  reqAmount: number | null; // nominal asli yang diminta member (dari transaksi tebakan)
  issuerName: string | null;
  pengirim: string; // "bank / nama pengirim" — identik menu Mutasi QRIS
  rrn: string | null;
  transactionTime: Date;
  ageMinutes: number;
  guesses: PendingGuess[];
  tag: PendingTag | null;
}

function parseOriginalAmount(metadataJson: string | null): number | null {
  if (!metadataJson) return null;
  try {
    const m = JSON.parse(metadataJson) as { originalAmount?: number };
    return typeof m.originalAmount === 'number' ? m.originalAmount : null;
  } catch {
    return null;
  }
}

/** Daftar uang pending (unmatched IN > 2 menit). accountIds opsional = filter scope. */
export async function listPendingMoney(accountIds?: string[] | null): Promise<PendingMoneyRow[]> {
  const cutoff = new Date(Date.now() - PENDING_MIN_AGE_MS);
  const where: Record<string, unknown> = {
    walletCategory: 'qris',
    type: 'credit',
    matchedTransactionId: null,
    transactionTime: { lte: cutoff },
    // HANYA uang MASUK dari customer — buang entri "Pencairan Saldo QRIS" (uang keluar/internal).
    NOT: { issuerName: { contains: 'Pencairan' } },
  };
  if (accountIds) where.qrisAccountId = { in: accountIds };

  const muts = await db.mutation.findMany({
    where,
    orderBy: { transactionTime: 'desc' },
    take: 200,
    include: { qrisAccount: { select: { code: true, merchantName: true } } },
  });

  const tags = readTags();
  const rows: PendingMoneyRow[] = [];
  for (const m of muts) {
    // Jaring pengaman kedua (kalau issuerName null tapi deskripsi mengandung pencairan lolos NOT di atas).
    if (isDisbursement(m.issuerName)) continue;

    const { start, end } = wibDayRange(m.transactionTime);
    const cands = await db.transaction.findMany({
      where: {
        qrisAccountId: m.qrisAccountId,
        finalAmount: m.amount,
        createdAt: { gte: start, lt: end },
      },
      select: { qrId: true, userIdExt: true, finalAmount: true, requestedAmount: true, metadataJson: true, statusPay: true },
      take: 5,
    });
    const guesses: PendingGuess[] = cands.map((c) => ({
      userIdExt: c.userIdExt,
      qrId: c.qrId,
      finalAmount: c.finalAmount,
      requestedAmount: parseOriginalAmount(c.metadataJson) ?? c.requestedAmount,
      statusPay: c.statusPay,
    }));
    rows.push({
      id: m.id,
      qrisAccountId: m.qrisAccountId,
      accountCode: m.qrisAccount?.code || '-',
      merchantName: m.qrisAccount?.merchantName || null,
      siteName: null,
      amount: m.amount,
      reqAmount: guesses[0] ? guesses[0].requestedAmount : null,
      issuerName: m.issuerName,
      pengirim: computePengirim(m.rawDataJson, m.issuerName),
      rrn: m.rrn,
      transactionTime: m.transactionTime,
      ageMinutes: Math.floor((Date.now() - m.transactionTime.getTime()) / 60000),
      guesses,
      tag: tags[m.id] || null,
    });
  }
  return rows;
}

/** Total uang pending (unmatched IN) dalam periode utk akun tertentu — untuk Laporan (④). */
export async function pendingMoneyTotal(
  from: Date,
  to: Date,
  accountIds?: string[] | null,
): Promise<{ total: number; count: number }> {
  const where: Record<string, unknown> = {
    walletCategory: 'qris',
    type: 'credit',
    matchedTransactionId: null,
    transactionTime: { gte: from, lte: to },
    NOT: { issuerName: { contains: 'Pencairan' } },
  };
  if (accountIds) where.qrisAccountId = { in: accountIds };
  const agg = await db.mutation.aggregate({ where, _sum: { amount: true }, _count: true });
  return { total: agg._sum.amount || 0, count: agg._count || 0 };
}
