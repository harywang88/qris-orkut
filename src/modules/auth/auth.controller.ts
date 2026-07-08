import { Request, Response } from 'express';
import { z } from 'zod';
import { verifyCredentials, changePassword } from './auth.service';
import { config } from '../../config';
import { logger } from '../../config/logger';
import { withBasePath } from '../../core/base-path';
import { logAction } from '../../shared/audit-log.service';

const LoginSchema = z.object({
  username: z.string().min(1, 'Username wajib diisi'),
  password: z.string().min(1, 'Password wajib diisi'),
});

const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, 'Password minimal 8 karakter'),
    confirmPassword: z.string().min(1),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Konfirmasi password tidak cocok',
    path: ['confirmPassword'],
  });

export async function showLogin(req: Request, res: Response): Promise<void> {
  if (req.session.user) {
    res.redirect(withBasePath('/dashboard', config.APP_BASE_PATH));
    return;
  }
  res.render('auth/login', {
    layout: 'layouts/auth',
    title: 'Login',
    error: null,
  });
}

export async function handleLogin(req: Request, res: Response): Promise<void> {
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
    const user = await verifyCredentials(username, password, ipAddress, userAgent);

    if (!user) {
      void logAction(req, { category: 'auth', action: 'login_failed', status: 'failed', severity: 'important', summary: 'Login GAGAL untuk username "' + username + '"', targetType: 'User', targetName: username });
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
        logger.error({ err }, 'Session regeneration failed');
        res.render('auth/login', {
          layout: 'layouts/auth',
          title: 'Login',
          error: 'Terjadi kesalahan. Silakan coba lagi.',
        });
        return;
      }

      req.session.user = user;
      void logAction(req, { category: 'auth', action: 'login', summary: 'Login berhasil: ' + user.username, targetType: 'User', targetId: user.id, targetName: user.username });
      req.session.save((saveErr) => {
        if (saveErr) {
          logger.error({ saveErr }, 'Session save failed');
        }
        res.redirect(withBasePath('/dashboard', config.APP_BASE_PATH));
      });
    });
  } catch (err) {
    logger.error({ err }, 'Login handler error');
    res.render('auth/login', {
      layout: 'layouts/auth',
      title: 'Login',
      error: 'Terjadi kesalahan sistem.',
    });
  }
}

function getClientIp(req: Request): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].split(',')[0].trim();
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}

export async function handleLogout(req: Request, res: Response): Promise<void> {
  void logAction(req, { category: 'auth', action: 'logout', summary: 'Logout' + (req.session.user?.username ? ': ' + req.session.user.username : ''), targetType: 'User', targetId: req.session.user?.id, targetName: req.session.user?.username });
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, 'Session destroy failed');
    }
    res.redirect(withBasePath('/login', config.APP_BASE_PATH));
  });
}

export async function showChangePassword(req: Request, res: Response): Promise<void> {
  res.render('settings/change-password', {
    layout: 'layouts/main',
    title: 'Ganti Password',
    error: null,
    mustChange: req.session.user?.mustChangePassword ?? false,
  });
}

export async function handleChangePassword(req: Request, res: Response): Promise<void> {
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
    await changePassword(req.session.user!.id, parsed.data.currentPassword, parsed.data.newPassword);
    void logAction(req, { category: 'auth', action: 'change_password', severity: 'important', summary: 'Mengubah password sendiri', targetType: 'User', targetId: req.session.user?.id, targetName: req.session.user?.username });

    // Update session to reflect password change
    if (req.session.user) {
      req.session.user.mustChangePassword = false;
    }

    req.session.flash = { type: 'success', message: 'Password berhasil diubah.' };
    res.redirect(withBasePath('/dashboard', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'Change password error');
    const message =
      err instanceof Error && err.message
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
