import type { Mutation } from '@prisma/client';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { publishMutationUpdated } from './mutation-ingest.service';

export type MatchResult =
  | { matched: true; transactionId: string; qrId: string }
  | { matched: false; reason: string };

const MATCH_CLOCK_SKEW_MS = 30_000;
const MATCH_EXPIRY_GRACE_MS = 60_000;

function getMutationEffectiveTime(mutation: Mutation): Date {
  return mutation.transactionTime ?? mutation.createdAt;
}

function buildTransactionWindow(effectiveTime: Date) {
  return {
    createdAt: { lte: new Date(effectiveTime.getTime() + MATCH_CLOCK_SKEW_MS) },
    expiresAt: { gte: new Date(effectiveTime.getTime() - MATCH_EXPIRY_GRACE_MS) },
  };
}

function isSuspiciousPaidTransaction(
  transaction: {
    createdAt: Date;
    expiresAt: Date;
    paidAt: Date | null;
    rrn: string | null;
    mutations: Array<{ id: string; transactionTime: Date; rrn: string | null }>;
  },
): boolean {
  if (!transaction.rrn || !transaction.paidAt) return true;

  if (transaction.paidAt.getTime() < transaction.createdAt.getTime() - MATCH_CLOCK_SKEW_MS) {
    return true;
  }

  if (transaction.paidAt.getTime() > transaction.expiresAt.getTime() + MATCH_EXPIRY_GRACE_MS) {
    return true;
  }

  if (transaction.mutations.length === 0) return true;

  return transaction.mutations.some((matchedMutation) => {
    if (!matchedMutation.rrn) return true;
    return matchedMutation.transactionTime.getTime() < transaction.createdAt.getTime() - MATCH_CLOCK_SKEW_MS;
  });
}

/**
 * Attempts to match a single mutation to an eligible transaction.
 *
 * Matching rules:
 * - same QRIS account
 * - same final amount
 * - payment time must fall inside the QR lifetime window
 *
 * Repair rules:
 * - if an older unmatched mutation had incorrectly marked a newer QR as paid,
 *   a fresh real mutation is allowed to replace that suspicious linkage
 */
export async function tryMatchMutation(mutation: Mutation): Promise<MatchResult> {
  try {
    const result = await db.$transaction(async (tx) => {
      const effectiveTime = getMutationEffectiveTime(mutation);
      const transactionWindow = buildTransactionWindow(effectiveTime);

      const freshMutation = await tx.mutation.findUnique({
        where: { id: mutation.id },
        select: { matchedTransactionId: true },
      });

      if (freshMutation?.matchedTransactionId) {
        return { matched: false as const, reason: 'already_matched' };
      }

      let targetTransaction = await tx.transaction.findFirst({
        where: {
          qrisAccountId: mutation.qrisAccountId,
          finalAmount: mutation.amount,
          statusPay: 'open',
          ...transactionWindow,
        },
        orderBy: { createdAt: 'asc' },
      });

      let replacedMutationIds: string[] = [];

      if (!targetTransaction) {
        const expiredTransaction = await tx.transaction.findFirst({
          where: {
            qrisAccountId: mutation.qrisAccountId,
            finalAmount: mutation.amount,
            statusPay: 'expired',
            ...transactionWindow,
          },
          orderBy: { createdAt: 'asc' },
        });

        if (expiredTransaction) {
          targetTransaction = expiredTransaction;
        }
      }

      if (!targetTransaction) {
        const suspiciousPaidTransactions = await tx.transaction.findMany({
          where: {
            qrisAccountId: mutation.qrisAccountId,
            finalAmount: mutation.amount,
            statusPay: 'paid',
            // Jangan pernah re-target transaksi hasil Booking Uang Pending (manual & auto)
            // ATAU hasil ambil-alih "Laporkan ke OrderKuota". Keduanya ter-link ke mutasi lama
            // (transactionTime << createdAt / paid pasca-expiry) → "terlihat suspicious"; tanpa
            // guard ini mutasi baru bisa mencuri → mutasi pending muncul lagi + memicu deposit
            // KE-2 (dobel-kredit). source=pending_booking / orderkuota_report.
            AND: [
              { NOT: { metadataJson: { contains: 'pending_booking' } } },
              { NOT: { metadataJson: { contains: 'orderkuota_report' } } },
            ],
            ...transactionWindow,
          },
          orderBy: { createdAt: 'asc' },
          take: 5,
          include: {
            mutations: {
              select: { id: true, transactionTime: true, rrn: true },
              orderBy: { transactionTime: 'asc' },
            },
          },
        });

        const suspiciousPaid = suspiciousPaidTransactions.find(isSuspiciousPaidTransaction);
        if (!suspiciousPaid) {
          return { matched: false as const, reason: 'no_matching_transaction' };
        }

        targetTransaction = suspiciousPaid;
        replacedMutationIds = suspiciousPaid.mutations
          .map((item) => item.id)
          .filter((id) => id !== mutation.id);

        if (replacedMutationIds.length > 0) {
          await tx.mutation.updateMany({
            where: { id: { in: replacedMutationIds } },
            data: { matchedTransactionId: null },
          });
        }
      }

      if (effectiveTime.getTime() > targetTransaction.expiresAt.getTime() + MATCH_EXPIRY_GRACE_MS) {
        return { matched: false as const, reason: 'transaction_expired' };
      }

      const receiptUrl = `mock://receipt/${targetTransaction.qrId}/${Date.now()}`;

      await tx.transaction.update({
        where: { id: targetTransaction.id },
        data: {
          statusPay: 'paid',
          statusBot: 'deposit_queued',
          paidAt: effectiveTime,
          issuerName: mutation.issuerName ?? null,
          rrn: mutation.rrn ?? null,
          receiptUrl,
        },
      });

      await tx.mutation.update({
        where: { id: mutation.id },
        data: { matchedTransactionId: targetTransaction.id },
      });

      const updatedMutation = await tx.mutation.findUniqueOrThrow({
        where: { id: mutation.id },
      });

      await publishMutationUpdated(updatedMutation, 'matched', tx);

      await tx.amountLock.updateMany({
        where: {
          transactionId: targetTransaction.id,
          status: 'active',
        },
        data: {
          status: 'released',
          activeKey: null,
        },
      });

      return { matched: true as const, transactionId: targetTransaction.id, qrId: targetTransaction.qrId };
    });

    if (result.matched) {
      logger.info(
        {
          mutationId: mutation.id,
          transactionId: result.transactionId,
          qrId: result.qrId,
          amount: mutation.amount,
          accountId: mutation.qrisAccountId,
        },
        'Mutation matched to transaction',
      );
    } else if (result.reason !== 'already_matched') {
      logger.warn(
        { mutationId: mutation.id, amount: mutation.amount, reason: result.reason },
        'Mutation could not be matched',
      );
    }

    return result;
  } catch (err) {
    logger.error({ err, mutationId: mutation.id }, 'tryMatchMutation error');
    throw err;
  }
}

/**
 * Fetches unmatched QRIS credit mutations from the DB for processing.
 */
export async function fetchUnmatchedMutations(limit = 20): Promise<Mutation[]> {
  return db.mutation.findMany({
    where: {
      type: 'credit',
      walletCategory: 'qris',
      matchedTransactionId: null,
    },
    orderBy: { transactionTime: 'desc' },
    take: limit,
  });
}
