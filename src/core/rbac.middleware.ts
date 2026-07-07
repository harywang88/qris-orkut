import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { withBasePath } from './base-path';
import {
  isMasterUser,
  getMenuPermsForUser,
  canViewMenu,
  canDo,
} from '../shared/alias-access.service';
import type { AccessUser } from '../shared/alias-access.service';

/** 403 yang sadar konteks: JSON untuk /api, halaman error untuk view. */
function denyAccess(req: Request, res: Response, message: string): void {
  const isApi = req.originalUrl.split('?')[0].includes('/api/');
  if (isApi) {
    res.status(403).json({ ok: false, success: false, error: message });
    return;
  }
  res.status(403).render('error/403', { title: 'Akses Ditolak', message, layout: 'layouts/main' });
}

/**
 * Gating per-menu (Akun Alias). Master lolos. Alias/user dicek menuPerms.
 *   requireMenu('settlement')            -> butuh izin buka menu (settlement.view)
 *   requireMenu('settlement','transfer') -> butuh sub-aksi (settlement.transfer)
 */
export function requireMenu(menuKey: string, subKey?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user as AccessUser | undefined;
    if (!user) {
      res.redirect(withBasePath('/login', config.APP_BASE_PATH));
      return;
    }
    try {
      if (isMasterUser(user)) return next();
      const perms = getMenuPermsForUser(user);
      const ok = subKey ? canDo(perms, menuKey, subKey) : canViewMenu(perms, menuKey);
      if (!ok) {
        denyAccess(req, res, 'Anda tidak memiliki akses ke menu/fitur ini.');
        return;
      }
    } catch {
      // Bila layer alias error, jangan kunci total: fail-open supaya tak memblok kerja.
      return next();
    }
    next();
  };
}

/**
 * Gabungan Akun Alias + izin lama. Izinkan bila: master, ATAU alias dgn canDo(menuKey,subKey),
 * ATAU user Prisma non-master dgn legacyPermission (perilaku lama, tanpa regresi). Dipakai route
 * yang dulu hanya requirePermission (mis. /clients, /merchant-qr) supaya alias yang menunya sudah
 * dicentang tidak lagi 403.
 */
export function requireMenuOrPermission(menuKey: string, subKey: string, legacyPermission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.session.user as AccessUser | undefined;
    if (!user) {
      res.redirect(withBasePath('/login', config.APP_BASE_PATH));
      return;
    }
    try {
      if (isMasterUser(user)) return next();
      if (user.isAlias) {
        const perms = getMenuPermsForUser(user);
        if (canDo(perms, menuKey, subKey)) return next();
        denyAccess(req, res, 'Anda tidak memiliki akses ke menu/fitur ini.');
        return;
      }
      if (Array.isArray(user.permissions) && user.permissions.includes(legacyPermission)) {
        return next();
      }
      denyAccess(req, res, `Anda tidak memiliki izin untuk fitur ini (${legacyPermission}).`);
      return;
    } catch {
      return next();
    }
  };
}

/** Hanya master (harywang / setting:manage). */
export function requireMaster(req: Request, res: Response, next: NextFunction): void {
  const user = req.session.user as AccessUser | undefined;
  if (!user) {
    res.redirect(withBasePath('/login', config.APP_BASE_PATH));
    return;
  }
  if (!isMasterUser(user)) {
    denyAccess(req, res, 'Menu ini khusus akun master.');
    return;
  }
  next();
}

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
