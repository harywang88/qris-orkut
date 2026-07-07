"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireAuthOnly = requireAuthOnly;
const config_1 = require("../config");
const base_path_1 = require("./base-path");
/**
 * Protects a route by requiring an active admin session.
 * Redirects unauthenticated requests to /login.
 */
function requireAuth(req, res, next) {
    if (req.session.user) {
        // Force password change before accessing any protected page
        if (req.session.user.mustChangePassword &&
            req.path !== '/settings/change-password' &&
            req.path !== '/logout') {
            res.redirect((0, base_path_1.withBasePath)('/settings/change-password', config_1.config.APP_BASE_PATH));
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
    res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
}
/**
 * Convenience: require auth but skip the mustChangePassword redirect.
 * Used for the change-password page itself.
 */
function requireAuthOnly(req, res, next) {
    if (req.session.user) {
        next();
        return;
    }
    res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
}
//# sourceMappingURL=auth.middleware.js.map