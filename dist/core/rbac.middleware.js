"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireMenu = requireMenu;
exports.requireMenuOrPermission = requireMenuOrPermission;
exports.requireMaster = requireMaster;
exports.requirePermission = requirePermission;
exports.requirePermissions = requirePermissions;
const config_1 = require("../config");
const base_path_1 = require("./base-path");
const alias_access_service_1 = require("../shared/alias-access.service");
/** 403 yang sadar konteks: JSON untuk /api, halaman error untuk view. */
function denyAccess(req, res, message) {
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
function requireMenu(menuKey, subKey) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user) {
            res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
            return;
        }
        try {
            if ((0, alias_access_service_1.isMasterUser)(user))
                return next();
            const perms = (0, alias_access_service_1.getMenuPermsForUser)(user);
            const ok = subKey ? (0, alias_access_service_1.canDo)(perms, menuKey, subKey) : (0, alias_access_service_1.canViewMenu)(perms, menuKey);
            if (!ok) {
                denyAccess(req, res, 'Anda tidak memiliki akses ke menu/fitur ini.');
                return;
            }
        }
        catch {
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
function requireMenuOrPermission(menuKey, subKey, legacyPermission) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user) {
            res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
            return;
        }
        try {
            if ((0, alias_access_service_1.isMasterUser)(user))
                return next();
            if (user.isAlias) {
                const perms = (0, alias_access_service_1.getMenuPermsForUser)(user);
                if ((0, alias_access_service_1.canDo)(perms, menuKey, subKey))
                    return next();
                denyAccess(req, res, 'Anda tidak memiliki akses ke menu/fitur ini.');
                return;
            }
            if (Array.isArray(user.permissions) && user.permissions.includes(legacyPermission)) {
                return next();
            }
            denyAccess(req, res, `Anda tidak memiliki izin untuk fitur ini (${legacyPermission}).`);
            return;
        }
        catch {
            return next();
        }
    };
}
/** Hanya master (harywang / setting:manage). */
function requireMaster(req, res, next) {
    const user = req.session.user;
    if (!user) {
        res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
        return;
    }
    if (!(0, alias_access_service_1.isMasterUser)(user)) {
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
function requirePermission(permission) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user) {
            res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
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
function requirePermissions(...permissions) {
    return (req, res, next) => {
        const user = req.session.user;
        if (!user) {
            res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
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
//# sourceMappingURL=rbac.middleware.js.map