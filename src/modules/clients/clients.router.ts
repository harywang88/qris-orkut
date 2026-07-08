import { Router } from 'express';
import { requireMenuOrPermission } from '../../core/rbac.middleware';
import {
  showClientList,
  showNewClientForm,
  handleCreateClient,
  showClientDetail,
  showEditClientForm,
  handleUpdateClient,
  handleDeleteClient,
  handleRotateSecret,
  handleRotateWidgetKey,
  handleRevealSecret,
} from './clients.controller';

const router = Router();

const canManage = requireMenuOrPermission('clients', 'manage', 'client:manage');
const canView = requireMenuOrPermission('clients', 'view', 'client:manage');

router.get('/', canView, showClientList);
router.get('/new', canManage, showNewClientForm);
router.post('/', canManage, handleCreateClient);
router.get('/:id', canManage, showClientDetail);
router.get('/:id/edit', canManage, showEditClientForm);
router.post('/:id', canManage, handleUpdateClient);
router.post('/:id/delete', canManage, handleDeleteClient);
router.post('/:id/rotate-secret', canManage, handleRotateSecret);
router.post('/:id/rotate-widget-key', canManage, handleRotateWidgetKey);
router.get('/:id/reveal-secret', canManage, handleRevealSecret);

export { router as clientsRouter };
