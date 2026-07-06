import { Router } from 'express';
import { requireAuthOnly } from '../../core/auth.middleware';
import {
  showLogin,
  handleLogin,
  handleLogout,
  showChangePassword,
  handleChangePassword,
} from './auth.controller';

const router = Router();

router.get('/login', showLogin);
router.post('/login', handleLogin);
router.post('/logout', handleLogout);

router.get('/settings/change-password', requireAuthOnly, showChangePassword);
router.post('/settings/change-password', requireAuthOnly, handleChangePassword);

export { router as authRouter };
