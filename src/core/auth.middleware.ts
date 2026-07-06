import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { withBasePath } from './base-path';

/**
 * Protects a route by requiring an active admin session.
 * Redirects unauthenticated requests to /login.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    // Force password change before accessing any protected page
    if (
      req.session.user.mustChangePassword &&
      req.path !== '/settings/change-password' &&
      req.path !== '/logout'
    ) {
      res.redirect(withBasePath('/settings/change-password', config.APP_BASE_PATH));
      return;
    }
    next();
    return;
  }

  // Preserve intended destination for post-login redirect
  req.session.flash = {
    type: 'info',
    message: 'Silakan login terlebih dahulu.',
  };
  res.redirect(withBasePath('/login', config.APP_BASE_PATH));
}

/**
 * Convenience: require auth but skip the mustChangePassword redirect.
 * Used for the change-password page itself.
 */
export function requireAuthOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.session.user) {
    next();
    return;
  }
  res.redirect(withBasePath('/login', config.APP_BASE_PATH));
}
