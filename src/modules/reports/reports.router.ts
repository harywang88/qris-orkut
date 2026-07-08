import { Router } from 'express';
import { requireAuth } from '../../core/auth.middleware';
import { requireMenu } from '../../core/rbac.middleware';
import { showReports, getReportsSummary } from './reports.controller';

const router = Router();

// Admin view
router.get('/', requireAuth, requireMenu('reports'), showReports);

// Internal API endpoint (session auth)
router.get(
  '/summary',
  requireAuth,
  requireMenu('reports'),
  getReportsSummary,
);

export { router as reportsRouter };
