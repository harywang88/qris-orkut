import { db } from '../config/database';
import { logger } from '../config/logger';

export type WalletCode = 'utama' | 'madera';
export type RefType = 'deposit_success' | 'settlement_in' | 'settlement_out' | 'adjustment';

/**
 * Returns the current balance of a wallet by summing all ledger entries.
 * Returns 0 if no entries exist.
 */
export async function getWalletBalance(walletCode: WalletCode): Promise<number> {
  const result = await db.walletLedger.aggregate({
    where: { walletCode },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/**
 * Credits (positive amount) or debits (negative amount) a wallet atomically.
 * Returns the new balanceAfter value.
 */
export async function recordWalletEntry(opts: {
  walletCode: WalletCode;
  amount: number; // positive = credit, negative = debit
  refType: RefType;
  refId?: string;
  description?: string;
}): Promise<number> {
  const { walletCode, amount, refType, refId, description } = opts;

  // Compute running balance — use aggregate for correctness
  const currentBalance = await getWalletBalance(walletCode);
  const balanceAfter = currentBalance + amount;

  await db.walletLedger.create({
    data: {
      walletCode,
      amount,
      refType,
      refId: refId ?? null,
      description: description ?? null,
      balanceAfter,
    },
  });

  logger.debug({ walletCode, amount, refType, balanceAfter }, 'Wallet ledger entry created');
  return balanceAfter;
}

/**
 * Returns recent ledger entries for a wallet with pagination.
 */
export async function getWalletLedger(
  walletCode: WalletCode,
  limit = 50,
  offset = 0,
) {
  const [entries, total] = await Promise.all([
    db.walletLedger.findMany({
      where: { walletCode },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    db.walletLedger.count({ where: { walletCode } }),
  ]);
  return { entries, total };
}
