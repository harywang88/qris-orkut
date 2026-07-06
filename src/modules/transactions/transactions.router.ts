import { Router } from 'express';
import { hmacMiddleware, hmacOrSessionMiddleware } from '../../core/hmac';
import { requireAuth } from '../../core/auth.middleware';
import { requirePermission } from '../../core/rbac.middleware';
import {
  handleGenerateQr,
  handleGetStatus,
  handleRecheck,
  handleRetryDeposit,
  handleDevSimulate,
} from './transactions.controller';

// ── Client-facing API (HMAC auth) ──────────────────────────────────────────
const clientRouter = Router();

clientRouter.post('/generate', hmacMiddleware, handleGenerateQr);
clientRouter.get('/:qrId/status', hmacOrSessionMiddleware, handleGetStatus);

// ── Admin / internal API (session auth) ───────────────────────────────────
const adminRouter = Router();

adminRouter.post(
  '/:qrId/recheck',
  requireAuth,
  requirePermission('qris:manage'),
  handleRecheck,
);

adminRouter.post(
  '/:qrId/retry-deposit',
  requireAuth,
  requirePermission('qris:manage'),
  handleRetryDeposit,
);

// ── Dev-only: simulate payment ─────────────────────────────────────────────
// Only registered in app.ts when NODE_ENV !== 'production'
const devRouter = Router();
devRouter.post('/simulate-payment', handleDevSimulate);

export { clientRouter as qrisClientRouter, adminRouter as qrisAdminRouter, devRouter as qrisDevRouter };
