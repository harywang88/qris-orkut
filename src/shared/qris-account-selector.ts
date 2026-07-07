import type { QrisAccount, PrismaClient } from '@prisma/client';
import { db } from '../config/database';
import { logger } from '../config/logger';

/** Thrown when no QRIS account is available for assignment. */
export class NoEligibleAccountError extends Error {
  constructor() {
    super(
      'No eligible QRIS account available. All accounts may be inactive, unhealthy, or at daily limit.',
    );
    this.name = 'NoEligibleAccountError';
  }
}

// Prisma transaction client type
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Round-robin: pilih akun QRIS yang paling lama tak dipakai (lastAssignedAt asc = giliran).
 *
 * Kriteria LAYAK (skip yang tak layak):
 *   1. status = 'active'          (akun yang di-OFF/nonaktif dilewati)
 *   2. healthStatus = 'healthy'   (akun bermasalah: login expired / rate-limit — dilewati)
 *   3. usedToday < dailyLimit     (akun yang sudah tembus limit harian — dilewati; 0 = unlimited)
 *
 * @param restrictAccountIds  Batasi giliran ke akun-akun ini saja (mis. akun 1 site). Kalau array
 *   (termasuk kosong) → hanya akun tsb; kalau null/undefined → semua akun. Array kosong = tak ada layak.
 *
 * Update lastAssignedAt = now() untuk akun terpilih → giliran berikutnya dapat akun lain (merata).
 * Wajib dipanggil di dalam transaksi Prisma agar atomik.
 */
export async function selectQrisAccount(
  tx: TxClient,
  restrictAccountIds?: string[] | null,
): Promise<QrisAccount> {
  const accounts = await tx.qrisAccount.findMany({
    where: {
      status: 'active',
      healthStatus: 'healthy',
      ...(restrictAccountIds ? { id: { in: restrictAccountIds } } : {}),
    },
    orderBy: { lastAssignedAt: 'asc' }, // paling lama tak dipakai = giliran
  });

  const eligible = accounts.filter((a) => a.dailyLimit === 0 || a.usedToday < a.dailyLimit);

  if (eligible.length === 0) {
    logger.warn(
      { totalAccounts: accounts.length, scoped: !!restrictAccountIds },
      'No eligible QRIS account found (all at limit, off, or unhealthy)',
    );
    throw new NoEligibleAccountError();
  }

  const selected = eligible[0];
  await tx.qrisAccount.update({
    where: { id: selected.id },
    data: { lastAssignedAt: new Date() },
  });

  logger.debug({ accountCode: selected.code }, 'QRIS account selected (round-robin)');
  return selected;
}

/** Round-robin global (semua akun) di transaksi sendiri. */
export async function selectQrisAccountStandalone(): Promise<QrisAccount> {
  return db.$transaction((tx) => selectQrisAccount(tx as TxClient));
}

/** Round-robin khusus 1 site — dipakai Generate QR auto (giliran per site). */
export async function selectQrisAccountForSite(accountIds: string[]): Promise<QrisAccount> {
  return db.$transaction((tx) => selectQrisAccount(tx as TxClient, accountIds));
}
