"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateSettlementSchema = void 0;
exports.createSettlement = createSettlement;
exports.processSettlement = processSettlement;
exports.inquireSettlementBankAccount = inquireSettlementBankAccount;
exports.listSettlementTransferBanks = listSettlementTransferBanks;
exports.reconcileProcessingMaderaTransfers = reconcileProcessingMaderaTransfers;
exports.listSettlements = listSettlements;
const database_1 = require("../config/database");
const logger_1 = require("../config/logger");
const wallet_ledger_service_1 = require("./wallet-ledger.service");
const audit_log_service_1 = require("./audit-log.service");
const app_orkut_gateway_1 = require("./gateways/app-orkut.gateway");
const zod_1 = require("zod");
const encryption_1 = require("../core/encryption");
const orkut_panel_service_1 = require("./orkut-panel.service");
const crypto_1 = require("crypto");
exports.CreateSettlementSchema = zod_1.z.object({
    fromWallet: zod_1.z.enum(['qris', 'utama', 'madera']),
    toWallet: zod_1.z.enum(['utama', 'madera', 'bank']),
    amount: zod_1.z.number().int().min(1, 'Jumlah minimal Rp 1'),
    qrisAccountId: zod_1.z.string().optional(),
    bankCode: zod_1.z.string().max(20).optional(),
    bankAccount: zod_1.z.string().max(50).optional(),
    bankName: zod_1.z.string().max(100).optional(),
    note: zod_1.z.string().max(500).optional(),
});
function parseRawSettlementNoteMarkers(note) {
    const text = String(note || '');
    const feeMatch = text.match(/\[\[FEE:(\d+)\]\]/);
    const totalMatch = text.match(/\[\[TOTAL:(\d+)\]\]/);
    const redirectMatch = text.match(/\[\[REDIRECT_URL:(.+?)\]\]/);
    const cleanNote = text
        .replace(/\s*\[\[(?:FEE|TOTAL|REDIRECT_URL):.+?\]\]\s*/g, ' ')
        .replace(/\s+\|\s*$/g, '')
        .trim();
    return {
        cleanNote: cleanNote || null,
        fee: feeMatch ? Number.parseInt(feeMatch[1], 10) : null,
        total: totalMatch ? Number.parseInt(totalMatch[1], 10) : null,
        redirectUrl: redirectMatch ? redirectMatch[1] : null,
    };
}
function buildSettlementNote(note, markers) {
    const parsed = parseRawSettlementNoteMarkers(note);
    const parts = [parsed.cleanNote].filter(Boolean);
    if (markers.fee !== undefined && markers.fee !== null)
        parts.push(`[[FEE:${markers.fee}]]`);
    else if (parsed.fee !== null)
        parts.push(`[[FEE:${parsed.fee}]]`);
    if (markers.total !== undefined && markers.total !== null)
        parts.push(`[[TOTAL:${markers.total}]]`);
    else if (parsed.total !== null)
        parts.push(`[[TOTAL:${parsed.total}]]`);
    if (markers.redirectUrl !== undefined && markers.redirectUrl !== null)
        parts.push(`[[REDIRECT_URL:${markers.redirectUrl}]]`);
    else if (parsed.redirectUrl)
        parts.push(`[[REDIRECT_URL:${parsed.redirectUrl}]]`);
    return parts.length > 0 ? parts.join('\n') : null;
}
function classifyMaderaHistoryDescription(description) {
    const text = description.toLowerCase();
    return (text.includes('bi fast out')
        || text.includes('biaya transfer bi fast')
        || text.includes('transfer bi fast')
        || text.includes('bifast out'));
}
function parseHistoryAmount(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.abs(Math.trunc(value));
    const cleaned = String(value ?? '').replace(/[^\d-]/g, '');
    if (!cleaned)
        return null;
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}
function parseHistoryDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
        return value;
    const text = String(value ?? '').trim();
    if (!text)
        return null;
    const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})[ ,T]+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
        const d = new Date(text);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const [, dd, mm, yyyy, hh, mi, ss] = m;
    const d = new Date(Number.parseInt(yyyy, 10), Number.parseInt(mm, 10) - 1, Number.parseInt(dd, 10), Number.parseInt(hh, 10), Number.parseInt(mi, 10), Number.parseInt(ss || '0', 10), 0);
    return Number.isNaN(d.getTime()) ? null : d;
}
function parseHistoryMutation(rawDataJson) {
    let raw;
    try {
        raw = JSON.parse(rawDataJson);
    }
    catch {
        return null;
    }
    const description = String(raw.keterangan ?? raw.description ?? '').trim();
    if (!description || !classifyMaderaHistoryDescription(description))
        return null;
    const amount = parseHistoryAmount(raw.debet)
        ?? parseHistoryAmount(raw.kredit)
        ?? null;
    if (!amount || amount <= 0)
        return null;
    const type = parseHistoryAmount(raw.debet) ? 'debit' : 'credit';
    const balanceAfter = parseHistoryAmount(raw.saldo_akhir) ?? 0;
    const transactionTime = parseHistoryDate(raw.tanggal ?? raw.date ?? raw.created_at ?? raw.waktu);
    if (!transactionTime)
        return null;
    return {
        amount,
        type,
        balanceAfter,
        transactionTime,
        description,
        rawDataJson,
        rawHash: (0, crypto_1.createHash)('sha256').update(rawDataJson).digest('hex'),
    };
}
async function fetchMaderaHistory(account) {
    if (!account.sessionTokenEncrypted)
        return [];
    const history = await app_orkut_gateway_1.appGateway.fetchBalanceHistory(account);
    return history.mutations
        .map((mutation) => parseHistoryMutation(mutation.rawDataJson))
        .filter((item) => item !== null)
        .sort((left, right) => right.transactionTime.getTime() - left.transactionTime.getTime());
}
async function persistMaderaHistoryMutations(accountId, entries) {
    for (const entry of entries) {
        const existing = await database_1.db.mutation.findUnique({ where: { rawHash: entry.rawHash }, select: { id: true } });
        if (existing)
            continue;
        const balanceBefore = entry.type === 'credit'
            ? Math.max(0, entry.balanceAfter - entry.amount)
            : entry.balanceAfter + entry.amount;
        await database_1.db.mutation.create({
            data: {
                qrisAccountId: accountId,
                amount: entry.amount,
                type: entry.type,
                balanceBefore,
                balanceAfter: entry.balanceAfter,
                issuerName: null,
                rrn: null,
                walletCategory: 'madera',
                transactionTime: entry.transactionTime,
                rawHash: entry.rawHash,
                rawDataJson: entry.rawDataJson,
            },
        });
    }
}
function findSettlementTransferMatch(settlement, entries) {
    const ownerText = String(parseRawSettlementNoteMarkers(settlement.note).cleanNote || '').toUpperCase();
    const bankText = String(settlement.bankName || '').toUpperCase();
    const transfer = entries.find((entry) => {
        if (entry.type !== 'debit' || entry.amount !== settlement.amount)
            return false;
        const timeDiff = Math.abs(entry.transactionTime.getTime() - settlement.createdAt.getTime());
        if (timeDiff > 60 * 60 * 1000)
            return false;
        const desc = entry.description.toUpperCase();
        if (!desc.includes('BI FAST OUT'))
            return false;
        if (ownerText && desc.includes(ownerText))
            return true;
        if (bankText && desc.includes(bankText))
            return true;
        return true;
    });
    if (!transfer)
        return null;
    const fee = entries.find((entry) => {
        if (entry.type !== 'debit')
            return false;
        if (!entry.description.toUpperCase().includes('BIAYA TRANSFER BI FAST'))
            return false;
        const timeDiff = Math.abs(entry.transactionTime.getTime() - transfer.transactionTime.getTime());
        return timeDiff <= 60 * 60 * 1000;
    }) ?? null;
    return { transfer, fee };
}
async function resolveSettlementAccountContext(qrisAccountId) {
    const account = await database_1.db.qrisAccount.findUnique({
        where: { id: qrisAccountId },
        select: {
            id: true,
            code: true,
            merchantName: true,
            orkutAccountIndex: true,
            sessionTokenEncrypted: true,
            cookiesEncrypted: true,
            webCookiesEncrypted: true,
            webUserAgent: true,
            deviceId: true,
            transferPinEncrypted: true,
            lastMainBalance: true,
            lastQrisBalance: true,
            lastMaderaBalance: true,
        },
    });
    if (!account) {
        throw new Error('Merchant QR untuk settlement tidak ditemukan.');
    }
    const activeAccounts = await database_1.db.qrisAccount.findMany({
        where: { status: 'active' },
        orderBy: { code: 'asc' },
        select: { id: true },
    });
    const fallbackIndex = activeAccounts.findIndex((item) => item.id === account.id) + 1;
    return {
        account,
        fallbackIndex: fallbackIndex > 0 ? fallbackIndex : 1,
    };
}
function shouldFallbackToAppGateway(error) {
    if (!(error instanceof Error))
        return false;
    return error.message.toLowerCase().includes('web session cookie');
}
async function listSettlementTransferBanksInternal(account, fallbackIndex) {
    try {
        const panel = await (0, orkut_panel_service_1.fetchOrkutTransferBanks)(account, fallbackIndex);
        if (panel.banks.length > 0) {
            return panel.banks.map((bank) => ({
                code: bank.code,
                fee: bank.fee ?? 0,
                name: bank.name,
                status: bank.status,
            }));
        }
    }
    catch (error) {
        if (!shouldFallbackToAppGateway(error))
            throw error;
    }
    const overview = await app_orkut_gateway_1.appGateway.fetchMaderaTransferOverview(account);
    if (!overview?.banks)
        return [];
    return Object.entries(overview.banks)
        .map(([code, info]) => ({
        code,
        fee: info.fee ?? 0,
        name: info.name,
        status: info.status,
    }))
        .sort((left, right) => left.name.localeCompare(right.name));
}
async function inquireSettlementBankPreferred(account, fallbackIndex, input) {
    if (input.fromWallet === 'madera') {
        try {
            const inquiry = await (0, orkut_panel_service_1.inquireOrkutBankAccount)(account, fallbackIndex, {
                bankCode: input.bankCode,
                accountNumber: input.bankAccount,
                amount: Math.max(input.amount ?? 0, 10000),
            });
            if (!inquiry.accountName) {
                throw new Error(inquiry.message || 'Nama pemilik rekening belum berhasil dibaca.');
            }
            return {
                accountName: inquiry.accountName,
                accountNumber: inquiry.accountNumber || input.bankAccount,
                bankCode: inquiry.bankCode || input.bankCode,
                bankName: inquiry.bankName || input.bankCode,
                fee: inquiry.fee ?? 0,
                message: inquiry.message ?? null,
                raw: JSON.parse(inquiry.rawJson || '{}'),
                sessionId: inquiry.sessionId ?? null,
            };
        }
        catch (error) {
            if (!shouldFallbackToAppGateway(error))
                throw error;
        }
    }
    const inquiry = await app_orkut_gateway_1.appGateway.inquireBankAccount(account, {
        sourceWallet: input.fromWallet,
        bankCode: input.bankCode,
        accountNumber: input.bankAccount,
        amount: input.fromWallet === 'madera'
            ? Math.max(input.amount ?? 0, 10000)
            : input.amount,
    });
    if (!inquiry.success || !inquiry.accountName) {
        throw new Error(inquiry.message || 'Nama pemilik rekening belum berhasil dibaca.');
    }
    return {
        accountName: inquiry.accountName,
        accountNumber: inquiry.accountNumber || input.bankAccount,
        bankCode: inquiry.bankCode || input.bankCode,
        bankName: inquiry.bankName || input.bankCode,
        fee: inquiry.fee ?? null,
        message: inquiry.message ?? null,
        raw: inquiry.raw,
        sessionId: inquiry.sessionId ?? null,
    };
}
async function transferSettlementBankPreferred(account, fallbackIndex, params) {
    try {
        const transfer = await (0, orkut_panel_service_1.transferOrkutBankFromMadera)(account, fallbackIndex, {
            bankCode: params.bankCode,
            bankName: params.bankName,
            accountNumber: params.accountNumber,
            accountName: params.accountName,
            amount: params.amount,
            sessionId: params.sessionId,
        });
        const raw = JSON.parse(transfer.rawJson || '{}');
        let status = transfer.status;
        let success = transfer.success;
        let message = transfer.message ?? null;
        if (transfer.success && transfer.redirectUrl && params.pin) {
            const pinResult = await app_orkut_gateway_1.appGateway.finalizeMaderaTransferPin(transfer.redirectUrl, params.pin, account);
            raw.pinConfirmation = pinResult.raw;
            if (pinResult.success) {
                status = 'done';
                success = true;
                message = pinResult.message || message;
            }
            else {
                status = 'processing';
                success = true;
                message = pinResult.message || message;
            }
        }
        return {
            fee: transfer.fee ?? 0,
            message,
            raw,
            redirectUrl: transfer.redirectUrl ?? null,
            referenceNo: transfer.referenceNo ?? null,
            status,
            success,
        };
    }
    catch (error) {
        if (!shouldFallbackToAppGateway(error))
            throw error;
    }
    const transfer = await app_orkut_gateway_1.appGateway.transferBankFromMadera(account, {
        bankCode: params.bankCode,
        bankName: params.bankName,
        accountNumber: params.accountNumber,
        accountName: params.accountName,
        amount: params.amount,
        sessionId: params.sessionId,
        pin: params.pin,
    });
    return {
        fee: transfer.fee ?? null,
        message: transfer.message ?? null,
        raw: transfer.raw,
        redirectUrl: transfer.redirectUrl ?? null,
        referenceNo: transfer.referenceNo ?? null,
        status: transfer.status,
        success: transfer.success,
    };
}
async function persistAppSettlementBalances(accountId, params) {
    const updateData = {
        lastBalanceSyncAt: new Date(),
        lastBalanceSyncStatus: params.status,
        lastBalanceSyncError: null,
    };
    if (params.mainBalance !== undefined)
        updateData.lastMainBalance = params.mainBalance;
    if (params.qrisBalance !== undefined)
        updateData.lastQrisBalance = params.qrisBalance;
    if (params.maderaBalance !== undefined)
        updateData.lastMaderaBalance = params.maderaBalance;
    if (params.raw)
        updateData.lastBalanceSyncRawJson = JSON.stringify(params.raw);
    await database_1.db.qrisAccount.update({
        where: { id: accountId },
        data: updateData,
    });
}
/**
 * Creates a new settlement request with status=pending.
 */
async function createSettlement(input, userId, ip) {
    const validated = exports.CreateSettlementSchema.parse(input);
    const settlement = await database_1.db.settlementRequest.create({
        data: {
            fromWallet: validated.fromWallet,
            toWallet: validated.toWallet,
            amount: validated.amount,
            qrisAccountId: validated.qrisAccountId ?? null,
            bankCode: validated.bankCode ?? null,
            bankAccount: validated.bankAccount ?? null,
            bankName: validated.bankName ?? null,
            note: validated.note ?? null,
            status: 'pending',
        },
    });
    await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
        userId,
        action: 'settlement_create',
        entityType: 'SettlementRequest',
        entityId: settlement.id,
        detail: { fromWallet: validated.fromWallet, toWallet: validated.toWallet, amount: validated.amount },
        ip,
    });
    logger_1.logger.info({ settlementId: settlement.id, ...validated }, 'Settlement request created');
    return settlement.id;
}
/**
 * Processes a single pending settlement request.
 * Called by the settlement-sweep worker loop.
 *
 * Flow:
 *   1. Mark as processing
 *   2. Validate source balance (for wallet-to-wallet transfers)
 *   3. Debit fromWallet / Credit toWallet via WalletLedger
 *   4. Mark as done (or failed on error)
 *   5. Create SettlementItem entries if linked to transactions
 */
async function processSettlement(settlementId) {
    const settlement = await database_1.db.settlementRequest.findUnique({
        where: { id: settlementId },
    });
    if (!settlement) {
        logger_1.logger.warn({ settlementId }, 'processSettlement: not found');
        return;
    }
    if (settlement.status !== 'pending') {
        logger_1.logger.debug({ settlementId, status: settlement.status }, 'processSettlement: not pending, skipping');
        return;
    }
    // Mark as processing
    await database_1.db.settlementRequest.update({
        where: { id: settlementId },
        data: { status: 'processing' },
    });
    try {
        if (settlement.fromWallet === 'qris' && settlement.toWallet === 'utama') {
            if (!settlement.qrisAccountId) {
                throw new Error('Akun merchant wajib dipilih untuk tarik saldo QRIS.');
            }
            const { account } = await resolveSettlementAccountContext(settlement.qrisAccountId);
            const beforeTerms = await app_orkut_gateway_1.appGateway.fetchQrisWithdrawTerms(account);
            if (!beforeTerms) {
                throw new Error('Merchant belum punya Session Token / App Reg ID yang valid untuk tarik saldo QRIS.');
            }
            const availableQris = beforeTerms.qrisBalance ?? account.lastQrisBalance ?? 0;
            if (!beforeTerms.isEnabled) {
                throw new Error(beforeTerms.message || 'Penarikan saldo QRIS sedang tidak tersedia pada akun OrderKuota.');
            }
            if (settlement.amount % 1000 !== 0) {
                throw new Error('Nominal tarik saldo QRIS harus kelipatan Rp 1.000.');
            }
            if (beforeTerms.min > 0 && settlement.amount < beforeTerms.min) {
                throw new Error(`Minimal tarik saldo QRIS Rp ${beforeTerms.min.toLocaleString('id-ID')}.`);
            }
            if (beforeTerms.max > 0 && settlement.amount > beforeTerms.max) {
                throw new Error(`Maksimal tarik saldo QRIS Rp ${beforeTerms.max.toLocaleString('id-ID')}.`);
            }
            if (availableQris < settlement.amount) {
                throw new Error(`Saldo QRIS tidak cukup (saldo: ${availableQris}, diminta: ${settlement.amount})`);
            }
            const remoteResult = await app_orkut_gateway_1.appGateway.withdrawQris(account, settlement.amount);
            if (!remoteResult.success) {
                throw new Error(remoteResult.message || 'Penarikan saldo QRIS gagal diproses.');
            }
            const [afterTerms, mainBalanceHistory] = await Promise.all([
                app_orkut_gateway_1.appGateway.fetchQrisWithdrawTerms(account),
                app_orkut_gateway_1.appGateway.fetchBalanceHistory(account),
            ]);
            await persistAppSettlementBalances(account.id, {
                mainBalance: mainBalanceHistory.mainBalance ?? afterTerms?.mainBalance ?? beforeTerms.mainBalance,
                qrisBalance: afterTerms?.qrisBalance ?? beforeTerms.qrisBalance,
                raw: {
                    source: 'orkut_app_withdraw',
                    beforeTerms,
                    withdraw: remoteResult.raw,
                    afterTerms,
                    mainBalanceHistory,
                },
                status: 'synced',
            });
            const referenceNo = `WD-${Date.now()}-${settlementId.slice(0, 6).toUpperCase()}`;
            await database_1.db.settlementRequest.update({
                where: { id: settlementId },
                data: {
                    status: 'done',
                    processedAt: new Date(),
                    referenceNo,
                    note: settlement.note
                        ? `${settlement.note} | ${remoteResult.message}`
                        : remoteResult.message,
                },
            });
            await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
                action: 'settlement_processed',
                entityType: 'SettlementRequest',
                entityId: settlementId,
                detail: {
                    mode: 'orkut_app_withdraw',
                    amount: settlement.amount,
                    accountCode: account.code,
                    message: remoteResult.message,
                },
            });
            logger_1.logger.info({ settlementId, accountCode: account.code, amount: settlement.amount }, 'Settlement QRIS -> utama processed via app OrderKuota');
            return {
                settlementId,
                status: 'done',
                referenceNo,
                message: remoteResult.message,
            };
        }
        if (settlement.fromWallet === 'utama' && settlement.toWallet === 'madera') {
            if (!settlement.qrisAccountId) {
                throw new Error('Akun merchant wajib dipilih untuk topup Madera.');
            }
            const { account, fallbackIndex } = await resolveSettlementAccountContext(settlement.qrisAccountId);
            const beforeMainHistory = await app_orkut_gateway_1.appGateway.fetchBalanceHistory(account);
            const availableMain = beforeMainHistory.mainBalance ?? account.lastMainBalance ?? 0;
            if (settlement.amount % 1000 !== 0) {
                throw new Error('Nominal topup Madera harus kelipatan Rp 1.000.');
            }
            if (availableMain < settlement.amount) {
                throw new Error(`Saldo utama tidak cukup (saldo: ${availableMain}, diminta: ${settlement.amount})`);
            }
            const remoteResult = await app_orkut_gateway_1.appGateway.topupMadera(account, settlement.amount);
            if (!remoteResult.success) {
                throw new Error(remoteResult.message || 'Topup Madera gagal diproses.');
            }
            const afterMainHistory = await app_orkut_gateway_1.appGateway.fetchBalanceHistory(account);
            const maderaSnapshot = await (0, orkut_panel_service_1.syncOrkutBalanceSnapshot)(account, fallbackIndex).catch(() => null);
            const nextMainBalance = afterMainHistory.mainBalance ?? Math.max(0, availableMain - settlement.amount);
            const nextMaderaBalance = maderaSnapshot?.maderaBalance ?? (account.lastMaderaBalance ?? 0) + settlement.amount;
            await persistAppSettlementBalances(account.id, {
                mainBalance: nextMainBalance,
                maderaBalance: nextMaderaBalance,
                raw: {
                    source: 'orkut_app_topup_madera',
                    beforeMainHistory,
                    topup: remoteResult.raw,
                    afterMainHistory,
                    maderaSnapshot,
                },
                status: 'synced',
            });
            const referenceNo = remoteResult.detailsId ?? `MDR-${Date.now()}-${settlementId.slice(0, 6).toUpperCase()}`;
            await database_1.db.settlementRequest.update({
                where: { id: settlementId },
                data: {
                    status: 'done',
                    processedAt: new Date(),
                    referenceNo,
                    note: settlement.note
                        ? `${settlement.note} | ${remoteResult.message}`
                        : remoteResult.message,
                },
            });
            await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
                action: 'settlement_processed',
                entityType: 'SettlementRequest',
                entityId: settlementId,
                detail: {
                    mode: 'orkut_app_topup_madera',
                    referenceNo: remoteResult.detailsId,
                    amount: settlement.amount,
                    accountCode: account.code,
                },
            });
            logger_1.logger.info({ settlementId, accountCode: account.code, amount: settlement.amount, referenceNo: remoteResult.detailsId }, 'Settlement utama -> madera processed via app OrderKuota');
            return {
                settlementId,
                status: 'done',
                referenceNo,
                message: remoteResult.message,
            };
        }
        if (settlement.toWallet === 'bank') {
            if (!settlement.qrisAccountId) {
                throw new Error('Akun merchant wajib dipilih untuk transfer bank.');
            }
            if (!settlement.bankCode || !settlement.bankAccount) {
                throw new Error('Bank tujuan dan nomor rekening wajib diisi.');
            }
            if (settlement.fromWallet !== 'madera') {
                throw new Error('Urutan settlement yang benar adalah QRIS -> Utama -> Madera -> Bank. Kirim uang ke bank hanya boleh dari saldo Madera.');
            }
            if (settlement.amount < 10000) {
                throw new Error('Minimal transfer bank dari Saldo Madera Rp 10.000.');
            }
            const { account, fallbackIndex } = await resolveSettlementAccountContext(settlement.qrisAccountId);
            if (account.lastMaderaBalance === null || account.lastMaderaBalance === undefined) {
                throw new Error('Saldo Madera akun ini belum tersedia karena merchant belum verifikasi Madera. Fitur Kirim Uang belum diaktifkan untuk akun ini.');
            }
            if (!account.transferPinEncrypted) {
                throw new Error('PIN merchant belum diisi. Tambahkan PIN di menu Merchant QR agar Kirim Uang bisa berjalan otomatis.');
            }
            const transferPin = (0, encryption_1.decrypt)(account.transferPinEncrypted);
            const inquiry = await inquireSettlementBankPreferred(account, fallbackIndex, {
                fromWallet: 'madera',
                bankCode: settlement.bankCode,
                bankAccount: settlement.bankAccount,
                amount: settlement.amount,
            });
            const feeAmount = inquiry.fee ?? 0;
            let availableMadera = account.lastMaderaBalance ?? 0;
            try {
                const _mov = await app_orkut_gateway_1.appGateway.fetchMaderaTransferOverview(account);
                if (_mov && typeof _mov.accountBalance === 'number') {
                    availableMadera = _mov.accountBalance;
                    if (_mov.accountBalance !== account.lastMaderaBalance) {
                        await database_1.db.qrisAccount.update({ where: { id: account.id }, data: { lastMaderaBalance: _mov.accountBalance } }).catch(() => { });
                    }
                }
            }
            catch (_e) { /* fallback ke lastMaderaBalance DB */ }
            const totalRequired = settlement.amount + Math.max(0, feeAmount);
            if (availableMadera < totalRequired) {
                throw new Error(`Saldo Madera tidak cukup (saldo: ${availableMadera}, butuh: ${totalRequired})`);
            }
            const transferResult = await transferSettlementBankPreferred(account, fallbackIndex, {
                bankCode: inquiry.bankCode || settlement.bankCode,
                bankName: inquiry.bankName || settlement.bankName || settlement.bankCode,
                accountNumber: inquiry.accountNumber || settlement.bankAccount,
                accountName: inquiry.accountName,
                amount: settlement.amount,
                sessionId: inquiry.sessionId,
                pin: transferPin,
            });
            if (!transferResult.success) {
                throw new Error(transferResult.message || 'Transfer bank dari saldo Madera gagal diproses.');
            }
            const maderaSnapshot = await (0, orkut_panel_service_1.syncOrkutBalanceSnapshot)(account, fallbackIndex).catch(() => null);
            await persistAppSettlementBalances(account.id, {
                maderaBalance: maderaSnapshot?.maderaBalance ?? Math.max(0, availableMadera - totalRequired),
                raw: {
                    source: 'orkut_panel_madera_transfer',
                    inquiry: inquiry.raw,
                    transfer: transferResult.raw,
                    maderaSnapshot,
                },
                status: transferResult.status === 'done' ? 'synced' : 'processing',
            });
            const nextNote = settlement.note
                ? `${settlement.note} | ${transferResult.message || ''}`.trim()
                : (transferResult.message || null);
            const noteWithMarkers = buildSettlementNote(nextNote, {
                fee: feeAmount,
                total: settlement.amount + Math.max(0, feeAmount),
                redirectUrl: transferResult.redirectUrl ?? null,
            });
            await database_1.db.settlementRequest.update({
                where: { id: settlementId },
                data: {
                    status: transferResult.status === 'done' ? 'done' : 'processing',
                    processedAt: transferResult.status === 'done' ? new Date() : null,
                    referenceNo: transferResult.referenceNo ?? `MBK-${Date.now()}-${settlementId.slice(0, 6).toUpperCase()}`,
                    note: noteWithMarkers,
                },
            });
            await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
                action: 'settlement_processed',
                entityType: 'SettlementRequest',
                entityId: settlementId,
                detail: {
                    mode: 'orkut_panel_madera_transfer',
                    referenceNo: transferResult.referenceNo,
                    amount: settlement.amount,
                    feeAmount,
                    accountCode: account.code,
                    bankCode: settlement.bankCode,
                    bankAccount: settlement.bankAccount,
                    status: transferResult.status,
                },
            });
            logger_1.logger.info({
                settlementId,
                accountCode: account.code,
                amount: settlement.amount,
                feeAmount,
                status: transferResult.status,
                referenceNo: transferResult.referenceNo,
            }, 'Settlement madera -> bank processed via settlement web panel');
            return {
                settlementId,
                status: transferResult.status === 'done' ? 'done' : 'processing',
                referenceNo: transferResult.referenceNo ?? null,
                message: transferResult.message,
                redirectUrl: transferResult.redirectUrl ?? null,
            };
        }
        // Validate balance for wallet-sourced settlements
        if (settlement.fromWallet === 'utama' || settlement.fromWallet === 'madera') {
            const balance = await (0, wallet_ledger_service_1.getWalletBalance)(settlement.fromWallet);
            if (balance < settlement.amount) {
                throw new Error(`Saldo ${settlement.fromWallet} tidak cukup (saldo: ${balance}, diminta: ${settlement.amount})`);
            }
        }
        // For qris → utama/madera: debit from 'utama' (where deposits land) as source
        // (qris funds are already in utama after deposit_success; this is a logical transfer)
        if (settlement.fromWallet === 'qris') {
            const utamaBalance = await (0, wallet_ledger_service_1.getWalletBalance)('utama');
            if (utamaBalance < settlement.amount) {
                throw new Error(`Saldo utama tidak cukup untuk settlement qris (saldo: ${utamaBalance}, diminta: ${settlement.amount})`);
            }
            await (0, wallet_ledger_service_1.recordWalletEntry)({
                walletCode: 'utama',
                amount: -settlement.amount,
                refType: 'settlement_out',
                refId: settlementId,
                description: `Settlement ke ${settlement.toWallet} — #${settlementId.slice(0, 8)}`,
            });
        }
        else {
            // Debit source wallet
            await (0, wallet_ledger_service_1.recordWalletEntry)({
                walletCode: settlement.fromWallet,
                amount: -settlement.amount,
                refType: 'settlement_out',
                refId: settlementId,
                description: `Settlement ke ${settlement.toWallet} — #${settlementId.slice(0, 8)}`,
            });
        }
        // Credit destination wallet (only if it's an internal wallet)
        if (settlement.toWallet === 'utama' || settlement.toWallet === 'madera') {
            await (0, wallet_ledger_service_1.recordWalletEntry)({
                walletCode: settlement.toWallet,
                amount: settlement.amount,
                refType: 'settlement_in',
                refId: settlementId,
                description: `Penerimaan settlement dari ${settlement.fromWallet} — #${settlementId.slice(0, 8)}`,
            });
        }
        // toWallet='bank': external mock transfer — no wallet ledger credit, just mark done
        // Generate a mock reference number
        const referenceNo = `STLMNT-${Date.now()}-${settlementId.slice(0, 6).toUpperCase()}`;
        await database_1.db.settlementRequest.update({
            where: { id: settlementId },
            data: {
                status: 'done',
                processedAt: new Date(),
                referenceNo,
            },
        });
        await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
            action: 'settlement_processed',
            entityType: 'SettlementRequest',
            entityId: settlementId,
            detail: { referenceNo, amount: settlement.amount },
        });
        logger_1.logger.info({ settlementId, referenceNo, amount: settlement.amount }, 'Settlement processed');
        return {
            settlementId,
            status: 'done',
            referenceNo,
            message: null,
        };
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await database_1.db.settlementRequest.update({
            where: { id: settlementId },
            data: { status: 'failed', note: `${settlement.note ? settlement.note + ' | ' : ''}Error: ${errorMsg}` },
        });
        logger_1.logger.error({ settlementId, error: errorMsg }, 'Settlement processing failed');
        return {
            settlementId,
            status: 'failed',
            message: errorMsg,
        };
    }
}
async function inquireSettlementBankAccount(input) {
    const { account, fallbackIndex } = await resolveSettlementAccountContext(input.qrisAccountId);
    const inquiry = await inquireSettlementBankPreferred(account, fallbackIndex, input);
    return {
        accountName: inquiry.accountName,
        accountNumber: inquiry.accountNumber || input.bankAccount,
        bankCode: inquiry.bankCode || input.bankCode,
        bankName: inquiry.bankName || input.bankCode,
        fee: inquiry.fee ?? null,
        message: inquiry.message ?? null,
    };
}
async function listSettlementTransferBanks(qrisAccountId) {
    const { account, fallbackIndex } = await resolveSettlementAccountContext(qrisAccountId);
    return listSettlementTransferBanksInternal(account, fallbackIndex);
}
async function reconcileProcessingMaderaTransfers(accountId) {
    const where = {
        fromWallet: 'madera',
        toWallet: 'bank',
        status: 'processing',
    };
    if (accountId)
        where.qrisAccountId = accountId;
    const pendingSettlements = await database_1.db.settlementRequest.findMany({
        where,
        orderBy: { createdAt: 'asc' },
    });
    if (pendingSettlements.length === 0)
        return 0;
    const byAccount = new Map();
    for (const settlement of pendingSettlements) {
        if (!settlement.qrisAccountId)
            continue;
        const items = byAccount.get(settlement.qrisAccountId) ?? [];
        items.push(settlement);
        byAccount.set(settlement.qrisAccountId, items);
    }
    let reconciledCount = 0;
    for (const [qrisAccountId, settlements] of byAccount.entries()) {
        const { account } = await resolveSettlementAccountContext(qrisAccountId);
        const historyEntries = await fetchMaderaHistory(account).catch((err) => {
            logger_1.logger.warn({ err, accountCode: account.code }, 'reconcileProcessingMaderaTransfers: unable to fetch madera history');
            return [];
        });
        if (historyEntries.length === 0)
            continue;
        const newestBalance = historyEntries[0]?.balanceAfter ?? account.lastMaderaBalance ?? 0;
        await persistAppSettlementBalances(account.id, {
            maderaBalance: newestBalance,
            raw: {
                source: 'madera_history_reconcile',
                mutationCount: historyEntries.length,
            },
            status: 'synced',
        });
        for (const settlement of settlements) {
            const matched = findSettlementTransferMatch(settlement, historyEntries);
            if (!matched)
                continue;
            const feeAmount = matched.fee?.amount ?? parseRawSettlementNoteMarkers(settlement.note).fee ?? 2500;
            const totalAmount = settlement.amount + Math.max(0, feeAmount);
            const parsedNote = parseRawSettlementNoteMarkers(settlement.note);
            const detail = [
                parsedNote.cleanNote,
                `Mutasi Madera terdeteksi otomatis.`,
            ].filter(Boolean).join(' | ');
            await database_1.db.settlementRequest.update({
                where: { id: settlement.id },
                data: {
                    status: 'done',
                    processedAt: matched.transfer.transactionTime,
                    note: buildSettlementNote(detail, {
                        fee: feeAmount,
                        total: totalAmount,
                        redirectUrl: parsedNote.redirectUrl,
                    }),
                },
            });
            await (0, audit_log_service_1.writeAuditLog)(database_1.db, {
                action: 'settlement_reconciled_madera',
                entityType: 'SettlementRequest',
                entityId: settlement.id,
                detail: {
                    accountCode: account.code,
                    transferAmount: settlement.amount,
                    feeAmount,
                    totalAmount,
                    transferTime: matched.transfer.transactionTime.toISOString(),
                    feeTime: matched.fee?.transactionTime.toISOString() ?? null,
                },
            });
            reconciledCount += 1;
        }
    }
    if (reconciledCount > 0) {
        logger_1.logger.info({ reconciledCount, accountId }, 'Processing Madera transfers reconciled from history');
    }
    return reconciledCount;
}
/**
 * Lists settlement requests with optional filters.
 */
async function listSettlements(opts) {
    const where = {};
    if (opts?.status)
        where.status = opts.status;
    const [settlements, total] = await Promise.all([
        database_1.db.settlementRequest.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: opts?.limit ?? 50,
            skip: opts?.offset ?? 0,
        }),
        database_1.db.settlementRequest.count({ where }),
    ]);
    return { settlements, total };
}
//# sourceMappingURL=settlement.service.js.map