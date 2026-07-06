import { Router } from 'express';
import { requirePermission } from '../../core/rbac.middleware';
import {
  showMerchantQrList,
  showNewMerchantQrForm,
  handleCreateMerchantQr,
  showEditMerchantQrForm,
  handleUpdateMerchantQr,
  handleDeleteMerchantQr,
  handleToggleMerchantQrStatus,
  handleSetMerchantQrHealth,
  handleResetMerchantQrDailyUsage,
  handleTestMerchantQrConnection,
  handleCompareMerchantQrSources,
  handleTestMerchantQrReportLogin,
  handleSyncMerchantQrNow,
  getMerchantQrStatusApi,
} from './merchant-qr.controller';

const router = Router();

const canManage = requirePermission('qris:manage');

// Static routes MUST come before /:id dynamic routes
router.get('/', canManage, showMerchantQrList);
router.get('/new', canManage, showNewMerchantQrForm);
router.get('/api/status', canManage, getMerchantQrStatusApi);
router.post('/test-report-login', canManage, handleTestMerchantQrReportLogin);
router.post('/compare-sources', canManage, handleCompareMerchantQrSources);
router.post('/', canManage, handleCreateMerchantQr);
router.get('/:id/edit', canManage, showEditMerchantQrForm);
router.post('/:id', canManage, handleUpdateMerchantQr);
router.post('/:id/delete', canManage, handleDeleteMerchantQr);
router.post('/:id/toggle-status', canManage, handleToggleMerchantQrStatus);
router.post('/:id/set-health', canManage, handleSetMerchantQrHealth);
router.post('/:id/reset-daily', canManage, handleResetMerchantQrDailyUsage);
router.post('/:id/test-connection', canManage, handleTestMerchantQrConnection);
router.post('/:id/sync-now', canManage, handleSyncMerchantQrNow);

export { router as merchantQrRouter };
