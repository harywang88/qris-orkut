import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { withBasePath } from './base-path';

/**
 * Creates a middleware that checks whether the logged-in user
 * has the specified permission. Returns 403 if not.
 *
 * Usage:
 *   router.get('/clients', requireAuth, requirePermission('client:manage'), handler)
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user;

    if (!user) {
      res.redirect(withBasePath('/login', config.APP_BASE_PATH));
      return;
    }

    if (!user.permissions.includes(permission)) {
      res.status(403).render('error/403', {
        title: 'Akses Ditolak',
        message: `Anda tidak memiliki izin untuk fitur ini (${permission}).`,
        layout: 'layouts/main',
      });
      return;
    }

    next();
  };
}

/**
 * Checks multiple permissions (all must be present).
 */
export function requirePermissions(...permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user;

    if (!user) {
      res.redirect(withBasePath('/login', config.APP_BASE_PATH));
      return;
    }

    const missing = permissions.filter((p) => !user.permissions.includes(p));
    if (missing.length > 0) {
      res.status(403).render('error/403', {
        title: 'Akses Ditolak',
        message: `Anda tidak memiliki izin yang dibutuhkan: ${missing.join(', ')}.`,
        layout: 'layouts/main',
      });
      return;
    }

    next();
  };
}
