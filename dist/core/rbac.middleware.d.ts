import { Request, Response, NextFunction } from 'express';
/**
 * Creates a middleware that checks whether the logged-in user
 * has the specified permission. Returns 403 if not.
 *
 * Usage:
 *   router.get('/clients', requireAuth, requirePermission('client:manage'), handler)
 */
export declare function requirePermission(permission: string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Checks multiple permissions (all must be present).
 */
export declare function requirePermissions(...permissions: string[]): (req: Request, res: Response, next: NextFunction) => void;
