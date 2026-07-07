import { Request, Response, NextFunction } from 'express';
/**
 * Protects a route by requiring an active admin session.
 * Redirects unauthenticated requests to /login.
 */
export declare function requireAuth(req: Request, res: Response, next: NextFunction): void;
/**
 * Convenience: require auth but skip the mustChangePassword redirect.
 * Used for the change-password page itself.
 */
export declare function requireAuthOnly(req: Request, res: Response, next: NextFunction): void;
