/**
 * Deposit Sweep / Retry Loop — jalan tiap 10 detik
 *
 * Menyapu SEMUA transaksi paid yang masih `deposit_queued` (PROSES) langsung dari
 * tabel Transaction (bukan lagi dari DepositAttempt). Ini menutup lubang "orphan":
 * transaksi yang ter-set deposit_queued tapi percobaan pertamanya tidak pernah
 * tercatat (mis. worker restart di celah match->attemptDeposit) — dulu tidak
 * pernah diretry/di-escalate sehingga menggantung selamanya di PROSES.
 *
 * Aturan per transaksi:
 *   - orphan (0 attempt)            -> attemptDeposit (kalau umur > timeout -> escalate ke review di dalam)
 *   - retry terjadwal (nextRetryAt) -> attemptDeposit saat sudah waktunya
 *   - umur > 90 detik               -> attemptDeposit meng-escalate ke manual_review (TIDAK kirim)
 *
 * Transaksi yang MASIH SANGAT BARU (< 15 dtk) dilewati: itu jatah percobaan
 * langsung dari mutation-poll loop, supaya tidak ada dua percobaan bersamaan
 * (hindari dobel-kirim).
 */

import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { attemptDeposit } from '../../shared/deposit.service';

const INTERVAL_MS = 10_000;
const FRESH_SKIP_MS = 15_000;    // < 15 dtk = jatah mutation-poll, jangan disentuh sweep
const INFLIGHT_GUARD_MS = 15_000; // baru saja ada attempt -> tunggu, hindari tumpang tindih

let running = false;

async function tick(): Promise<void> {
  const now = Date.now();
  const freshCutoff = new Date(now - FRESH_SKIP_MS);

  const queued = await db.transaction.findMany({
    where: {
      statusPay: 'paid',
      statusBot: 'deposit_queued',
      paidAt: { lt: freshCutoff },
    },
    select: { id: true },
    orderBy: { paidAt: 'asc' },
    take: 200,
  });

  if (queued.length === 0) return;

  logger.info({ count: queued.length }, 'Deposit sweep: memeriksa transaksi deposit_queued');

  for (const { id } of queued) {
    try {
      const last = await db.depositAttempt.findFirst({
        where: { transactionId: id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, nextRetryAt: true, createdAt: true },
      });
      if (last) {
        if (last.status === 'success') continue;                              // sudah sukses (attemptDeposit akan sinkron)
        if (now - last.createdAt.getTime() < INFLIGHT_GUARD_MS) continue;      // baru dicoba, tunggu
        if (last.nextRetryAt && last.nextRetryAt.getTime() > now) continue;    // belum waktunya retry
      }
      // last == null (orphan) -> langsung dicoba. Umur > 90 dtk -> attemptDeposit
      // meng-escalate ke manual_review tanpa mengirim (lihat DEPOSIT_TIMEOUT_MS).
      await attemptDeposit(id);
    } catch (err) {
      logger.error({ err, transactionId: id }, 'Deposit sweep attempt error');
    }
  }
}

export function startDepositRetryLoop(): void {
  logger.info({ intervalMs: INTERVAL_MS }, 'Deposit sweep/retry loop started');

  setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch((err) => logger.error({ err }, 'Deposit sweep loop error'))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
}
