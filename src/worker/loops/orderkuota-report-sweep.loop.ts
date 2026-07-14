/**
 * Laporkan ke OrderKuota — Sweep Loop (Fase 2)
 *
 * Tiap 2 menit: cek laporan PENDING vs "Uang Pending" (mutasi QRIS unmatched).
 * Cocok RRN + nominal + akun → AMBIL ALIH: klaim mutasi (atomik) + mark QR paid
 * (paidAt = waktu uang masuk) + kredit member ke panel (attemptDeposit force) +
 * report → processed_bot. Fire-and-forget: kegagalan tak mengganggu worker lain.
 */
import { logger } from '../../config/logger';
import { sweepOrderkuotaReports } from '../../shared/orderkuota-report.service';

const SWEEP_INTERVAL_MS = 120_000; // 2 menit (keputusan koko)

async function runSweep(): Promise<void> {
  try {
    await sweepOrderkuotaReports();
  } catch (err) {
    logger.warn({ err }, 'OrderKuota report sweep error (diisolasi)');
  }
}

export function startOrderkuotaReportSweepLoop(): void {
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'OrderKuota report sweep loop started (2 mnt)');
  void runSweep();
  setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
}
