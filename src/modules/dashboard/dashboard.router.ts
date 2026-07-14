import express, { Router, Request, Response } from 'express';
import { requireMenu, requirePermission, requireMaster } from '../../core/rbac.middleware';
import { showCariSelisih } from './cari-selisih.controller';
import {
  showDashboard,
  showTransactions,
  showMutations,
  showMutationsQris,
  showMutationsUtama,
  showMutationsMadera,
  showMaderaNobuHistory,
  getMaderaNobuHistoryApi,
  getMaderaNobuWebviewApi,
  showHistoryOrkut,
  getHistoryOrkutMutationsApi,
  getHistoryOrkutOpenApi,
  getMaderaManualBanksApi,
  showManualSendPage,
  postMaderaManualInquiryApi,
  postMaderaManualInitiateApi,
  handleCaptureSettlementProofApi,
  getSettlementProofApi,
  getSettlementProofsListApi,
  getBridgeStatusApi,
  showGenerateQr,
  handleDashboardGenerateQr,
  getGenerateQrStatusApi,
  getTransactionsSnapshotApi,
  getLatestTransactionsApi,
  postDashRetryDeposit,
  postDashManualCredit,
  getMutationsJson,
  streamMutationsSse,
  getQrisReconcileApi,
  getReconcileDetailApi,
  postReconcileBackfillApi,
  getQrisAccountsJson,
  handleRefreshAccountBalanceApi,
  handleAccountBalancesApi,
  handleRecentPaidApi,
  getQrisTemplate,
  showSettlement,
  showDaftarBank,
  getDaftarBankApi,
  createDaftarBankApi,
  updateDaftarBankApi,
  deleteDaftarBankApi,
  getSettlementSavedBanksApi,
  getNagoxStatusApi,
  nagoxApproveApi,
  nagoxRejectApi,
  handleCreateSettlement,
  handleSettlementBankInquiryApi,
  handleAccountTransferApi,
  handleRetryAutoPinApi,
  handleBankListApi,
  showLoginLogs,
  showAliases,
  showAccountSettings,
  checkWebGamePanelApi,
  getWebgameSitesApi,
  saveWebgameSitesApi,
  showAkunAlias,
  getAliasAccountsApi,
  createAliasApi,
  updateAliasApi,
  deleteAliasApi,
} from './dashboard.controller';
import { showPostgresMonitor, getPostgresMonitorJson } from './postgres-monitor.controller';
import { showSaldoUtama, showMadera } from './wallet.controller';
import { showPendingMoney, handleTagPendingMoney, handleUntagPendingMoney, handleBookPendingMoney, handleNagoxPanelsApi, handleNagoxBanksApi, handleGetNagoxConfigApi, handleSetNagoxConfigApi, handleCatatNagoxApi } from './pending-money.controller';
import { showOrderkuotaReport, apiLookupQr, handleCreateReport, handleCancelReport, serveProof, apiReportStatus } from './orderkuota-report.controller';
import { showReconcile } from './reconcile.controller';

const router = Router();

router.get('/', requireMenu('dashboard'), showDashboard);
// History Generate QR: mesin Transaction, SEMUA status.
router.get('/history', requireMenu('history-generate-qr'), (req: Request, res: Response) =>
  showTransactions(req, res, { title: 'History Generate QR' }),
);
// Transaction: mesin sama, DIKUNCI paid (server).
router.get('/transactions', requireMenu('transactions'), (req: Request, res: Response) =>
  showTransactions(req, res, { paidOnly: true, title: 'Transaction' }),
);
router.get('/mutations', showMutations);
router.get('/mutations/qris', requireMenu('mutasi-qris'), showMutationsQris);
router.get('/mutations/utama', requireMenu('mutasi-utama'), showMutationsUtama);
router.get('/mutations/madera', requireMenu('mutasi-madera'), showMutationsMadera);
router.get('/pending-money', requireMenu('mutasi-qris'), showPendingMoney);
router.post('/api/pending-money/:mutationId/tag', requireMenu('mutasi-qris'), handleTagPendingMoney);
router.post('/api/pending-money/:mutationId/untag', requireMenu('mutasi-qris'), handleUntagPendingMoney);
router.post('/api/pending-money/:mutationId/book', requireMenu('mutasi-qris'), handleBookPendingMoney);
// Nagox Pending: konfig bank per-site (dari daftar Nagox live) + Catat ke DB Nagox
router.get('/api/pending-money/nagox-panels', requireMenu('mutasi-qris'), handleNagoxPanelsApi);
router.get('/api/pending-money/nagox-banks', requireMenu('mutasi-qris'), handleNagoxBanksApi);
router.get('/api/pending-money/nagox-config', requireMenu('mutasi-qris'), handleGetNagoxConfigApi);
router.post('/api/pending-money/nagox-config', requireMenu('mutasi-qris'), handleSetNagoxConfigApi);
router.post('/api/pending-money/:mutationId/catat-nagox', requireMenu('mutasi-qris'), handleCatatNagoxApi);
// ── Laporkan ke OrderKuota (CS lapor QR uang nyangkut; bot ambil-alih dari Uang Pending) ──
router.get('/orderkuota-report', requireMenu('laporkan-orderkuota'), showOrderkuotaReport);
router.get('/api/orderkuota-report/lookup', requireMenu('laporkan-orderkuota'), apiLookupQr);
router.get('/api/orderkuota-report/status', requireMenu('laporkan-orderkuota'), apiReportStatus);
// Bukti = raw binary (octet-stream) → global json/urlencoded skip, express.raw khusus route ini (tak ubah limit global).
router.post('/api/orderkuota-report', requireMenu('laporkan-orderkuota', 'create'), express.raw({ type: '*/*', limit: '8mb' }), handleCreateReport);
router.post('/api/orderkuota-report/:id/cancel', requireMenu('laporkan-orderkuota', 'cancel'), handleCancelReport);
router.get('/orderkuota-report/proof/:id', requireMenu('laporkan-orderkuota'), serveProof);
router.get('/reconcile', requireMenu('mutasi-utama'), showReconcile);
router.get('/madera-nobu', showMaderaNobuHistory);
router.get('/manual-send/:accountId', requireMenu('settlement', 'transfer'), showManualSendPage);
router.get('/api/madera-nobu/:accountId', getMaderaNobuHistoryApi);
router.get('/api/madera-nobu/:accountId/webview', getMaderaNobuWebviewApi);
router.get('/history-orkut/:wallet', showHistoryOrkut);
router.get('/api/history-orkut/:accountId/mutations', getHistoryOrkutMutationsApi);
router.get('/api/history-orkut/:accountId/open', getHistoryOrkutOpenApi);
router.get('/api/madera-nobu/:accountId/manual-banks', getMaderaManualBanksApi);
router.post('/api/madera-nobu/:accountId/manual-inquiry', requireMenu('settlement', 'transfer'), postMaderaManualInquiryApi);
router.post('/api/madera-nobu/:accountId/manual-initiate', requireMenu('settlement', 'transfer'), postMaderaManualInitiateApi);
router.post('/api/settlement/:id/capture-proof', requirePermission('setting:manage'), handleCaptureSettlementProofApi);
router.get('/api/settlement/:id/proof', getSettlementProofApi);
router.get('/api/settlement-proofs', getSettlementProofsListApi);
router.get('/api/bridge-status', getBridgeStatusApi);
router.get('/generate-qr', requireMenu('generate-qr'), showGenerateQr);
router.post('/api/generate-qr', requireMenu('generate-qr', 'create'), handleDashboardGenerateQr);
router.get('/api/generate-qr/status', requireMenu('generate-qr'), getGenerateQrStatusApi);
router.post('/api/transactions/snapshot', getTransactionsSnapshotApi);
router.get('/api/transactions/latest', getLatestTransactionsApi);
// Aksi operator per-transaksi (History Generate QR): force retry & kredit manual.
router.post('/api/transactions/:qrId/retry', requireMenu('history-generate-qr'), postDashRetryDeposit);
router.post('/api/transactions/:qrId/manual-credit', requireMenu('history-generate-qr'), postDashManualCredit);
router.get('/api/mutations', getMutationsJson);
router.get('/api/mutations/stream', streamMutationsSse);
router.get('/api/mutations/reconcile', getQrisReconcileApi);
router.get('/api/mutations/reconcile-detail', getReconcileDetailApi);
router.post('/api/mutations/reconcile-backfill', postReconcileBackfillApi);
router.get('/api/qris-accounts', getQrisAccountsJson);
router.post('/api/qris-accounts/:id/refresh-balance', handleRefreshAccountBalanceApi);
router.get('/api/account-balances', handleAccountBalancesApi);
router.get('/api/recent-paid', handleRecentPaidApi);
router.get('/api/qris-template', getQrisTemplate);
router.get('/wallet/saldo-utama', requireMenu('reports'), showSaldoUtama);
router.get('/wallet/madera', requireMenu('reports'), showMadera);
router.get('/cari-selisih', requireMenu('cari-selisih'), showCariSelisih);
router.get('/settlement', requireMenu('settlement'), showSettlement);
router.post('/settlement', requireMenu('settlement', 'transfer'), handleCreateSettlement);
router.post('/settlement/inquiry', requireMenu('settlement', 'transfer'), handleSettlementBankInquiryApi);
router.post('/settlement/transfer', requireMenu('settlement', 'transfer'), handleAccountTransferApi);
router.get('/api/settlement/saved-banks', requireMenu('settlement', 'transfer'), getSettlementSavedBanksApi);
router.get('/api/nagox/status', requireMenu('settlement'), getNagoxStatusApi);
router.post('/api/settlement/nagox-approve', requireMenu('settlement', 'transfer'), nagoxApproveApi);
router.post('/api/settlement/nagox-reject', requireMenu('settlement', 'transfer'), nagoxRejectApi);
router.get('/daftar-bank', requireMenu('daftar-bank'), showDaftarBank);
router.get('/api/daftar-bank', requireMenu('daftar-bank'), getDaftarBankApi);
router.post('/api/daftar-bank', requireMenu('daftar-bank', 'manage'), createDaftarBankApi);
router.put('/api/daftar-bank/:id', requireMenu('daftar-bank', 'manage'), updateDaftarBankApi);
router.delete('/api/daftar-bank/:id', requireMenu('daftar-bank', 'manage'), deleteDaftarBankApi);
router.get('/api/daftar-bank/bank-list', requireMenu('daftar-bank', 'manage'), handleBankListApi); // daftar bank tujuan utk Daftar Bank (tanpa perlu izin settlement.transfer)
router.post('/api/daftar-bank/inquiry', requireMenu('daftar-bank', 'manage'), handleSettlementBankInquiryApi); // cek nama rekening utk Daftar Bank (tanpa perlu izin settlement.transfer)
router.post('/settlement/retry-pin', requireMenu('settlement', 'transfer'), handleRetryAutoPinApi);
router.get('/settlement/banks', requireMenu('settlement', 'transfer'), handleBankListApi);
router.get('/postgres-monitor', requireMenu('postgres'), showPostgresMonitor);
router.get('/api/postgres-monitor', requireMenu('postgres'), getPostgresMonitorJson);
router.get('/login-logs', requireMenu('login-logs'), showLoginLogs);
router.get('/aliases', requirePermission('setting:manage'), showAliases);
router.get('/account-settings', requireMenu('settings'), showAccountSettings);
router.post('/api/webgame/check', requireMenu('settings'), checkWebGamePanelApi);
router.get('/api/webgame/sites', requireMenu('settings'), getWebgameSitesApi);
router.post('/api/webgame/sites', requireMenu('settings', 'manage'), saveWebgameSitesApi);
// ── Akun Alias (master-only) ──────────────────────────────────────────────────
router.get('/akun-alias', requireMaster, showAkunAlias);
router.get('/api/akun-alias', requireMaster, getAliasAccountsApi);
router.post('/api/akun-alias', requireMaster, createAliasApi);
router.put('/api/akun-alias/:username', requireMaster, updateAliasApi);
router.delete('/api/akun-alias/:username', requireMaster, deleteAliasApi);

export { router as dashboardRouter };
