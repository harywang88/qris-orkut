import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { storeMutationIfNew } from '../../shared/mutation-ingest.service';

async function hydrateTransactionReferenceFields<
  T extends {
    id: string;
    statusPay: string;
    rrn: string | null;
    issuerName: string | null;
    paidAt: Date | null;
    mutations?: Array<{
      rrn: string | null;
      issuerName: string | null;
      transactionTime: Date;
      createdAt?: Date;
    }>;
  },
>(tx: T): Promise<T> {
  if (tx.statusPay !== 'paid' || !tx.mutations?.length) {
    return tx;
  }

  const fallbackMutation = tx.mutations.find((mutation) => mutation.rrn || mutation.issuerName) ?? tx.mutations[0];
  if (!fallbackMutation) {
    return tx;
  }

  const patch: { rrn?: string; issuerName?: string; paidAt?: Date } = {};
  if (!tx.rrn && fallbackMutation.rrn) patch.rrn = fallbackMutation.rrn;
  if (!tx.issuerName && fallbackMutation.issuerName) patch.issuerName = fallbackMutation.issuerName;
  if (!tx.paidAt && fallbackMutation.transactionTime) patch.paidAt = fallbackMutation.transactionTime;

  if (Object.keys(patch).length === 0) {
    return tx;
  }

  await db.transaction.update({
    where: { id: tx.id },
    data: patch,
  });

  return {
    ...tx,
    ...patch,
  };
}

export async function getTransactionByQrId(qrId: string) {
  const tx = await db.transaction.findUnique({
    where: { qrId },
    include: {
      client: { select: { name: true, panelCode: true } },
      qrisAccount: { select: { code: true, merchantName: true } },
      depositAttempts: { orderBy: { createdAt: 'desc' }, take: 5 },
      mutations: {
        select: { rrn: true, issuerName: true, transactionTime: true, createdAt: true },
        orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
        take: 3,
      },
    },
  });
  if (!tx) return null;
  return hydrateTransactionReferenceFields(tx);
}

export async function listTransactions(filter?: {
  clientId?: string;
  statusPay?: string;
  statusBot?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const where: Record<string, unknown> = {};

  if (filter?.clientId) where.clientId = filter.clientId;
  if (filter?.statusPay) where.statusPay = filter.statusPay;
  if (filter?.statusBot) where.statusBot = filter.statusBot;

  if (filter?.from || filter?.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter?.limit ?? 50,
      skip: filter?.offset ?? 0,
      include: {
        client: { select: { name: true, panelCode: true } },
        qrisAccount: { select: { code: true, merchantName: true } },
      },
    }),
    db.transaction.count({ where }),
  ]);

  return { transactions, total };
}

/**
 * Lists successfully paid transactions for the Transactions dashboard page.
 */
export async function listPaidTransactions(filter?: {
  clientId?: string;
  qrisAccountCode?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}) {
  const where: Record<string, unknown> = { statusPay: 'paid' };

  if (filter?.clientId) where.clientId = filter.clientId;
  if (filter?.qrisAccountCode) {
    where.qrisAccount = { code: filter.qrisAccountCode };
  }
  if (filter?.from || filter?.to) {
    where.paidAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: filter?.limit ?? 50,
      skip: filter?.offset ?? 0,
      include: {
        client: { select: { name: true, panelCode: true } },
        qrisAccount: { select: { code: true, merchantName: true } },
      },
    }),
    db.transaction.count({ where }),
  ]);

  return { transactions, total };
}

/**
 * Manually triggers a status recheck for a transaction.
 * Worker handles actual gateway recheck; this just returns current state.
 */
export async function recheckTransaction(qrId: string) {
  const tx = await db.transaction.findUnique({ where: { qrId } });
  if (!tx) throw new Error('Transaksi tidak ditemukan');
  logger.info({ qrId }, 'Manual recheck requested');
  return tx;
}

/**
 * Queues a transaction for manual deposit retry.
 * Safe to call multiple times — deposit service has idempotency key guard.
 */
export async function queueDepositRetry(qrId: string): Promise<void> {
  const tx = await db.transaction.findUnique({ where: { qrId } });
  if (!tx) throw new Error('Transaksi tidak ditemukan');

  if (tx.statusPay !== 'paid') {
    throw new Error('Hanya transaksi yang sudah dibayar yang bisa di-retry deposit');
  }

  if (!['deposit_failed', 'manual_review'].includes(tx.statusBot)) {
    throw new Error(
      `Retry deposit hanya tersedia untuk status deposit_failed atau manual_review (saat ini: ${tx.statusBot})`,
    );
  }

  await db.transaction.update({
    where: { qrId },
    data: { statusBot: 'deposit_queued' },
  });

  logger.info({ qrId }, 'Transaction queued for deposit retry');
}

/**
 * Creates a mock mutation for a given open transaction (dev/simulation only).
 * The worker's mutation-poll loop will pick it up within 1.5 seconds.
 */
export async function createSimulatedMutation(qrId: string): Promise<string> {
  const tx = await db.transaction.findUnique({
    where: { qrId },
    include: { qrisAccount: true },
  });

  if (!tx) throw new Error(`Transaksi tidak ditemukan: ${qrId}`);
  if (tx.statusPay !== 'open') throw new Error(`Transaksi sudah ${tx.statusPay}, tidak bisa disimulasikan`);
  if (new Date() > tx.expiresAt) throw new Error('Transaksi sudah expired');

  // Build raw data hash for dedup
  const crypto = await import('crypto');
  const rawData = {
    simulatedAt: new Date().toISOString(),
    amount: tx.finalAmount,
    issuer: 'MOCK_BANK',
    rrn: `SIM${Date.now()}`,
    qrId,
  };
  const rawHash = crypto.createHash('sha256').update(JSON.stringify(rawData)).digest('hex');

  const { mutation } = await storeMutationIfNew({
    qrisAccountId: tx.qrisAccountId,
    amount: tx.finalAmount,
    type: 'credit',
    balanceBefore: 1_000_000,
    balanceAfter: 1_000_000 + tx.finalAmount,
    issuerName: 'MOCK_BANK',
    rrn: rawData.rrn,
    transactionTime: new Date(),
    rawHash,
    rawDataJson: JSON.stringify(rawData),
  });

  logger.info({ mutationId: mutation.id, qrId, amount: tx.finalAmount }, 'Simulated mutation created');
  return mutation.id;
}
