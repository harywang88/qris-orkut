import { Request, Response } from 'express';
/**
 * POST /api/v1/qris/generate
 * Requires HMAC authentication (req.client is set by hmacMiddleware).
 */
export declare function handleGenerateQr(req: Request, res: Response): Promise<void>;
/**
 * GET /api/v1/qris/:qrId/status
 * Requires HMAC authentication.
 */
export declare function handleGetStatus(req: Request, res: Response): Promise<void>;
/**
 * POST /api/v1/qris/:qrId/recheck
 * Admin-only: triggers a recheck request and returns current status.
 */
export declare function handleRecheck(req: Request, res: Response): Promise<void>;
/**
 * POST /api/v1/qris/:qrId/retry-deposit
 * Admin-only: manually queue a failed/reviewed transaction for deposit retry.
 */
export declare function handleRetryDeposit(req: Request, res: Response): Promise<void>;
/**
 * POST /dev/simulate-payment
 * Dev-only: creates a mock mutation for an open transaction.
 * The worker picks it up within 1.5 seconds.
 * BLOCKED in production.
 */
export declare function handleDevSimulate(req: Request, res: Response): Promise<void>;
