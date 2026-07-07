"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookRouter = void 0;
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const mutation_ingest_service_1 = require("../../shared/mutation-ingest.service");
const router = (0, express_1.Router)();
exports.webhookRouter = router;
/**
 * GET /webhook/mutation
 * Health-check for providers that probe the endpoint before sending events.
 */
router.get('/mutation', (_req, res) => {
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
router.post('/mutation', async (req, res) => {
    // Respond immediately so the provider doesn't time out
    res.status(200).json({ received: true });
    try {
        const body = req.body;
        const rawDataJson = JSON.stringify(body);
        const rawHash = crypto_1.default.createHash('sha256').update(rawDataJson).digest('hex');
        const accountCode = String(body.accountCode ?? '').trim().toUpperCase();
        const amount = Number(body.amount ?? 0);
        if (!accountCode || !amount) {
            logger_1.logger.warn({ body }, 'Webhook mutation received with missing accountCode or amount');
            return;
        }
        const account = await database_1.db.qrisAccount.findUnique({ where: { code: accountCode } });
        if (!account) {
            logger_1.logger.warn({ accountCode }, 'Webhook mutation: unknown accountCode');
            return;
        }
        // Idempotency — skip duplicates
        const existing = await database_1.db.mutation.findUnique({ where: { rawHash } });
        if (existing) {
            logger_1.logger.debug({ rawHash }, 'Webhook mutation: duplicate, skipping');
            return;
        }
        const transactionTime = body.transactionTime
            ? new Date(String(body.transactionTime))
            : new Date();
        await (0, mutation_ingest_service_1.storeMutationIfNew)({
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
        logger_1.logger.info({ accountCode, amount }, 'Webhook mutation stored');
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Webhook mutation handler error');
    }
});
//# sourceMappingURL=webhook.router.js.map