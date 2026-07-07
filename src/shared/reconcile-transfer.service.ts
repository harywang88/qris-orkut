/**
 * Rekonsiliasi perpindahan saldo INTERNAL: QRIS → Utama → Madera.
 *
 * Tiap uang KELUAR (OUT) dari satu saldo harus punya pasangan MASUK (IN) di saldo berikutnya.
 *   Hop 1 (QRIS → Utama):  "Pencairan Saldo QRIS" (qris OUT) ↔ "Pencairan QRIS" (utama IN)
 *      → cocok by: akun sama + nominal sama + waktu ±3 menit (nomor resi QRIS ≠ resi Utama).
 *   Hop 2 (Utama → Madera): "Pindah Saldo ke Madera" (utama OUT) ↔ "TOPUP MADERA" (madera IN)
 *      → cocok by: kode P# (OKExxx) sama + nominal sama (transfer ini GRATIS).
 *
 * Status: match (ketemu pasangan) · pending (belum ketemu, umur ≤3mnt, mungkin nyusul) ·
 *         unmatch (belum ketemu, umur >3mnt — perlu dicek).
 */
import { db } from '../config/database';

const MATCH_WINDOW_MS = 3 * 60 * 1000; // ±3 menit (Hop 1)
const PENDING_GRACE_MS = 3 * 60 * 1000; // OUT lebih muda dari ini & belum match = pending

export type ReconStatus = 'match' | 'pending' | 'unmatch';

export interface ReconRow {
  hop: 1 | 2;
  outId: string;
  accountCode: string;
  amount: number;
  outTime: Date;
  outKet: string;
  inTime: Date | null;
  inKet: string | null;
  code: string | null;
  status: ReconStatus;
}

export interface ReconSummary {
  total: number;
  match: number;
  pending: number;
  unmatch: number;
  selisih: number;
}

function parseKet(rawDataJson: string | null): string {
  try {
    const j = JSON.parse(rawDataJson || '{}') as { keterangan?: string; description?: string };
    return String(j.keterangan || j.description || '');
  } catch {
    return '';
  }
}

/** Ambil kode P# / OKExxx dari keterangan (kunci match Hop 2). */
function extractPCode(s: string): string | null {
  const m = s.match(/P#(\S+)/) || s.match(/\b(OKE\w+)\b/);
  return m ? m[1] : null;
}

function summarize(rows: ReconRow[]): ReconSummary {
  return {
    total: rows.length,
    match: rows.filter((r) => r.status === 'match').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    unmatch: rows.filter((r) => r.status === 'unmatch').length,
    selisih: rows.filter((r) => r.status !== 'match').reduce((a, r) => a + r.amount, 0),
  };
}

export async function reconcileTransfers(
  fromDays = 7,
): Promise<{ hop1: ReconRow[]; hop2: ReconRow[]; summary: { hop1: ReconSummary; hop2: ReconSummary } }> {
  const since = new Date(Date.now() - fromDays * 86400000);
  const now = Date.now();

  const accounts = await db.qrisAccount.findMany({ select: { id: true, code: true, merchantName: true } });
  const accMap: Record<string, string> = {};
  for (const a of accounts) accMap[a.id] = a.merchantName || a.code;

  // ── HOP 1: QRIS OUT (pencairan) → UTAMA IN (Pencairan QRIS) ──
  const qrisOutRaw = await db.mutation.findMany({
    where: { walletCategory: 'qris', transactionTime: { gte: since }, rawDataJson: { contains: '"status":"OUT"' } },
    orderBy: { transactionTime: 'asc' },
    take: 1000,
  });
  const outs1 = qrisOutRaw.filter((m) => parseKet(m.rawDataJson).toLowerCase().includes('pencairan'));
  const utamaIn = await db.mutation.findMany({
    where: {
      walletCategory: 'utama',
      transactionTime: { gte: since },
      type: 'credit',
      rawDataJson: { contains: 'Pencairan QRIS' },
    },
    orderBy: { transactionTime: 'asc' },
    take: 1000,
  });

  const usedIn = new Set<string>();
  const hop1: ReconRow[] = [];
  for (const o of outs1) {
    const oTime = o.transactionTime.getTime();
    let best: (typeof utamaIn)[number] | null = null;
    let bestDiff = Infinity;
    for (const i of utamaIn) {
      if (usedIn.has(i.id)) continue;
      if (i.qrisAccountId !== o.qrisAccountId || i.amount !== o.amount) continue;
      const diff = Math.abs(i.transactionTime.getTime() - oTime);
      if (diff <= MATCH_WINDOW_MS && diff < bestDiff) { best = i; bestDiff = diff; }
    }
    let status: ReconStatus;
    if (best) { usedIn.add(best.id); status = 'match'; } else status = now - oTime <= PENDING_GRACE_MS ? 'pending' : 'unmatch';
    hop1.push({
      hop: 1, outId: o.id, accountCode: accMap[o.qrisAccountId] || '-', amount: o.amount,
      outTime: o.transactionTime, outKet: parseKet(o.rawDataJson),
      inTime: best ? best.transactionTime : null, inKet: best ? parseKet(best.rawDataJson) : null,
      code: null, status,
    });
  }

  // ── HOP 2: UTAMA OUT (Pindah ke Madera) → MADERA IN (TOPUP MADERA) ──
  const utamaOut = await db.mutation.findMany({
    where: { walletCategory: 'utama', transactionTime: { gte: since }, rawDataJson: { contains: 'Pindah Saldo ke Madera' } },
    orderBy: { transactionTime: 'asc' },
    take: 1000,
  });
  const maderaIn = await db.mutation.findMany({
    where: { walletCategory: 'madera', transactionTime: { gte: since }, rawDataJson: { contains: 'TOPUP MADERA' } },
    orderBy: { transactionTime: 'asc' },
    take: 1000,
  });

  const usedM = new Set<string>();
  const hop2: ReconRow[] = [];
  for (const o of utamaOut) {
    const code = extractPCode(parseKet(o.rawDataJson));
    let best: (typeof maderaIn)[number] | null = null;
    for (const i of maderaIn) {
      if (usedM.has(i.id)) continue;
      if (i.qrisAccountId !== o.qrisAccountId || i.amount !== o.amount) continue;
      const iCode = extractPCode(parseKet(i.rawDataJson));
      if (code && iCode && code === iCode) { best = i; break; }
    }
    let status: ReconStatus;
    if (best) { usedM.add(best.id); status = 'match'; } else status = now - o.transactionTime.getTime() <= PENDING_GRACE_MS ? 'pending' : 'unmatch';
    hop2.push({
      hop: 2, outId: o.id, accountCode: accMap[o.qrisAccountId] || '-', amount: o.amount,
      outTime: o.transactionTime, outKet: parseKet(o.rawDataJson),
      inTime: best ? best.transactionTime : null, inKet: best ? parseKet(best.rawDataJson) : null,
      code, status,
    });
  }

  // urutkan: masalah (unmatch, pending) di atas, lalu terbaru
  const rank = (s: ReconStatus) => (s === 'unmatch' ? 0 : s === 'pending' ? 1 : 2);
  const sorter = (a: ReconRow, b: ReconRow) => rank(a.status) - rank(b.status) || b.outTime.getTime() - a.outTime.getTime();
  hop1.sort(sorter);
  hop2.sort(sorter);

  return { hop1, hop2, summary: { hop1: summarize(hop1), hop2: summarize(hop2) } };
}
