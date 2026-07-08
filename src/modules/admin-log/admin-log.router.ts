import { Router } from 'express';
import { requireMenu } from '../../core/rbac.middleware';
import {
  showAdminLog,
  getAdminLogEntriesApi,
  getAdminLogStatsApi,
  exportAdminLogCsv,
} from './admin-log.controller';

const router = Router();
const gate = requireMenu('admin-log');

router.get('/', gate, showAdminLog);
router.get('/api/entries', gate, getAdminLogEntriesApi);
router.get('/api/stats', gate, getAdminLogStatsApi);
router.get('/export.csv', gate, exportAdminLogCsv);

export { router as adminLogRouter };
