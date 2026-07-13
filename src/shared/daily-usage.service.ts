/**
 * Daily Usage Service — perhitungan limit harian QRIS yang REAL & VALID.
 *
 * Limit harian OrderKuota/bank = 30jt uang MASUK per hari (WIB 00:00–23:59).
 * "Uang masuk" = SEMUA mutasi KREDIT QRIS hari ini — mencakup:
 *   - yang sudah ter-match ke transaksi (paid), DAN
 *   - uang masuk yang belum ter-match (pending / bayar QR statis / double-pay).
 * Bukan hanya transaksi paid (yang bisa lebih kecil dari hitungan bank).
 *
 * Auto-off: begitu uang masuk hari ini >= 29.6jt, akun otomatis dinonaktifkan
 * supaya tak dipilih untuk QR baru (hindari tembus 30jt). Re-enable MANUAL oleh koko.
 */
import { db } from '../config/database';
import { logger } from '../config/logger';

const WIB_MS = 7 * 60 * 60 * 1000;

/** Ambang auto-off: 400rb di bawah limit default 30jt. Samakan dgn CAP di views/settlement. */
export const QRIS_AUTO_OFF_THRESHOLD = 29_600_000;

/** Awal hari ini dalam WIB (00:00 WIB) sebagai Date. */
export function todayWibStart(): Date {
  return new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
}

/**
 * Total uang MASUK QRIS hari ini (WIB) per akun = jumlah mutasi KREDIT QRIS
 * (paid + pending). Dipakai 3 menu: Status Akun QRIS, Penggunaan Harian, Limit Diterima.
 */
export async function qrisReceivedTodayMap(): Promise<Record<string, number>> {
  const start = todayWibStart();
  const agg = await db.mutation.groupBy({
    by: ['qrisAccountId'],
    where: { walletCategory: 'qris', type: 'credit', transactionTime: { gte: start }, NOT: { rawDataJson: { contains: '"status":"OUT"' } } },
    _sum: { amount: true },
  });
  const map: Record<string, number> = {};
  for (const r of agg) {
    if (r.qrisAccountId) map[r.qrisAccountId] = r._sum.amount || 0;
  }
  return map;
}

/** Total uang masuk QRIS hari ini (WIB) untuk 1 akun. */
export async function qrisReceivedTodayFor(accountId: string): Promise<number> {
  const start = todayWibStart();
  const agg = await db.mutation.aggregate({
    where: {
      qrisAccountId: accountId,
      walletCategory: 'qris',
      type: 'credit',
      transactionTime: { gte: start },
      NOT: { rawDataJson: { contains: '"status":"OUT"' } },
    },
    _sum: { amount: true },
  });
  return agg._sum.amount || 0;
}

/**
 * Auto-off: kalau uang masuk QRIS hari ini (WIB) untuk akun >= 29.6jt, set status='inactive'
 * supaya tak dipilih untuk QR baru. Re-enable MANUAL oleh koko. Return true kalau baru dimatikan.
 * dailyLimit=0 (unlimited) tidak di-auto-off.
 */
export async function enforceQrisDailyAutoOff(accountId: string): Promise<boolean> {
  const acc = await db.qrisAccount.findUnique({
    where: { id: accountId },
    select: { status: true, code: true, dailyLimit: true },
  });
  if (!acc || acc.status !== 'active') return false;
  if (!acc.dailyLimit || acc.dailyLimit === 0) return false; // 0 = unlimited

  const received = await qrisReceivedTodayFor(accountId);
  if (received < QRIS_AUTO_OFF_THRESHOLD) return false;

  await db.qrisAccount.update({ where: { id: accountId }, data: { status: 'inactive' } });
  logger.warn(
    { accountCode: acc.code, received, threshold: QRIS_AUTO_OFF_THRESHOLD },
    'AUTO-OFF: akun QRIS dinonaktifkan otomatis (limit harian ~30jt tercapai) — hidupkan manual setelah reset',
  );
  return true;
}
