import crypto from 'crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { db } from '../config/database';
import { config } from '../config';
import { logger } from '../config/logger';
import { buildNote } from './note-builder';
import { selectQrisAccount, NoEligibleAccountError } from './qris-account-selector';
import { findUniqueCode, createAmountLock, AccountFullError } from './amount-lock.service';
import { mockGateway } from './gateways/mock-orkut.gateway';

// ── Input schema ────────────────────────────────────────────────────────────

export const GenerateQrSchema = z.object({
  userId: z
    .string()
    .min(1, 'userId is required')
    .max(100, 'userId must be at most 100 characters'),
  amount: z
    .number()
    .int('amount must be an integer (rupiah, no decimals)')
    .min(1000, 'amount minimum is Rp 1,000')
    .max(10_000_000, 'amount maximum is Rp 10,000,000'),
  externalReference: z.string().max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type GenerateQrInput = z.infer<typeof GenerateQrSchema>;

// ── Output ──────────────────────────────────────────────────────────────────

export interface GenerateQrOutput {
  qrId: string;
  requestedAmount: number;
  uniqueCode: number;
  finalAmount: number;
  fee: number;
  expiresAt: string; // ISO 8601
  statusPay: string;
  qrPayload: string;
  qrImageBase64: string;
  note: string;
  qrisAccount: {
    code: string;
    merchantName: string;
  };
}

// Prisma transaction client type
type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Orchestrates the full QR generation flow:
 *
 *  1. Validate input (Zod)
 *  2. Generate a pre-computed Transaction ID (crypto.randomUUID)
 *  3. Open a Prisma $transaction:
 *     a. selectQrisAccount (round-robin, updates lastAssignedAt)
 *     b. reserveUniqueCode (inserts AmountLock)
 *     c. buildNote
 *  4. Generate QR image outside the transaction (async I/O, avoids holding lock)
 *  5. Compute fee
 *  6. Re-open (or extend) transaction to insert Transaction + update usedToday
 *
 * Note: Steps 3 and 6 are merged into one $transaction for full atomicity.
 * The QR image generation (step 4) is async CPU work that completes quickly
 * and is acceptable inside the transaction in this implementation.
 */
export async function generateQr(
  clientId: string,
  rawInput: unknown,
): Promise<GenerateQrOutput> {
  // Step 1: Validate
  const input = GenerateQrSchema.parse(rawInput);

  // Step 2: Pre-generate the transaction ID so AmountLock can reference it
  const transactionId = crypto.randomUUID();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.QR_EXPIRY_MINUTES * 60 * 1000);

  // Steps 3–6 inside one atomic transaction
  const result = await (db.$transaction as (fn: (tx: TxClient) => Promise<GenerateQrOutput>, options?: { timeout?: number }) => Promise<GenerateQrOutput>)(
    async (tx) => {
      // 3a: Select account (updates lastAssignedAt)
      const account = await selectQrisAccount(tx);

      // 3b: Find unique code (read-only — no DB write yet)
      const { uniqueCode, finalAmount, base } = await findUniqueCode(
        tx,
        account.id,
        account.code,
        input.amount,
      );

      // 3c: Build note and generate QR (no DB writes)
      const note = buildNote(now, account.code, input.userId, finalAmount);

      // 4: Generate QR image (no network, fast CPU work)
      const { qrPayload, qrImageBase64 } = await mockGateway.generateQr(
        account,
        finalAmount,
        note,
      );

      // 5: Compute fee
      const feeAmount = finalAmount < 500_000 ? 0 : Math.round(finalAmount * 0.003);

      // 6a: Insert Transaction FIRST (AmountLock FK references this row)
      await tx.transaction.create({
        data: {
          id: transactionId,
          qrId: crypto.randomUUID(),
          clientId,
          userIdExt: input.userId,
          externalReference: input.externalReference ?? null,
          qrisAccountId: account.id,
          requestedAmount: input.amount,
          uniqueCode,
          finalAmount,
          note,
          qrPayload,
          qrImageBase64,
          feeAmount,
          statusPay: 'open',
          statusBot: 'pending',
          expiresAt,
          metadataJson: JSON.stringify({
            ...(input.metadata ?? {}),
            originalAmount: input.amount,
            roundedBase: base,
          }),
        },
      });

      // 6b: Create AmountLock AFTER Transaction exists (satisfies FK constraint)
      await createAmountLock(tx, {
        qrisAccountId: account.id,
        requestedAmount: input.amount,
        uniqueCode,
        finalAmount,
        expiresAt,
        transactionId,
      });

      // 6c: Update account daily usage
      await tx.qrisAccount.update({
        where: { id: account.id },
        data: { usedToday: { increment: finalAmount } },
      });

      logger.info(
        {
          transactionId,
          clientId,
          accountCode: account.code,
          requestedAmount: input.amount,
          uniqueCode,
          finalAmount,
        },
        'QR generated',
      );

      // Fetch the created transaction to get the qrId
      const txRecord = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { qrId: true },
      });

      return {
        qrId: txRecord.qrId,
        requestedAmount: input.amount,
        uniqueCode,
        finalAmount,
        fee: feeAmount,
        expiresAt: expiresAt.toISOString(),
        statusPay: 'open',
        qrPayload,
        qrImageBase64,
        note,
        qrisAccount: {
          code: account.code,
          merchantName: account.merchantName,
        },
      };
    },
    { timeout: 30_000 },
  );

  return result;
}

/** Re-exports for convenience */
export { NoEligibleAccountError, AccountFullError };
