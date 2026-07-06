import { Request, Response } from 'express';
import { generateQr } from '../../shared/qris-generator.service';
import {
  getTransactionByQrId,
  recheckTransaction,
  queueDepositRetry,
  createSimulatedMutation,
} from './transactions.service';
import { writeAuditLog } from '../../shared/audit-log.service';
import { logger } from '../../config/logger';
import { ZodError } from 'zod';
import { NoEligibleAccountError, AccountFullError } from '../../shared/qris-generator.service';

// ── Client-facing API ───────────────────────────────────────────────────────

/**
 * POST /api/v1/qris/generate
 * Requires HMAC authentication (req.client is set by hmacMiddleware).
 */
export async function handleGenerateQr(req: Request, res: Response): Promise<void> {
  try {
    const client = req.client!;
    const output = await generateQr(client.id, req.body);

    res.status(201).json({
      success: true,
      data: output,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: 'Input tidak valid',
        details: err.flatten().fieldErrors,
      });
      return;
    }

    if (err instanceof NoEligibleAccountError) {
      res.status(503).json({
        success: false,
        error: 'Tidak ada akun QRIS tersedia saat ini. Silakan coba lagi.',
      });
      return;
    }

    if (err instanceof AccountFullError) {
      res.status(503).json({
        success: false,
        error: 'Kapasitas akun QRIS penuh saat ini. Silakan coba lagi.',
      });
      return;
    }

    logger.error({ err }, 'handleGenerateQr error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}

/**
 * GET /api/v1/qris/:qrId/status
 * Requires HMAC authentication.
 */
export async function handleGetStatus(req: Request, res: Response): Promise<void> {
  try {
    const { qrId } = req.params;
    const tx = await getTransactionByQrId(qrId);

    if (!tx) {
      res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
      return;
    }

    const hasSessionAccess = Boolean(req.session?.user?.id);
    const hasClientAccess = Boolean(req.client?.id);

    if (!hasSessionAccess && !hasClientAccess) {
      res.status(401).json({ success: false, error: 'Autentikasi dibutuhkan' });
      return;
    }

    if (hasClientAccess && tx.clientId !== req.client!.id) {
      res.status(403).json({ success: false, error: 'Akses ditolak' });
      return;
    }

    res.json({
      success: true,
      data: {
        qrId: tx.qrId,
        userIdExt: tx.userIdExt,
        statusPay: tx.statusPay,
        statusBot: tx.statusBot,
        requestedAmount: tx.requestedAmount,
        finalAmount: tx.finalAmount,
        createdAt: tx.createdAt.toISOString(),
        paidAt: tx.paidAt ? tx.paidAt.toISOString() : null,
        expiresAt: tx.expiresAt.toISOString(),
        issuerName: tx.issuerName,
        rrn: tx.rrn,
        note: tx.note,
        receiptUrl: tx.receiptUrl,
      },
    });
  } catch (err) {
    logger.error({ err }, 'handleGetStatus error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}

// ── Admin / Internal API ─────────────────────────────────────────────────────

/**
 * POST /api/v1/qris/:qrId/recheck
 * Admin-only: triggers a recheck request and returns current status.
 */
export async function handleRecheck(req: Request, res: Response): Promise<void> {
  try {
    const tx = await recheckTransaction(req.params.qrId);
    res.json({ success: true, data: { statusPay: tx.statusPay, statusBot: tx.statusBot } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal recheck';
    res.status(400).json({ success: false, error: message });
  }
}

/**
 * POST /api/v1/qris/:qrId/retry-deposit
 * Admin-only: manually queue a failed/reviewed transaction for deposit retry.
 */
export async function handleRetryDeposit(req: Request, res: Response): Promise<void> {
  try {
    await queueDepositRetry(req.params.qrId);

    await writeAuditLog(db, {
      userId: req.session.user?.id,
      action: 'deposit_retry_manual',
      entityType: 'Transaction',
      entityId: req.params.qrId,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Deposit dijadwalkan untuk retry' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal retry deposit';
    res.status(400).json({ success: false, error: message });
  }
}

/**
 * POST /dev/simulate-payment
 * Dev-only: creates a mock mutation for an open transaction.
 * The worker picks it up within 1.5 seconds.
 * BLOCKED in production.
 */
export async function handleDevSimulate(req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({ success: false, error: 'Tidak tersedia di production' });
    return;
  }

  try {
    const { qrId } = req.body as { qrId?: string };
    if (!qrId) {
      res.status(400).json({ success: false, error: 'qrId wajib diisi' });
      return;
    }

    const mutationId = await createSimulatedMutation(qrId);
    res.json({
      success: true,
      message: 'Mutasi simulasi dibuat. Worker akan memproses dalam ~1.5 detik.',
      mutationId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Simulasi gagal';
    res.status(400).json({ success: false, error: message });
  }
}

// Import db for audit log in handleRetryDeposit
import { db } from '../../config/database';
