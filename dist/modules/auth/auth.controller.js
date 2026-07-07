"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showLogin = showLogin;
exports.handleLogin = handleLogin;
exports.handleLogout = handleLogout;
exports.showChangePassword = showChangePassword;
exports.handleChangePassword = handleChangePassword;
const zod_1 = require("zod");
const auth_service_1 = require("./auth.service");
const config_1 = require("../../config");
const logger_1 = require("../../config/logger");
const base_path_1 = require("../../core/base-path");
const LoginSchema = zod_1.z.object({
    username: zod_1.z.string().min(1, 'Username wajib diisi'),
    password: zod_1.z.string().min(1, 'Password wajib diisi'),
});
const ChangePasswordSchema = zod_1.z
    .object({
    currentPassword: zod_1.z.string().min(1),
    newPassword: zod_1.z.string().min(8, 'Password minimal 8 karakter'),
    confirmPassword: zod_1.z.string().min(1),
})
    .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Konfirmasi password tidak cocok',
    path: ['confirmPassword'],
});
async function showLogin(req, res) {
    if (req.session.user) {
        res.redirect((0, base_path_1.withBasePath)('/dashboard', config_1.config.APP_BASE_PATH));
        return;
    }
    res.render('auth/login', {
        layout: 'layouts/auth',
        title: 'Login',
        error: null,
    });
}
async function handleLogin(req, res) {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
        res.render('auth/login', {
            layout: 'layouts/auth',
            title: 'Login',
            error: 'Username dan password wajib diisi.',
        });
        return;
    }
    const { username, password } = parsed.data;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    try {
        const user = await (0, auth_service_1.verifyCredentials)(username, password, ipAddress, userAgent);
        if (!user) {
            res.render('auth/login', {
                layout: 'layouts/auth',
                title: 'Login',
                error: 'Username atau password salah.',
            });
            return;
        }
        // Regenerate session ID to prevent session fixation
        req.session.regenerate((err) => {
            if (err) {
                logger_1.logger.error({ err }, 'Session regeneration failed');
                res.render('auth/login', {
                    layout: 'layouts/auth',
                    title: 'Login',
                    error: 'Terjadi kesalahan. Silakan coba lagi.',
                });
                return;
            }
            req.session.user = user;
            req.session.save((saveErr) => {
                if (saveErr) {
                    logger_1.logger.error({ saveErr }, 'Session save failed');
                }
                res.redirect((0, base_path_1.withBasePath)('/dashboard', config_1.config.APP_BASE_PATH));
            });
        });
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Login handler error');
        res.render('auth/login', {
            layout: 'layouts/auth',
            title: 'Login',
            error: 'Terjadi kesalahan sistem.',
        });
    }
}
function getClientIp(req) {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
        return forwardedFor.split(',')[0].trim();
    }
    if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
        return forwardedFor[0].split(',')[0].trim();
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
}
async function handleLogout(req, res) {
    req.session.destroy((err) => {
        if (err) {
            logger_1.logger.error({ err }, 'Session destroy failed');
        }
        res.redirect((0, base_path_1.withBasePath)('/login', config_1.config.APP_BASE_PATH));
    });
}
async function showChangePassword(req, res) {
    res.render('settings/change-password', {
        layout: 'layouts/main',
        title: 'Ganti Password',
        error: null,
        mustChange: req.session.user?.mustChangePassword ?? false,
    });
}
async function handleChangePassword(req, res) {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        const firstError = parsed.error.errors[0]?.message ?? 'Input tidak valid';
        res.render('settings/change-password', {
            layout: 'layouts/main',
            title: 'Ganti Password',
            error: firstError,
            mustChange: req.session.user?.mustChangePassword ?? false,
        });
        return;
    }
    try {
        await (0, auth_service_1.changePassword)(req.session.user.id, parsed.data.currentPassword, parsed.data.newPassword);
        // Update session to reflect password change
        if (req.session.user) {
            req.session.user.mustChangePassword = false;
        }
        req.session.flash = { type: 'success', message: 'Password berhasil diubah.' };
        res.redirect((0, base_path_1.withBasePath)('/dashboard', config_1.config.APP_BASE_PATH));
    }
    catch (err) {
        logger_1.logger.error({ err }, 'Change password error');
        const message = err instanceof Error && err.message
            ? err.message
            : 'Gagal mengubah password. Silakan coba lagi.';
        res.render('settings/change-password', {
            layout: 'layouts/main',
            title: 'Ganti Password',
            error: message,
            mustChange: req.session.user?.mustChangePassword ?? false,
        });
    }
}
//# sourceMappingURL=auth.controller.js.map