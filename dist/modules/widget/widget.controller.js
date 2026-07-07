"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWidgetGenerate = handleWidgetGenerate;
exports.handleWidgetStatus = handleWidgetStatus;
exports.handleWidgetOptions = handleWidgetOptions;
const zod_1 = require("zod");
const qris_generator_service_1 = require("../../shared/qris-generator.service");
const transactions_service_1 = require("../transactions/transactions.service");
const widget_service_1 = require("./widget.service");
const logger_1 = require("../../config/logger");
/**
 * Sets permissive-but-scoped CORS headers for the widget endpoints.
 * Echoes back the caller's Origin when present so browsers accept the response.
 */
function setWidgetCors(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
}
/**
 * GET /widget/generate?key=…&amount=…&member=…&ref=…
 *
 * Public, browser-facing (alfael-style). Authenticated only by the widget key
 * plus an Origin/Referer allowlist. Creates a QR for the client that owns the key.
 */
async function handleWidgetGenerate(req, res) {
    setWidgetCors(req, res);
    try {
        const key = String(req.query.key ?? '');
        const client = await (0, widget_service_1.findClientByWidgetKey)(key);
        if (!client) {
            res.status(401).json({ success: false, error: 'Widget key tidak valid' });
            return;
        }
        if (!(0, widget_service_1.isOriginAllowed)(client.widgetAllowedOrigins, req.headers.origin, req.headers.referer)) {
            logger_1.logger.warn({ clientId: client.id, origin: req.headers.origin, referer: req.headers.referer }, 'Widget generate blocked by origin allowlist');
            res.status(403).json({ success: false, error: 'Origin tidak diizinkan' });
            return;
        }
        const amount = parseInt(String(req.query.amount ?? ''), 10);
        const member = String(req.query.member ?? '').trim();
        const ref = req.query.ref ? String(req.query.ref) : undefined;
        const output = await (0, qris_generator_service_1.generateQr)(client.id, {
            userId: member || 'guest',
            amount,
            externalReference: ref,
        });
        res.status(201).json({ success: true, data: output });
    }
    catch (err) {
        if (err instanceof zod_1.ZodError) {
            res.status(400).json({ success: false, error: 'Input tidak valid', details: err.flatten().fieldErrors });
            return;
        }
        if (err instanceof qris_generator_service_1.NoEligibleAccountError) {
            res.status(503).json({ success: false, error: 'Tidak ada akun QRIS tersedia saat ini. Silakan coba lagi.' });
            return;
        }
        if (err instanceof qris_generator_service_1.AccountFullError) {
            res.status(503).json({ success: false, error: 'Kapasitas akun QRIS penuh saat ini. Silakan coba lagi.' });
            return;
        }
        logger_1.logger.error({ err }, 'handleWidgetGenerate error');
        res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
    }
}
/**
 * GET /widget/status?key=…&qrId=…
 *
 * Returns minimal payment status. The QR must belong to the client that owns
 * the widget key (prevents one site reading another site's transactions).
 */
async function handleWidgetStatus(req, res) {
    setWidgetCors(req, res);
    try {
        const key = String(req.query.key ?? '');
        const client = await (0, widget_service_1.findClientByWidgetKey)(key);
        if (!client) {
            res.status(401).json({ success: false, error: 'Widget key tidak valid' });
            return;
        }
        const qrId = String(req.query.qrId ?? '').trim();
        if (!qrId) {
            res.status(400).json({ success: false, error: 'qrId wajib diisi' });
            return;
        }
        const tx = await (0, transactions_service_1.getTransactionByQrId)(qrId);
        if (!tx || tx.clientId !== client.id) {
            res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
            return;
        }
        res.json({
            success: true,
            data: {
                qrId: tx.qrId,
                statusPay: tx.statusPay,
                statusBot: tx.statusBot,
                finalAmount: tx.finalAmount,
                expiresAt: tx.expiresAt.toISOString(),
                paidAt: tx.paidAt ? tx.paidAt.toISOString() : null,
            },
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleWidgetStatus error');
        res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
    }
}
/** Handles CORS preflight for the widget endpoints. */
function handleWidgetOptions(req, res) {
    setWidgetCors(req, res);
    res.status(204).end();
}
//# sourceMappingURL=widget.controller.js.map