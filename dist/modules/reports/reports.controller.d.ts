import { Request, Response } from 'express';
/**
 * GET /reports — Full report page with date filters and per-client breakdown.
 */
export declare function showReports(req: Request, res: Response): Promise<void>;
/**
 * GET /api/v1/reports/summary
 *
 * JSON API with date range + optional clientId filter.
 * Includes per-client breakdown in the response.
 */
export declare function getReportsSummary(req: Request, res: Response): Promise<void>;
