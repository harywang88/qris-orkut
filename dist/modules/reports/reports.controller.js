"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showReports = showReports;
exports.getReportsSummary = getReportsSummary;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const site_service_1 = require("../../shared/site.service");
const alias_access_service_1 = require("../../shared/alias-access.service");
// FIX #1: Batas hari dihitung dalam WIB (Asia/Jakarta, UTC+7), BUKAN zona server (UTC).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
function startOfDayWib(d) {
    const wib = new Date(d.getTime() + WIB_OFFSET_MS);
    const wibMidnightUtc = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), 0, 0, 0, 0);
    return new Date(wibMidnightUtc - WIB_OFFSET_MS);
}
function endOfDayWib(d) {
    return new Date(startOfDayWib(d).getTime() + 86400000 - 1);
}
// Label DD/MM dalam WIB untuk sumbu grafik.
function wibDayLabel(instant) {
    const wib = new Date(instant.getTime() + WIB_OFFSET_MS);
    return `${String(wib.getUTCDate()).padStart(2, '0')}/${String(wib.getUTCMonth() + 1).padStart(2, '0')}`;
}
function _parseMoneyLike(value) {
    if (value == null)
        return 0;
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.abs(Math.round(value));
    let text = String(value).trim();
    if (!text)
        return 0;
    text = text.replace(/rp/gi, '').replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
    if (!text)
        return 0;
    text = text.replace(/\./g, '').replace(/,/g, '.');
    const parsed = Number(text);
    return Number.isFinite(parsed) ? Math.abs(Math.round(parsed)) : 0;
}
function _parseRaw(m) {
    try {
        return JSON.parse(m.rawDataJson || '{}') || {};
    }
    catch {
        return {};
    }
}
function _descOf(m) {
    const raw = _parseRaw(m);
    return String(m.description || raw.keterangan || raw.description || raw.note || '-').trim();
}
// QRIS "Biaya Layanan" (0,3% OrderKuota utk bayar >500rb).
function qrisServiceFee(m) {
    const raw = _parseRaw(m);
    const direct = _parseMoneyLike(raw.fee_user ?? raw.feeUser ?? raw.fee ?? raw.admin ?? raw.biaya_layanan ?? raw.biayaLayanan);
    if (direct > 0)
        return direct;
    const nett = _parseMoneyLike(raw.amount_nett ?? raw.amountNett);
    if (nett > 0 && (m.amount || 0) > nett)
        return Math.max(0, Math.round((m.amount || 0) - nett));
    return 0;
}
// Utama "Biaya Percepatan Pencairan QRIS / Biaya QRIS 1%".
function utamaOnePercentFee(m) {
    const raw = _parseRaw(m);
    const c = [raw.biaya_percepatan_pencairan_qris, raw.biaya_percepatan, raw.biaya_pencairan, raw.service_fee, raw.fee];
    for (const x of c) {
        if (x === null || x === undefined)
            continue;
        const p = Number(String(x).replace(/[^\d-]/g, ''));
        if (Number.isFinite(p) && p > 0)
            return p;
    }
    const t = _descOf(m).toLowerCase();
    const feeRow = t.includes('biaya percepatan pencairan qris') ||
        (t.includes('biaya percepatan') && t.includes('qris')) ||
        t.includes('biaya percepatan pencairan');
    return feeRow ? Math.abs(Number(m.amount || 0)) : 0;
}
function _sumFee(map, accIds) {
    return accIds.reduce((s, id) => s + (map[id] || 0), 0);
}
/**
 * GET /reports — Full report page: filter tanggal + rincian per SITE + FEE/FEE2.
 */
async function showReports(req, res) {
    try {
        const today = new Date();
        const range = req.query.range || 'today';
        let from;
        let to;
        if (range === 'yesterday') {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            from = startOfDayWib(yesterday);
            to = endOfDayWib(yesterday);
        }
        else if (range === 'custom' && req.query.from && req.query.to) {
            from = startOfDayWib(new Date(req.query.from));
            to = endOfDayWib(new Date(req.query.to));
            if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                from = startOfDayWib(today);
                to = endOfDayWib(today);
            }
        }
        else {
            from = startOfDayWib(today);
            to = endOfDayWib(today);
        }
        // ── Per-SITE breakdown (Site = unit bisnis; diturunkan dari AKUN via site.service) ──
        // Fase 6: alias-tenant -> paksa lihat site-nya saja (abaikan ?site= dari query).
        const _aliasScope = (0, alias_access_service_1.getSiteScopeForUser)(req.session.user);
        const sites = _aliasScope ? (0, site_service_1.listSites)().filter((s) => s.id === _aliasScope) : (0, site_service_1.listSites)();
        const accountsAll = await database_1.db.qrisAccount.findMany({ select: { id: true } });
        const accSiteMap = (0, site_service_1.getAccountSiteMap)();
        const noneAccountIds = accountsAll.filter((a) => !accSiteMap[a.id]).map((a) => a.id);
        const hasNoneBucket = noneAccountIds.length > 0;
        const siteBuckets = sites
            .map((s) => ({
            key: s.id,
            name: s.name,
            accountIds: accountsAll.filter((a) => accSiteMap[a.id] === s.id).map((a) => a.id),
        }))
            .filter((b) => b.accountIds.length > 0);
        const allBuckets = siteBuckets.slice();
        if (hasNoneBucket)
            allBuckets.push({ key: 'none', name: 'Tanpa site', accountIds: noneAccountIds });
        // '' = Semua Site (gabungan), siteId, atau 'none'. Alias-tenant dipaksa ke site-nya.
        const selectedSite = _aliasScope || (typeof req.query.site === 'string' ? req.query.site : '');
        let restrictAccountIds = null;
        if (selectedSite) {
            const sb = allBuckets.find((x) => x.key === selectedSite);
            restrictAccountIds = sb ? sb.accountIds : [];
        }
        const withAccount = (w) => restrictAccountIds ? { ...w, qrisAccountId: { in: restrictAccountIds } } : w;
        const bucketsToShow = selectedSite ? allBuckets.filter((b) => b.key === selectedSite) : allBuckets;
        // FEE (QRIS Biaya Layanan) + FEE2 (Utama 1%) dari MUTASI (transactionTime dalam periode), per akun.
        const [_qrisMuts, _utamaMuts] = await Promise.all([
            database_1.db.mutation.findMany({
                where: { walletCategory: 'qris', transactionTime: { gte: from, lte: to } },
                select: { amount: true, rawDataJson: true, qrisAccountId: true },
            }),
            database_1.db.mutation.findMany({
                where: { walletCategory: 'utama', transactionTime: { gte: from, lte: to } },
                select: { amount: true, rawDataJson: true, qrisAccountId: true },
            }),
        ]);
        const feeQrisByAcc = {};
        for (const m of _qrisMuts) {
            if (m.qrisAccountId)
                feeQrisByAcc[m.qrisAccountId] = (feeQrisByAcc[m.qrisAccountId] || 0) + qrisServiceFee(m);
        }
        const feeUtamaByAcc = {};
        for (const m of _utamaMuts) {
            if (m.qrisAccountId)
                feeUtamaByAcc[m.qrisAccountId] = (feeUtamaByAcc[m.qrisAccountId] || 0) + utamaOnePercentFee(m);
        }
        const overallAccIds = restrictAccountIds || accountsAll.map((a) => a.id);
        const siteBreakdown = await Promise.all(bucketsToShow.map(async (b) => {
            const baseWhere = { qrisAccountId: { in: b.accountIds }, createdAt: { gte: from, lte: to } };
            const [total, paid, expired, depositSuccess, depositFailed, manualReview, paidAgg] = await Promise.all([
                database_1.db.transaction.count({ where: baseWhere }),
                database_1.db.transaction.count({ where: { ...baseWhere, statusPay: 'paid' } }),
                database_1.db.transaction.count({ where: { ...baseWhere, statusPay: 'expired' } }),
                database_1.db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_success' } }),
                database_1.db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_failed' } }),
                database_1.db.transaction.count({ where: { ...baseWhere, statusBot: 'manual_review' } }),
                // FIX #2: uang (nominal + fee) by paidAt (tanggal DIBAYAR) agar COCOK dgn grafik.
                database_1.db.transaction.aggregate({
                    where: { qrisAccountId: { in: b.accountIds }, statusPay: 'paid', paidAt: { gte: from, lte: to } },
                    _sum: { finalAmount: true, feeAmount: true },
                }),
            ]);
            const totalPaid = paidAgg._sum.finalAmount ?? 0;
            const totalFee = _sumFee(feeQrisByAcc, b.accountIds);
            const fee2 = _sumFee(feeUtamaByAcc, b.accountIds);
            return {
                siteName: b.name,
                accountCount: b.accountIds.length,
                total,
                paid,
                expired,
                open: total - paid - expired,
                depositSuccess,
                depositFailed,
                manualReview,
                totalPaid,
                totalFee,
                fee2,
                netAmount: totalPaid - totalFee - fee2,
            };
        }));
        // Overall totals (hormati filter site)
        const overallWhere = withAccount({ createdAt: { gte: from, lte: to } });
        const [totalAll, paidAll, expiredAll, openAll, depSuccessAll, depFailedAll, manualReviewAll, paidAggAll] = await Promise.all([
            database_1.db.transaction.count({ where: overallWhere }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusPay: 'paid' } }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusPay: 'expired' } }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusPay: 'open' } }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusBot: 'deposit_success' } }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusBot: 'deposit_failed' } }),
            database_1.db.transaction.count({ where: { ...overallWhere, statusBot: 'manual_review' } }),
            database_1.db.transaction.aggregate({
                where: withAccount({ statusPay: 'paid', paidAt: { gte: from, lte: to } }),
                _sum: { finalAmount: true, feeAmount: true },
            }),
        ]);
        const overallTotalPaid = paidAggAll._sum.finalAmount ?? 0;
        const overallTotalFee = _sumFee(feeQrisByAcc, overallAccIds);
        const overallFee2 = _sumFee(feeUtamaByAcc, overallAccIds);
        // Grafik (nominal terbayar by paidAt, per HARI WIB). Selalu cakup seluruh rentang, <=31 batang.
        const totalDaysWib = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
        const MAX_BARS = 31;
        const chartBucketDays = Math.max(1, Math.ceil(totalDaysWib / MAX_BARS));
        const barCount = Math.max(1, Math.ceil(totalDaysWib / chartBucketDays));
        const buckets = [];
        for (let i = 0; i < barCount; i++) {
            const bStart = new Date(from.getTime() + i * chartBucketDays * 86400000);
            const bEndMs = Math.min(bStart.getTime() + chartBucketDays * 86400000 - 1, to.getTime());
            buckets.push({ start: bStart, end: new Date(bEndMs) });
        }
        const bucketResults = await Promise.all(buckets.map(async (bk) => {
            const [cnt, agg] = await Promise.all([
                database_1.db.transaction.count({ where: withAccount({ statusPay: 'paid', paidAt: { gte: bk.start, lte: bk.end } }) }),
                database_1.db.transaction.aggregate({
                    where: withAccount({ statusPay: 'paid', paidAt: { gte: bk.start, lte: bk.end } }),
                    _sum: { finalAmount: true },
                }),
            ]);
            return { label: wibDayLabel(bk.start), count: cnt, amount: agg._sum.finalAmount ?? 0 };
        }));
        const chartLabels = bucketResults.map((r) => r.label);
        const chartCounts = bucketResults.map((r) => r.count);
        const chartAmounts = bucketResults.map((r) => r.amount);
        res.render('reports/index', {
            title: 'Laporan',
            range,
            from,
            to,
            fromStr: req.query.from ?? '',
            toStr: req.query.to ?? '',
            sites,
            selectedSite,
            siteLocked: !!_aliasScope,
            hasNoneBucket,
            siteBreakdown,
            overall: {
                total: totalAll,
                paid: paidAll,
                expired: expiredAll,
                open: openAll,
                depositSuccess: depSuccessAll,
                depositFailed: depFailedAll,
                manualReview: manualReviewAll,
                totalPaid: overallTotalPaid,
                totalFee: overallTotalFee,
                fee2: overallFee2,
                netAmount: overallTotalPaid - overallTotalFee - overallFee2,
            },
            chartBucketDays,
            chartData: {
                labels: JSON.stringify(chartLabels),
                counts: JSON.stringify(chartCounts),
                amounts: JSON.stringify(chartAmounts),
            },
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showReports error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
/**
 * GET /api/v1/reports/summary — JSON API dengan rentang tanggal + optional clientId.
 */
async function getReportsSummary(req, res) {
    try {
        const today = new Date();
        const defaultFrom = startOfDayWib(today);
        const defaultTo = endOfDayWib(today);
        const from = req.query.from ? startOfDayWib(new Date(req.query.from)) : defaultFrom;
        const to = req.query.to ? endOfDayWib(new Date(req.query.to)) : defaultTo;
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
            res.status(400).json({ success: false, error: 'Parameter from/to tidak valid' });
            return;
        }
        const where = { createdAt: { gte: from, lte: to } };
        if (req.query.clientId)
            where.clientId = req.query.clientId;
        // FIX #2: uang by paidAt (pemasukan periode), bukan createdAt.
        const paidMoneyWhere = { statusPay: 'paid', paidAt: { gte: from, lte: to } };
        if (req.query.clientId)
            paidMoneyWhere.clientId = req.query.clientId;
        const [totalCount, paidCount, expiredCount, openCount] = await Promise.all([
            database_1.db.transaction.count({ where }),
            database_1.db.transaction.count({ where: { ...where, statusPay: 'paid' } }),
            database_1.db.transaction.count({ where: { ...where, statusPay: 'expired' } }),
            database_1.db.transaction.count({ where: { ...where, statusPay: 'open' } }),
        ]);
        const paidAggregate = await database_1.db.transaction.aggregate({
            where: paidMoneyWhere,
            _sum: { finalAmount: true, feeAmount: true },
        });
        const [depositSuccess, depositFailed, manualReview] = await Promise.all([
            database_1.db.transaction.count({ where: { ...where, statusBot: 'deposit_success' } }),
            database_1.db.transaction.count({ where: { ...where, statusBot: 'deposit_failed' } }),
            database_1.db.transaction.count({ where: { ...where, statusBot: 'manual_review' } }),
        ]);
        let perClient = [];
        if (!req.query.clientId) {
            const clients = await database_1.db.client.findMany({ select: { id: true, name: true, panelCode: true } });
            perClient = await Promise.all(clients.map(async (client) => {
                const cWhere = { ...where, clientId: client.id };
                const [cnt, paidCnt, agg] = await Promise.all([
                    database_1.db.transaction.count({ where: cWhere }),
                    database_1.db.transaction.count({ where: { ...cWhere, statusPay: 'paid' } }),
                    database_1.db.transaction.aggregate({
                        where: { clientId: client.id, statusPay: 'paid', paidAt: { gte: from, lte: to } },
                        _sum: { finalAmount: true, feeAmount: true },
                    }),
                ]);
                return {
                    clientId: client.id,
                    clientName: client.name,
                    panelCode: client.panelCode,
                    total: cnt,
                    paid: paidCnt,
                    totalPaid: agg._sum.finalAmount ?? 0,
                    totalFee: agg._sum.feeAmount ?? 0,
                };
            }));
        }
        res.json({
            success: true,
            data: {
                period: { from: from.toISOString(), to: to.toISOString() },
                transactions: { total: totalCount, paid: paidCount, expired: expiredCount, open: openCount },
                amounts: {
                    totalPaid: paidAggregate._sum.finalAmount ?? 0,
                    totalFee: paidAggregate._sum.feeAmount ?? 0,
                    netAmount: (paidAggregate._sum.finalAmount ?? 0) - (paidAggregate._sum.feeAmount ?? 0),
                },
                deposits: { success: depositSuccess, failed: depositFailed, manualReview },
                perClient,
            },
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'getReportsSummary error');
        res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
    }
}
//# sourceMappingURL=reports.controller.js.map