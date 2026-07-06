import type { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';

/** Thrown when all 999 unique codes for an account are currently in use. */
export class AccountFullError extends Error {
  constructor(accountCode: string) {
    super(
      `QRIS account ${accountCode} has no available unique codes. All 999 slots are locked.`,
    );
    this.name = 'AccountFullError';
  }
}

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

interface ReserveOptions {
  tx: TxClient;
  qrisAccountId: string;
  accountCode: string; // for error messages
  requestedAmount: number;
  expiresAt: Date;
  transactionId: string; // pre-generated ID for the Transaction record
}

interface ReserveResult {
  uniqueCode: number;
  finalAmount: number;
  lockId: string;
}

/**
 * Phase 1: Find an available unique code for the account (read-only).
 * Must be called inside a Prisma $transaction before the Transaction record is created.
 */
export async function findUniqueCode(
  tx: TxClient,
  qrisAccountId: string,
  accountCode: string,
  requestedAmount: number,
): Promise<{ uniqueCode: number; finalAmount: number }> {
  const activeLocks = await tx.amountLock.findMany({
    where: {
      qrisAccountId,
      status: 'active',
      expiresAt: { gt: new Date() },
    },
    select: { uniqueCode: true },
  });

  const occupiedCodes = new Set(activeLocks.map((l) => l.uniqueCode));

  let uniqueCode: number | null = null;
  for (let code = 1; code <= 999; code++) {
    if (!occupiedCodes.has(code)) {
      uniqueCode = code;
      break;
    }
  }

  if (uniqueCode === null) {
    throw new AccountFullError(accountCode);
  }

  return { uniqueCode, finalAmount: requestedAmount + uniqueCode };
}

/**
 * Phase 2: Persist the AmountLock after the Transaction record already exists.
 * The Transaction must be inserted first to satisfy the FK constraint.
 */
export async function createAmountLock(
  tx: TxClient,
  opts: Omit<ReserveOptions, 'tx' | 'accountCode'> & { uniqueCode: number; finalAmount: number },
): Promise<ReserveResult> {
  const { qrisAccountId, requestedAmount, uniqueCode, finalAmount, expiresAt, transactionId } =
    opts;

  const lock = await tx.amountLock.create({
    data: {
      qrisAccountId,
      requestedAmount,
      uniqueCode,
      finalAmount,
      activeKey: `${qrisAccountId}:${finalAmount}`,
      transactionId,
      expiresAt,
      status: 'active',
    },
  });

  logger.debug({ uniqueCode, finalAmount, requestedAmount }, 'Amount lock reserved');

  return { uniqueCode, finalAmount, lockId: lock.id };
}

/**
 * Convenience wrapper: find a unique code and immediately persist the lock.
 * Only safe to call AFTER the Transaction record has been inserted in the same tx.
 */
export async function reserveUniqueCode(opts: ReserveOptions): Promise<ReserveResult> {
  const { tx, qrisAccountId, accountCode, requestedAmount, expiresAt, transactionId } = opts;

  const { uniqueCode, finalAmount } = await findUniqueCode(
    tx,
    qrisAccountId,
    accountCode,
    requestedAmount,
  );

  return createAmountLock(tx, {
    qrisAccountId,
    requestedAmount,
    uniqueCode,
    finalAmount,
    expiresAt,
    transactionId,
  });
}
