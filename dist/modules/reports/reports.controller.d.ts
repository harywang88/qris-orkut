import { Request, Response } from 'express';
/**
 * GET /reports — Full report page: filter tanggal + rincian per SITE + FEE/FEE2.
 */
export declare function showReports(req: Request, res: Response): Promise<void>;
/**
 * GET /api/v1/reports/summary — JSON API dengan rentang tanggal + optional clientId.
 */
export declare function getReportsSummary(req: Request, res: Response): Promise<void>;
