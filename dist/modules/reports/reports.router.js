"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportsRouter = void 0;
const express_1 = require("express");
const auth_middleware_1 = require("../../core/auth.middleware");
const rbac_middleware_1 = require("../../core/rbac.middleware");
const reports_controller_1 = require("./reports.controller");
const router = (0, express_1.Router)();
exports.reportsRouter = router;
// Admin view
router.get('/', auth_middleware_1.requireAuth, (0, rbac_middleware_1.requirePermission)('report:view'), reports_controller_1.showReports);
// Internal API endpoint (session auth)
router.get('/summary', auth_middleware_1.requireAuth, (0, rbac_middleware_1.requirePermission)('report:view'), reports_controller_1.getReportsSummary);
//# sourceMappingURL=reports.router.js.map