import { Router } from 'express';
import { requirePermission } from '../../core/rbac.middleware';
import {
  showDashboard,
  showHistory,
  showTransactions,
  showMutations,
  showMutationsQris,
  showMutationsUtama,
  showMutationsMadera,
  getMutationsJson,
  streamMutationsSse,
  getQrisAccountsJson,
  handleRefreshAccountBalanceApi,
  showGenerateQr,
  handleDashboardGenerateQr,
  getQrisTemplate,
  getTransactionsSnapshotApi,
  showSettlement,
  handleCreateSettlement,
  handleSettlementBankInquiryApi,
  handleAccountTransferApi,
  handleRetryAutoPinApi,
  handleBankListApi,
  showLoginLogs,
  showAliases,
  showAccountSettings,
} from './dashboard.controller';
import { getPostgresMonitorJson, showPostgresMonitor } from './postgres-monitor.controller';
import { showSaldoUtama, showMadera } from './wallet.controller';

const router = Router();

router.get('/', showDashboard);

router.get('/history', showHistory);
router.get('/transactions', showTransactions);
router.get('/mutations', showMutations);
router.get('/mutations/qris', showMutationsQris);
router.get('/mutations/utama', showMutationsUtama);
router.get('/mutations/madera', showMutationsMadera);
router.get('/generate-qr', showGenerateQr);
router.post('/api/generate-qr', handleDashboardGenerateQr);
router.post('/api/transactions/snapshot', getTransactionsSnapshotApi);
router.get('/api/mutations', getMutationsJson);
router.get('/api/mutations/stream', streamMutationsSse);
router.get('/api/qris-accounts', getQrisAccountsJson);
router.post('/api/qris-accounts/:id/refresh-balance', handleRefreshAccountBalanceApi);
router.get('/api/qris-template', getQrisTemplate);

router.get('/wallet/saldo-utama', requirePermission('report:view'), showSaldoUtama);
router.get('/wallet/madera', requirePermission('report:view'), showMadera);

router.get('/settlement', showSettlement);
router.post('/settlement', requirePermission('setting:manage'), handleCreateSettlement);
router.post('/settlement/inquiry', requirePermission('setting:manage'), handleSettlementBankInquiryApi);
router.post('/settlement/transfer', requirePermission('setting:manage'), handleAccountTransferApi);
router.post('/settlement/retry-pin', requirePermission('setting:manage'), handleRetryAutoPinApi);
router.get('/settlement/banks', requirePermission('setting:manage'), handleBankListApi);

router.get('/postgres-monitor', requirePermission('setting:manage'), showPostgresMonitor);
router.get('/api/postgres-monitor', requirePermission('setting:manage'), getPostgresMonitorJson);
router.get('/login-logs', requirePermission('log:view'), showLoginLogs);
router.get('/aliases', requirePermission('setting:manage'), showAliases);
router.get('/account-settings', requirePermission('setting:manage'), showAccountSettings);

export { router as dashboardRouter };
