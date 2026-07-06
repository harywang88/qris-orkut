import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { storeMutationIfNew } from '../../shared/mutation-ingest.service';

const router = Router();

/**
 * GET /webhook/mutation
 * Health-check for providers that probe the endpoint before sending events.
 */
router.get('/mutation', (_req: Request, res: Response) => {
  res.json({ status: 'ok', endpoint: 'webhook/mutation' });
});

/**
 * POST /webhook/mutation
 * Receives mutation (payment notification) pushed by the QRIS provider.
 *
 * Expected body (flexible — all fields optional except accountCode + amount):
 * {
 *   accountCode: string,   // matches QrisAccount.code
 *   amount: number,
 *   type?: "credit" | "debit",
 *   balanceBefore?: number,
 *   balanceAfter?: number,
 *   issuerName?: string,
 *   rrn?: string,
 *   transactionTime?: string, // ISO datetime
 *   [key: string]: unknown,   // any extra fields are stored in rawDataJson
 * }
 */
router.post('/mutation', async (req: Request, res: Response) => {
  // Respond immediately so the provider doesn't time out
  res.status(200).json({ received: true });

  try {
    const body = req.body as Record<string, unknown>;
    const rawDataJson = JSON.stringify(body);
    const rawHash = crypto.createHash('sha256').update(rawDataJson).digest('hex');

    const accountCode = String(body.accountCode ?? '').trim().toUpperCase();
    const amount = Number(body.amount ?? 0);

    if (!accountCode || !amount) {
      logger.warn({ body }, 'Webhook mutation received with missing accountCode or amount');
      return;
    }

    const account = await db.qrisAccount.findUnique({ where: { code: accountCode } });
    if (!account) {
      logger.warn({ accountCode }, 'Webhook mutation: unknown accountCode');
      return;
    }

    // Idempotency — skip duplicates
    const existing = await db.mutation.findUnique({ where: { rawHash } });
    if (existing) {
      logger.debug({ rawHash }, 'Webhook mutation: duplicate, skipping');
      return;
    }

    const transactionTime = body.transactionTime
      ? new Date(String(body.transactionTime))
      : new Date();

    await storeMutationIfNew({
      qrisAccountId: account.id,
      amount,
      type: String(body.type ?? 'credit'),
      balanceBefore: Number(body.balanceBefore ?? 0),
      balanceAfter: Number(body.balanceAfter ?? 0),
      issuerName: body.issuerName ? String(body.issuerName) : null,
      rrn: body.rrn ? String(body.rrn) : null,
      transactionTime,
      rawHash,
      rawDataJson,
    });

    logger.info({ accountCode, amount }, 'Webhook mutation stored');
  } catch (err) {
    logger.error({ err }, 'Webhook mutation handler error');
  }
});

export { router as webhookRouter };
