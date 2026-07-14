import { Router } from 'express';
import { requireAuth } from '../../core/auth.middleware';
import { requireMenu } from '../../core/rbac.middleware';
import { showReports, getReportsSummary, setOpeningBalanceApi, setMaderaCorrectionApi, setAccountModalApi } from './reports.controller';

const router = Router();

// Admin view
router.get('/', requireAuth, requireMenu('reports'), showReports);
router.post('/opening-balance', requireAuth, requireMenu('reports'), setOpeningBalanceApi);
router.post('/madera-correction', requireAuth, requireMenu('reports'), setMaderaCorrectionApi);
router.post('/account-modal', requireAuth, requireMenu('reports'), setAccountModalApi);

// Internal API endpoint (session auth)
router.get(
  '/summary',
  requireAuth,
  requireMenu('reports'),
  getReportsSummary,
);

export { router as reportsRouter };
