import { Router } from 'express';
import { requirePermission } from '../../core/rbac.middleware';
import {
  showAccountList,
  showNewAccountForm,
  handleCreateAccount,
  showEditAccountForm,
  handleUpdateAccount,
  handleDeleteAccount,
  handleToggleStatus,
  handleSetHealth,
  handleResetDailyUsage,
  handleCreateSite,
  handleUpdateSite,
  handleDeleteSite,
  handleAssignSite,
} from './qris-accounts.controller';

const router = Router();

const canManage = requirePermission('qris:manage');

// Kelola Site — DIDAFTARKAN DULU agar '/sites' & '/accounts/..' tak tertangkap '/:id'
router.post('/sites', canManage, handleCreateSite);
router.post('/sites/:sid/delete', canManage, handleDeleteSite);
router.post('/sites/:sid', canManage, handleUpdateSite);
router.post('/accounts/:id/site', canManage, handleAssignSite);

router.get('/', canManage, showAccountList);
router.get('/new', canManage, showNewAccountForm);
router.post('/', canManage, handleCreateAccount);
router.get('/:id/edit', canManage, showEditAccountForm);
router.post('/:id', canManage, handleUpdateAccount);
router.post('/:id/delete', canManage, handleDeleteAccount);
router.post('/:id/toggle-status', canManage, handleToggleStatus);
router.post('/:id/set-health', canManage, handleSetHealth);
router.post('/:id/reset-daily', canManage, handleResetDailyUsage);

export { router as qrisAccountsRouter };
