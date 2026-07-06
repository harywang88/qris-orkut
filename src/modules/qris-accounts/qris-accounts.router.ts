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
} from './qris-accounts.controller';

const router = Router();

const canManage = requirePermission('qris:manage');

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
