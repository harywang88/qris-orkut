"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showAccountList = showAccountList;
exports.showNewAccountForm = showNewAccountForm;
exports.handleCreateAccount = handleCreateAccount;
exports.showEditAccountForm = showEditAccountForm;
exports.handleUpdateAccount = handleUpdateAccount;
exports.handleDeleteAccount = handleDeleteAccount;
exports.handleToggleStatus = handleToggleStatus;
exports.handleSetHealth = handleSetHealth;
exports.handleResetDailyUsage = handleResetDailyUsage;
exports.handleCreateSite = handleCreateSite;
exports.handleUpdateSite = handleUpdateSite;
exports.handleDeleteSite = handleDeleteSite;
exports.handleAssignSite = handleAssignSite;
const zod_1 = require("zod");
const qris_accounts_service_1 = require("./qris-accounts.service");
const site_service_1 = require("../../shared/site.service");
const database_1 = require("../../config/database");
const config_1 = require("../../config");
const logger_1 = require("../../config/logger");
const base_path_1 = require("../../core/base-path");
function optionalInt(min, max) {
    return zod_1.z.preprocess((value) => {
        if (value === '' || value === null || value === undefined)
            return undefined;
        if (typeof value === 'string' && value.trim() === '')
            return undefined;
        const parsed = typeof value === 'string' ? Number(value) : Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }, zod_1.z.number().int().min(min).max(max).optional());
}
function optionalText(max) {
    return zod_1.z.preprocess((value) => {
        if (value === null || value === undefined)
            return undefined;
        if (typeof value !== 'string')
            return value;
        const trimmed = value.trim();
        return trimmed === '' ? undefined : trimmed;
    }, zod_1.z.string().max(max).optional());
}
const QrisAccountCreateSchema = zod_1.z.object({
    code: zod_1.z.string().min(1).max(10).regex(/^[A-Z0-9]+$/i, 'Kode hanya boleh huruf dan angka'),
    accountNumber: zod_1.z.string().trim().min(1).max(50),
    merchantName: zod_1.z.string().trim().min(1).max(100),
    orkutAccountIndex: optionalInt(1, 999),
    dailyLimit: zod_1.z.coerce.number().int().min(0).default(30000000),
    qrisPayload: optionalText(2000),
    sessionToken: optionalText(1000),
    cookies: optionalText(5000),
    deviceId: optionalText(100),
});
const QrisAccountUpdateSchema = zod_1.z.object({
    code: optionalText(10).refine((value) => value === undefined || /^[A-Z0-9]+$/i.test(value), {
        message: 'Kode hanya boleh huruf dan angka',
    }),
    accountNumber: optionalText(50),
    merchantName: optionalText(100),
    orkutAccountIndex: optionalInt(1, 999),
    dailyLimit: zod_1.z.preprocess((value) => {
        if (value === '' || value === null || value === undefined)
            return undefined;
        return value;
    }, zod_1.z.coerce.number().int().min(0).optional()),
    qrisPayload: optionalText(2000),
    sessionToken: optionalText(1000),
    cookies: optionalText(5000),
    deviceId: optionalText(100),
});
function computeLiveHealth(a) {
    if (a.status !== 'active')
        return a.healthStatus || 'down';
    if (!a.sessionTokenEncrypted)
        return 'down';
    const errored = !!a.lastBalanceSyncError ||
        a.lastBalanceSyncStatus === 'error' ||
        a.lastBalanceSyncStatus === 'failed';
    if (errored)
        return 'degraded';
    const ageMs = a.lastBalanceSyncAt ? Date.now() - new Date(a.lastBalanceSyncAt).getTime() : null;
    if (ageMs !== null && ageMs > 24 * 60 * 60 * 1000)
        return 'degraded'; // sync macet >24 jam
    return 'healthy';
}
async function showAccountList(req, res) {
    try {
        const accounts = await (0, qris_accounts_service_1.listQrisAccounts)();
        const sites = (0, site_service_1.listSites)();
        // "Penggunaan Harian" = total PAID hari ini (WIB) per akun — SAMA seperti Kirim Uang.
        const WIB_MS = 7 * 60 * 60 * 1000;
        const todayWibStart = new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
        const paidAgg = await database_1.db.transaction.groupBy({
            by: ['qrisAccountId'],
            where: { statusPay: 'paid', paidAt: { gte: todayWibStart } },
            _sum: { finalAmount: true },
        });
        const paidTodayMap = {};
        for (const r of paidAgg) {
            if (r.qrisAccountId)
                paidTodayMap[r.qrisAccountId] = r._sum.finalAmount || 0;
        }
        const accountsWithSite = (0, site_service_1.attachSiteInfo)(accounts).map((a) => ({
            ...a,
            usedToday: paidTodayMap[a.id] || 0,
            healthStatus: computeLiveHealth(a),
        }));
        res.render('qris-accounts/index', {
            title: 'Akun QRIS',
            accounts: accountsWithSite,
            sites,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showAccountList error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function showNewAccountForm(req, res) {
    res.render('qris-accounts/form', { title: 'Tambah Akun QRIS', account: null, errors: null });
}
async function handleCreateAccount(req, res) {
    const parsed = QrisAccountCreateSchema.safeParse(req.body);
    if (!parsed.success) {
        res.render('qris-accounts/form', {
            title: 'Tambah Akun QRIS',
            account: null,
            errors: parsed.error.flatten().fieldErrors,
        });
        return;
    }
    try {
        await (0, qris_accounts_service_1.createQrisAccount)(parsed.data);
        req.session.flash = { type: 'success', message: 'Akun QRIS berhasil ditambahkan.' };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal menambahkan akun QRIS';
        res.render('qris-accounts/form', {
            title: 'Tambah Akun QRIS',
            account: null,
            errors: { _form: [message] },
        });
    }
}
async function showEditAccountForm(req, res) {
    try {
        const account = await (0, qris_accounts_service_1.getQrisAccountById)(req.params.id);
        if (!account) {
            res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
            return;
        }
        res.render('qris-accounts/form', { title: `Edit Akun: ${account.code}`, account, errors: null });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showEditAccountForm error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function handleUpdateAccount(req, res) {
    const parsed = QrisAccountUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
        const account = await (0, qris_accounts_service_1.getQrisAccountById)(req.params.id);
        res.render('qris-accounts/form', {
            title: 'Edit Akun QRIS',
            account,
            errors: parsed.error.flatten().fieldErrors,
        });
        return;
    }
    try {
        await (0, qris_accounts_service_1.updateQrisAccount)(req.params.id, parsed.data);
        req.session.flash = { type: 'success', message: 'Akun QRIS berhasil diperbarui.' };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal memperbarui akun QRIS';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
}
async function handleDeleteAccount(req, res) {
    try {
        await (0, qris_accounts_service_1.deleteQrisAccount)(req.params.id);
        req.session.flash = { type: 'success', message: 'Akun QRIS berhasil dihapus.' };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : 'Gagal menghapus akun';
        req.session.flash = { type: 'error', message };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
}
async function handleToggleStatus(req, res) {
    try {
        const newStatus = await (0, qris_accounts_service_1.toggleAccountStatus)(req.params.id);
        res.json({ success: true, status: newStatus });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleToggleStatus error');
        res.status(500).json({ success: false, error: 'Gagal mengubah status' });
    }
}
async function handleSetHealth(req, res) {
    const { healthStatus } = req.body;
    if (!['healthy', 'degraded', 'down'].includes(healthStatus)) {
        res.status(400).json({ success: false, error: 'Status tidak valid' });
        return;
    }
    try {
        await (0, qris_accounts_service_1.setHealthStatus)(req.params.id, healthStatus);
        res.json({ success: true });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleSetHealth error');
        res.status(500).json({ success: false, error: 'Gagal mengubah status kesehatan' });
    }
}
async function handleResetDailyUsage(req, res) {
    try {
        await (0, qris_accounts_service_1.resetDailyUsage)(req.params.id);
        req.session.flash = { type: 'success', message: 'Penggunaan harian berhasil direset.' };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        logger_1.logger.error({ err }, 'handleResetDailyUsage error');
        req.session.flash = { type: 'error', message: 'Gagal mereset penggunaan harian.' };
        res.redirect((0, base_path_1.withBasePath)('/qris-accounts', config_1.config.APP_BASE_PATH));
    }
}
// ── Kelola Site (JSON sidecar) + assign akun -> site ──────────────────────────
function handleCreateSite(req, res) {
    try {
        const site = (0, site_service_1.createSite)(req.body && req.body.name);
        res.json({ success: true, site });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menambah site' });
    }
}
function handleUpdateSite(req, res) {
    try {
        const site = (0, site_service_1.updateSite)(req.params.sid, req.body && req.body.name);
        res.json({ success: true, site });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal mengubah site' });
    }
}
function handleDeleteSite(req, res) {
    try {
        (0, site_service_1.deleteSite)(req.params.sid);
        res.json({ success: true });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menghapus site' });
    }
}
function handleAssignSite(req, res) {
    try {
        (0, site_service_1.setAccountSite)(req.params.id, (req.body && req.body.siteId) || '');
        res.json({ success: true });
    }
    catch (err) {
        res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menetapkan site' });
    }
}
//# sourceMappingURL=qris-accounts.controller.js.map