import { Router } from 'express';
import { requireMenuOrPermission } from '../../core/rbac.middleware';
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
  handleSyncAllMerchants,
  getSyncAllStatusApi,
  handleSaveWebReportUrl,
  handleTestWebReportUrl,
} from './merchant-qr.controller';

const router = Router();

const canManage = requireMenuOrPermission('merchant-qr', 'manage', 'qris:manage');

// Static routes MUST come before /:id dynamic routes
router.get('/', canManage, showMerchantQrList);
router.get('/new', canManage, showNewMerchantQrForm);
router.get('/api/status', canManage, getMerchantQrStatusApi);
router.post('/test-report-login', canManage, handleTestMerchantQrReportLogin);
router.post('/compare-sources', canManage, handleCompareMerchantQrSources);
router.post('/', canManage, handleCreateMerchantQr);
router.get('/sync-all/status', canManage, getSyncAllStatusApi);
router.post('/sync-all', canManage, handleSyncAllMerchants);
router.get('/:id/edit', canManage, showEditMerchantQrForm);
router.post('/:id', canManage, handleUpdateMerchantQr);
router.post('/:id/delete', canManage, handleDeleteMerchantQr);
router.post('/:id/toggle-status', canManage, handleToggleMerchantQrStatus);
router.post('/:id/set-health', canManage, handleSetMerchantQrHealth);
router.post('/:id/reset-daily', canManage, handleResetMerchantQrDailyUsage);
router.post('/:id/test-connection', canManage, handleTestMerchantQrConnection);
router.post('/:id/sync-now', canManage, handleSyncMerchantQrNow);
router.post('/:id/web-report-url', canManage, handleSaveWebReportUrl);
router.post('/:id/test-web-report', canManage, handleTestWebReportUrl);

export { router as merchantQrRouter };
