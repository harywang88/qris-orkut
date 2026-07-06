import { Request, Response } from 'express';
import { db } from '../../config/database';
import { logger } from '../../config/logger';

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * GET /reports — Full report page with date filters and per-client breakdown.
 */
export async function showReports(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    const range = (req.query.range as string) || 'today';

    let from: Date;
    let to: Date;

    if (range === 'yesterday') {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      from = startOfDay(yesterday);
      to = endOfDay(yesterday);
    } else if (range === 'custom' && req.query.from && req.query.to) {
      from = startOfDay(new Date(req.query.from as string));
      to = endOfDay(new Date(req.query.to as string));
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        from = startOfDay(today);
        to = endOfDay(today);
      }
    } else {
      // default: today
      from = startOfDay(today);
      to = endOfDay(today);
    }

    const clients = await db.client.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, panelCode: true },
    });

    // Per-client breakdown
    const clientBreakdown = await Promise.all(
      clients.map(async (client) => {
        const baseWhere = {
          clientId: client.id,
          createdAt: { gte: from, lte: to },
        };

        const [total, paid, expired, depositSuccess, depositFailed, manualReview, paidAgg] =
          await Promise.all([
            db.transaction.count({ where: baseWhere }),
            db.transaction.count({ where: { ...baseWhere, statusPay: 'paid' } }),
            db.transaction.count({ where: { ...baseWhere, statusPay: 'expired' } }),
            db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_success' } }),
            db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_failed' } }),
            db.transaction.count({ where: { ...baseWhere, statusBot: 'manual_review' } }),
            db.transaction.aggregate({
              where: { ...baseWhere, statusPay: 'paid' },
              _sum: { finalAmount: true, feeAmount: true },
            }),
          ]);

        const totalPaid = paidAgg._sum.finalAmount ?? 0;
        const totalFee = paidAgg._sum.feeAmount ?? 0;

        return {
          client,
          total,
          paid,
          expired,
          open: total - paid - expired,
          depositSuccess,
          depositFailed,
          manualReview,
          totalPaid,
          totalFee,
          netAmount: totalPaid - totalFee,
        };
      }),
    );

    // Overall totals
    const overallWhere = { createdAt: { gte: from, lte: to } };
    const [totalAll, paidAll, expiredAll, paidAggAll] = await Promise.all([
      db.transaction.count({ where: overallWhere }),
      db.transaction.count({ where: { ...overallWhere, statusPay: 'paid' } }),
      db.transaction.count({ where: { ...overallWhere, statusPay: 'expired' } }),
      db.transaction.aggregate({
        where: { ...overallWhere, statusPay: 'paid' },
        _sum: { finalAmount: true, feeAmount: true },
      }),
    ]);

    const overallTotalPaid = paidAggAll._sum.finalAmount ?? 0;
    const overallTotalFee = paidAggAll._sum.feeAmount ?? 0;

    // Daily chart data for the selected range (max 31 days)
    const dayCount = Math.min(31, Math.ceil((to.getTime() - from.getTime()) / 86_400_000) + 1);
    const chartLabels: string[] = [];
    const chartAmounts: number[] = [];
    const chartCounts: number[] = [];

    for (let i = 0; i < dayCount; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      const dayStart = startOfDay(d);
      const dayEnd = endOfDay(d);

      const [cnt, agg] = await Promise.all([
        db.transaction.count({ where: { statusPay: 'paid', paidAt: { gte: dayStart, lte: dayEnd } } }),
        db.transaction.aggregate({
          where: { statusPay: 'paid', paidAt: { gte: dayStart, lte: dayEnd } },
          _sum: { finalAmount: true },
        }),
      ]);

      chartLabels.push(
        `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
      );
      chartCounts.push(cnt);
      chartAmounts.push(agg._sum.finalAmount ?? 0);
    }

    res.render('reports/index', {
      title: 'Laporan',
      range,
      from,
      to,
      fromStr: req.query.from ?? '',
      toStr: req.query.to ?? '',
      clientBreakdown,
      overall: {
        total: totalAll,
        paid: paidAll,
        expired: expiredAll,
        open: totalAll - paidAll - expiredAll,
        totalPaid: overallTotalPaid,
        totalFee: overallTotalFee,
        netAmount: overallTotalPaid - overallTotalFee,
      },
      chartData: {
        labels: JSON.stringify(chartLabels),
        counts: JSON.stringify(chartCounts),
        amounts: JSON.stringify(chartAmounts),
      },
    });
  } catch (err) {
    logger.error({ err }, 'showReports error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

/**
 * GET /api/v1/reports/summary
 *
 * JSON API with date range + optional clientId filter.
 * Includes per-client breakdown in the response.
 */
export async function getReportsSummary(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    const defaultFrom = startOfDay(today);
    const defaultTo = endOfDay(today);

    const from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
    const to = req.query.to ? new Date(req.query.to as string) : defaultTo;

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      res.status(400).json({ success: false, error: 'Parameter from/to tidak valid' });
      return;
    }

    const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } };
    if (req.query.clientId) where.clientId = req.query.clientId;

    const [totalCount, paidCount, expiredCount, openCount] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.count({ where: { ...where, statusPay: 'paid' } }),
      db.transaction.count({ where: { ...where, statusPay: 'expired' } }),
      db.transaction.count({ where: { ...where, statusPay: 'open' } }),
    ]);

    const paidAggregate = await db.transaction.aggregate({
      where: { ...where, statusPay: 'paid' },
      _sum: { finalAmount: true, feeAmount: true },
    });

    const [depositSuccess, depositFailed, manualReview] = await Promise.all([
      db.transaction.count({ where: { ...where, statusBot: 'deposit_success' } }),
      db.transaction.count({ where: { ...where, statusBot: 'deposit_failed' } }),
      db.transaction.count({ where: { ...where, statusBot: 'manual_review' } }),
    ]);

    // Per-client breakdown (only if no clientId filter)
    let perClient: Array<{
      clientId: string;
      clientName: string;
      panelCode: string;
      total: number;
      paid: number;
      totalPaid: number;
      totalFee: number;
    }> = [];

    if (!req.query.clientId) {
      const clients = await db.client.findMany({
        select: { id: true, name: true, panelCode: true },
      });
      perClient = await Promise.all(
        clients.map(async (client) => {
          const cWhere = { ...where, clientId: client.id };
          const [cnt, paidCnt, agg] = await Promise.all([
            db.transaction.count({ where: cWhere }),
            db.transaction.count({ where: { ...cWhere, statusPay: 'paid' } }),
            db.transaction.aggregate({
              where: { ...cWhere, statusPay: 'paid' },
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
        }),
      );
    }

    res.json({
      success: true,
      data: {
        period: { from: from.toISOString(), to: to.toISOString() },
        transactions: { total: totalCount, paid: paidCount, expired: expiredCount, open: openCount },
        amounts: {
          totalPaid: paidAggregate._sum.finalAmount ?? 0,
          totalFee: paidAggregate._sum.feeAmount ?? 0,
          netAmount:
            (paidAggregate._sum.finalAmount ?? 0) - (paidAggregate._sum.feeAmount ?? 0),
        },
        deposits: { success: depositSuccess, failed: depositFailed, manualReview },
        perClient,
      },
    });
  } catch (err) {
    logger.error({ err }, 'getReportsSummary error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}
