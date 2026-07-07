"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDashboardQrTransaction = generateDashboardQrTransaction;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../config/database");
const config_1 = require("../config");
const encryption_1 = require("../core/encryption");
const app_orkut_gateway_1 = require("./gateways/app-orkut.gateway");
const mock_orkut_gateway_1 = require("./gateways/mock-orkut.gateway");
const amount_lock_service_1 = require("./amount-lock.service");
const DASHBOARD_CLIENT_PANEL_CODE = 'DASHGEN';
function normalizeUsername(value) {
    return value.trim().replace(/\s+/g, ' ').slice(0, 100);
}
function buildDashboardNote(account, username, amount, createdAt) {
    const stamp = createdAt.toISOString().replace(/\D/g, '').slice(0, 14);
    return `MANUAL-${account.code}-${username}-${stamp} | Rp ${amount.toLocaleString('id-ID')}`;
}
async function ensureDashboardManualClient() {
    const existing = await database_1.db.client.findUnique({
        where: { panelCode: DASHBOARD_CLIENT_PANEL_CODE },
    });
    if (existing)
        return existing;
    const apiKey = `qris_dashboard_${crypto_1.default.randomBytes(12).toString('hex')}`;
    const apiSecretEncrypted = (0, encryption_1.encrypt)(crypto_1.default.randomBytes(32).toString('hex'));
    return database_1.db.client.create({
        data: {
            name: 'Dashboard Generate',
            panelCode: DASHBOARD_CLIENT_PANEL_CODE,
            apiKey,
            apiSecretEncrypted,
            status: 'active',
        },
    });
}
async function resolveDashboardQrisTemplate(account) {
    const liveTerms = await app_orkut_gateway_1.appGateway.fetchQrisMerchantTerms(account).catch(() => null);
    const qrisData = liveTerms?.qrisData || account.qrisPayload;
    if (!qrisData) {
        throw new Error('QRIS template tidak tersedia untuk akun ini');
    }
    if (liveTerms?.qrisData && liveTerms.qrisData !== account.qrisPayload) {
        await database_1.db.qrisAccount.update({
            where: { id: account.id },
            data: { qrisPayload: liveTerms.qrisData },
        }).catch(() => { });
    }
    return qrisData;
}
async function generateDashboardQrTransaction(input) {
    const username = normalizeUsername(input.username);
    if (!username) {
        throw new Error('Username wajib diisi');
    }
    if (!Number.isInteger(input.amount) || input.amount < 1) {
        throw new Error('Nominal minimal Rp 1');
    }
    if (input.amount > 10000000) {
        throw new Error('Nominal maksimal Rp 10.000.000');
    }
    const account = await database_1.db.qrisAccount.findUnique({
        where: { id: input.accountId },
    });
    if (!account || account.status !== 'active') {
        throw new Error('Akun QRIS tidak ditemukan atau tidak aktif');
    }
    const qrisData = await resolveDashboardQrisTemplate(account);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + config_1.config.QR_EXPIRY_MINUTES * 60 * 1000);
    const manualClient = await ensureDashboardManualClient();
    const transactionId = crypto_1.default.randomUUID();
    const result = await database_1.db.$transaction(async (tx) => {
        const { uniqueCode, finalAmount } = await (0, amount_lock_service_1.findUniqueCode)(tx, account.id, account.code, input.amount);
        const note = buildDashboardNote(account, username, finalAmount, createdAt);
        const qrSourceAccount = {
            ...account,
            qrisPayload: qrisData,
        };
        const qrResult = await mock_orkut_gateway_1.mockGateway.generateQr(qrSourceAccount, finalAmount, note);
        const txRecord = await tx.transaction.create({
            data: {
                id: transactionId,
                clientId: manualClient.id,
                userIdExt: username,
                qrisAccountId: account.id,
                requestedAmount: input.amount,
                uniqueCode,
                finalAmount,
                note,
                qrPayload: qrResult.qrPayload,
                qrImageBase64: qrResult.qrImageBase64,
                feeAmount: 0,
                statusPay: 'open',
                statusBot: 'pending',
                expiresAt,
                metadataJson: JSON.stringify({
                    source: 'dashboard_generate',
                    site: '-',
                    createdBy: input.createdBy,
                }),
            },
        });
        await (0, amount_lock_service_1.createAmountLock)(tx, {
            qrisAccountId: account.id,
            requestedAmount: input.amount,
            uniqueCode,
            finalAmount,
            expiresAt,
            transactionId,
        });
        await tx.qrisAccount.update({
            where: { id: account.id },
            data: { usedToday: { increment: finalAmount } },
        });
        return {
            txRecord,
            qrResult,
        };
    });
    const tx = result.txRecord;
    return {
        transactionId: tx.id,
        qrId: tx.qrId,
        username,
        siteLabel: '-',
        createdAt: tx.createdAt.toISOString(),
        expiresAt: tx.expiresAt.toISOString(),
        amount: tx.finalAmount,
        status: 'UNPAID',
        botLabel: '-',
        note: tx.note,
        qrisAccount: {
            code: account.code,
            merchantName: account.merchantName,
        },
        qrPayload: result.qrResult.qrPayload,
        qrImageBase64: result.qrResult.qrImageBase64,
    };
}
//# sourceMappingURL=dashboard-generate-qr.service.js.map