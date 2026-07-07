import { Request, Response, NextFunction } from 'express';
/**
 * Gating per-menu (Akun Alias). Master lolos. Alias/user dicek menuPerms.
 *   requireMenu('settlement')            -> butuh izin buka menu (settlement.view)
 *   requireMenu('settlement','transfer') -> butuh sub-aksi (settlement.transfer)
 */
export declare function requireMenu(menuKey: string, subKey?: string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Gabungan Akun Alias + izin lama. Izinkan bila: master, ATAU alias dgn canDo(menuKey,subKey),
 * ATAU user Prisma non-master dgn legacyPermission (perilaku lama, tanpa regresi). Dipakai route
 * yang dulu hanya requirePermission (mis. /clients, /merchant-qr) supaya alias yang menunya sudah
 * dicentang tidak lagi 403.
 */
export declare function requireMenuOrPermission(menuKey: string, subKey: string, legacyPermission: string): (req: Request, res: Response, next: NextFunction) => void;
/** Hanya master (harywang / setting:manage). */
export declare function requireMaster(req: Request, res: Response, next: NextFunction): void;
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
