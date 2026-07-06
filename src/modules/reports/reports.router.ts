import { Router } from 'express';
import { requireAuth } from '../../core/auth.middleware';
import { requirePermission } from '../../core/rbac.middleware';
import { showReports, getReportsSummary } from './reports.controller';

const router = Router();

// Admin view
router.get('/', requireAuth, requirePermission('report:view'), showReports);

// Internal API endpoint (session auth)
router.get(
  '/summary',
  requireAuth,
  requirePermission('report:view'),
  getReportsSummary,
);

export { router as reportsRouter };
