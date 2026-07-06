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
 * Selects the most eligible QRIS account using round-robin (oldest lastAssignedAt first).
 *
 * Selection criteria:
 *   1. status = 'active'
 *   2. healthStatus = 'healthy'
 *   3. usedToday < dailyLimit (or dailyLimit = 0 for unlimited)
 *
 * After selection, updates lastAssignedAt to now() so the next call
 * picks a different account (round-robin). Must be called inside a
 * Prisma transaction to guarantee atomicity.
 *
 * @param tx  A Prisma transaction client (from db.$transaction callback).
 */
export async function selectQrisAccount(tx: TxClient): Promise<QrisAccount> {
  const accounts = await tx.qrisAccount.findMany({
    where: {
      status: 'active',
      healthStatus: 'healthy',
    },
    orderBy: { lastAssignedAt: 'asc' }, // oldest-assigned first = round-robin
  });

  const eligible = accounts.filter(
    (a) => a.dailyLimit === 0 || a.usedToday < a.dailyLimit,
  );

  if (eligible.length === 0) {
    logger.warn(
      { totalAccounts: accounts.length },
      'No eligible QRIS account found (all at limit or inactive)',
    );
    throw new NoEligibleAccountError();
  }

  const selected = eligible[0];

  // Update lastAssignedAt in the same transaction to ensure atomicity
  await tx.qrisAccount.update({
    where: { id: selected.id },
    data: { lastAssignedAt: new Date() },
  });

  logger.debug({ accountCode: selected.code }, 'QRIS account selected');
  return selected;
}

/**
 * Convenience wrapper: runs selectQrisAccount outside a transaction
 * (creates its own). Use this only when you don't need to combine it
 * with other writes atomically.
 */
export async function selectQrisAccountStandalone(): Promise<QrisAccount> {
  return db.$transaction((tx) => selectQrisAccount(tx as TxClient));
}
