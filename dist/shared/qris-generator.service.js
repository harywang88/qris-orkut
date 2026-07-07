"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountFullError = exports.NoEligibleAccountError = exports.GenerateQrSchema = void 0;
exports.generateQr = generateQr;
const crypto_1 = __importDefault(require("crypto"));
const zod_1 = require("zod");
const database_1 = require("../config/database");
const config_1 = require("../config");
const logger_1 = require("../config/logger");
const note_builder_1 = require("./note-builder");
const qris_account_selector_1 = require("./qris-account-selector");
Object.defineProperty(exports, "NoEligibleAccountError", { enumerable: true, get: function () { return qris_account_selector_1.NoEligibleAccountError; } });
const amount_lock_service_1 = require("./amount-lock.service");
Object.defineProperty(exports, "AccountFullError", { enumerable: true, get: function () { return amount_lock_service_1.AccountFullError; } });
const mock_orkut_gateway_1 = require("./gateways/mock-orkut.gateway");
// ── Input schema ────────────────────────────────────────────────────────────
exports.GenerateQrSchema = zod_1.z.object({
    userId: zod_1.z
        .string()
        .min(1, 'userId is required')
        .max(100, 'userId must be at most 100 characters'),
    amount: zod_1.z
        .number()
        .int('amount must be an integer (rupiah, no decimals)')
        .min(1000, 'amount minimum is Rp 1,000')
        .max(10000000, 'amount maximum is Rp 10,000,000'),
    externalReference: zod_1.z.string().max(255).optional(),
    metadata: zod_1.z.record(zod_1.z.unknown()).optional(),
});
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
async function generateQr(clientId, rawInput) {
    // Step 1: Validate
    const input = exports.GenerateQrSchema.parse(rawInput);
    // Step 2: Pre-generate the transaction ID so AmountLock can reference it
    const transactionId = crypto_1.default.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config_1.config.QR_EXPIRY_MINUTES * 60 * 1000);
    // Steps 3–6 inside one atomic transaction
    const result = await database_1.db.$transaction(async (tx) => {
        // 3a: Select account (updates lastAssignedAt)
        const account = await (0, qris_account_selector_1.selectQrisAccount)(tx);
        // 3b: Find unique code (read-only — no DB write yet)
        const { uniqueCode, finalAmount, base } = await (0, amount_lock_service_1.findUniqueCode)(tx, account.id, account.code, input.amount);
        // 3c: Build note and generate QR (no DB writes)
        const note = (0, note_builder_1.buildNote)(now, account.code, input.userId, finalAmount);
        // 4: Generate QR image (no network, fast CPU work)
        const { qrPayload, qrImageBase64 } = await mock_orkut_gateway_1.mockGateway.generateQr(account, finalAmount, note);
        // 5: Compute fee
        const feeAmount = finalAmount < 500000 ? 0 : Math.round(finalAmount * 0.003);
        // 6a: Insert Transaction FIRST (AmountLock FK references this row)
        await tx.transaction.create({
            data: {
                id: transactionId,
                qrId: crypto_1.default.randomUUID(),
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
        await (0, amount_lock_service_1.createAmountLock)(tx, {
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
        logger_1.logger.info({
            transactionId,
            clientId,
            accountCode: account.code,
            requestedAmount: input.amount,
            uniqueCode,
            finalAmount,
        }, 'QR generated');
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
    }, { timeout: 30000 });
    return result;
}
//# sourceMappingURL=qris-generator.service.js.map