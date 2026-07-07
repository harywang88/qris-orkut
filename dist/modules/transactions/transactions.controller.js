"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGenerateQr = handleGenerateQr;
exports.handleGetStatus = handleGetStatus;
exports.handleRecheck = handleRecheck;
exports.handleRetryDeposit = handleRetryDeposit;
exports.handleDevSimulate = handleDevSimulate;
const qris_generator_service_1 = require("../../shared/qris-generator.service");
const transactions_service_1 = require("./transactions.service");
const audit_log_service_1 = require("../../shared/audit-log.service");
const logger_1 = require("../../config/logger");
const zod_1 = require("zod");
const qris_generator_service_2 = require("../../shared/qris-generator.service");
// ── Client-facing API ───────────────────────────────────────────────────────
/**
 * POST /api/v1/qris/generate
 * Requires HMAC authentication (req.client is set by hmacMiddleware).
 */
async function handleGenerateQr(req, res) {
    try {
        const client = req.client;
        const output = await (0, qris_generator_service_1.generateQr)(client.id, req.body);
        res.status(201).json({
            success: true,
            data: output,
        });
    }
    catch (err) {
        if (err instanceof zod_1.ZodError) {
            res.status(400).json({
                success: false,
                error: 'Input tidak valid',
                details: err.flatten().fieldErrors,
            });
            return;
        }
        if (err instanceof qris_generator_service_2.NoEligibleAccountError) {
            res.status(503).json({
                success: false,
                error: 'Tidak ada akun QRIS tersedia saat ini. Silakan coba lagi.',
            });
            return;
        }
        if (err instanceof qris_generator_service_2.AccountFullError) {
            res.status(503).json({
                success: false,
                error: 'Kapasitas akun QRIS penuh saat ini. Silakan coba lagi.',
            });
            return;
        }
        logger_1.logger.error({ err }, 'handleGenerateQr error');
        res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
    }
}
/**
 * GET /api/v1/qris/:qrId/status
 * Requires HMAC authentication.
 */
async function handleGetStatus(req, res) {
    try {
        const { qrId } = req.params;
        const tx = await (0, transactions_service_1.getTransactionByQrId)(qrId);
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
        if (hasClientAccess && tx.clientId !== req.client.id) {
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
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleGetStatus error');
        res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
    }
}
// ── Admin / Internal API ─────────────────────────────────────────────────────
/**
 * POST /api/v1/qris/:qrId/recheck
 * Admin-only: triggers a recheck request and returns current status.
 */
async function handleRecheck(req, res) {
    try {
        const tx = await (0, transactions_service_1.recheckTransaction)(req.params.qrId);
        res.json({ success: true, data: { statusPay: tx.statusPay, statusBot: tx.statusBot } });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal recheck';
        res.status(400).json({ success: false, error: message });
    }
}
/**
 * POST /api/v1/qris/:qrId/retry-deposit
 * Admin-only: manually queue a failed/reviewed transaction for deposit retry.
 */
async function handleRetryDeposit(req, res) {
    try {
        await (0, transactions_service_1.queueDepositRetry)(req.params.qrId);
        await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
            userId: req.session.user?.id,
            action: 'deposit_retry_manual',
            entityType: 'Transaction',
            entityId: req.params.qrId,
            ip: req.ip,
        });
        res.json({ success: true, message: 'Deposit dijadwalkan untuk retry' });
    }
    catch (err) {
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
async function handleDevSimulate(req, res) {
    if (process.env.NODE_ENV === 'production') {
        res.status(403).json({ success: false, error: 'Tidak tersedia di production' });
        return;
    }
    try {
        const { qrId } = req.body;
        if (!qrId) {
            res.status(400).json({ success: false, error: 'qrId wajib diisi' });
            return;
        }
        const mutationId = await (0, transactions_service_1.createSimulatedMutation)(qrId);
        res.json({
            success: true,
            message: 'Mutasi simulasi dibuat. Worker akan memproses dalam ~1.5 detik.',
            mutationId,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Simulasi gagal';
        res.status(400).json({ success: false, error: message });
    }
}
// Import db for audit log in handleRetryDeposit
const database_1 = require("../../config/database");
//# sourceMappingURL=transactions.controller.js.map