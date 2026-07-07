"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showSaldoUtama = showSaldoUtama;
exports.showMadera = showMadera;
const logger_1 = require("../../config/logger");
const wallet_ledger_service_1 = require("../../shared/wallet-ledger.service");
function formatRupiah(amount) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0,
    }).format(amount);
}
async function showSaldoUtama(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const [balance, { entries, total }] = await Promise.all([
            (0, wallet_ledger_service_1.getWalletBalance)('utama'),
            (0, wallet_ledger_service_1.getWalletLedger)('utama', limit, offset),
        ]);
        const totalCredit = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
        const totalDebit = entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
        const creditCount = entries.filter((e) => e.amount > 0).length;
        const debitCount = entries.filter((e) => e.amount < 0).length;
        res.render('wallet/saldo-utama', {
            title: 'Saldo Utama',
            walletCode: 'utama',
            balance,
            balanceFormatted: formatRupiah(balance),
            ledger: entries,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            totalCredit,
            totalDebit,
            creditCount,
            debitCount,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showSaldoUtama error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
async function showMadera(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const [balance, { entries, total }] = await Promise.all([
            (0, wallet_ledger_service_1.getWalletBalance)('madera'),
            (0, wallet_ledger_service_1.getWalletLedger)('madera', limit, offset),
        ]);
        const totalCredit = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
        const totalDebit = entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
        const creditCount = entries.filter((e) => e.amount > 0).length;
        const debitCount = entries.filter((e) => e.amount < 0).length;
        res.render('wallet/madera', {
            title: 'Madera',
            walletCode: 'madera',
            balance,
            balanceFormatted: formatRupiah(balance),
            ledger: entries,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            totalCredit,
            totalDebit,
            creditCount,
            debitCount,
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'showMadera error');
        res.status(500).render('error/500', { title: 'Error' });
    }
}
//# sourceMappingURL=wallet.controller.js.map