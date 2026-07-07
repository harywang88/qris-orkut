"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qrisDevRouter = exports.qrisAdminRouter = exports.qrisClientRouter = void 0;
const express_1 = require("express");
const hmac_1 = require("../../core/hmac");
const auth_middleware_1 = require("../../core/auth.middleware");
const rbac_middleware_1 = require("../../core/rbac.middleware");
const transactions_controller_1 = require("./transactions.controller");
// ── Client-facing API (HMAC auth) ──────────────────────────────────────────
const clientRouter = (0, express_1.Router)();
exports.qrisClientRouter = clientRouter;
clientRouter.post('/generate', hmac_1.hmacMiddleware, transactions_controller_1.handleGenerateQr);
clientRouter.get('/:qrId/status', hmac_1.hmacOrSessionMiddleware, transactions_controller_1.handleGetStatus);
// ── Admin / internal API (session auth) ───────────────────────────────────
const adminRouter = (0, express_1.Router)();
exports.qrisAdminRouter = adminRouter;
adminRouter.post('/:qrId/recheck', auth_middleware_1.requireAuth, (0, rbac_middleware_1.requirePermission)('qris:manage'), transactions_controller_1.handleRecheck);
adminRouter.post('/:qrId/retry-deposit', auth_middleware_1.requireAuth, (0, rbac_middleware_1.requirePermission)('qris:manage'), transactions_controller_1.handleRetryDeposit);
// ── Dev-only: simulate payment ─────────────────────────────────────────────
// Only registered in app.ts when NODE_ENV !== 'production'
const devRouter = (0, express_1.Router)();
exports.qrisDevRouter = devRouter;
devRouter.post('/simulate-payment', transactions_controller_1.handleDevSimulate);
//# sourceMappingURL=transactions.router.js.map