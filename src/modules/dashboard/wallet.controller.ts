import { Request, Response } from 'express';
import { logger } from '../../config/logger';
import { getWalletBalance, getWalletLedger } from '../../shared/wallet-ledger.service';

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}

export async function showSaldoUtama(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [balance, { entries, total }] = await Promise.all([
      getWalletBalance('utama'),
      getWalletLedger('utama', limit, offset),
    ]);

    const totalCredit = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const totalDebit  = entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const creditCount = entries.filter((e) => e.amount > 0).length;
    const debitCount  = entries.filter((e) => e.amount < 0).length;

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
  } catch (err) {
    logger.error({ err }, 'showSaldoUtama error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showMadera(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const [balance, { entries, total }] = await Promise.all([
      getWalletBalance('madera'),
      getWalletLedger('madera', limit, offset),
    ]);

    const totalCredit = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const totalDebit  = entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const creditCount = entries.filter((e) => e.amount > 0).length;
    const debitCount  = entries.filter((e) => e.amount < 0).length;

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
  } catch (err) {
    logger.error({ err }, 'showMadera error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}
