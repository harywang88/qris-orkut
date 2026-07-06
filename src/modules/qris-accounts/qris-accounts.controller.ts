import { Request, Response } from 'express';
import { z } from 'zod';
import {
  listQrisAccounts,
  getQrisAccountById,
  createQrisAccount,
  updateQrisAccount,
  deleteQrisAccount,
  toggleAccountStatus,
  setHealthStatus,
  resetDailyUsage,
} from './qris-accounts.service';
import { config } from '../../config';
import { logger } from '../../config/logger';
import { withBasePath } from '../../core/base-path';

function optionalInt(min: number, max: number) {
  return z.preprocess((value) => {
    if (value === '' || value === null || value === undefined) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    const parsed = typeof value === 'string' ? Number(value) : Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().int().min(min).max(max).optional());
}

function optionalText(max: number) {
  return z.preprocess((value) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, z.string().max(max).optional());
}

const QrisAccountCreateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9]+$/i, 'Kode hanya boleh huruf dan angka'),
  accountNumber: z.string().trim().min(1).max(50),
  merchantName: z.string().trim().min(1).max(100),
  orkutAccountIndex: optionalInt(1, 999),
  dailyLimit: z.coerce.number().int().min(0).default(30_000_000),
  qrisPayload: optionalText(2000),
  sessionToken: optionalText(1000),
  cookies: optionalText(5000),
  deviceId: optionalText(100),
});

const QrisAccountUpdateSchema = z.object({
  code: optionalText(10).refine((value) => value === undefined || /^[A-Z0-9]+$/i.test(value), {
    message: 'Kode hanya boleh huruf dan angka',
  }),
  accountNumber: optionalText(50),
  merchantName: optionalText(100),
  orkutAccountIndex: optionalInt(1, 999),
  dailyLimit: z.preprocess((value) => {
    if (value === '' || value === null || value === undefined) return undefined;
    return value;
  }, z.coerce.number().int().min(0).optional()),
  qrisPayload: optionalText(2000),
  sessionToken: optionalText(1000),
  cookies: optionalText(5000),
  deviceId: optionalText(100),
});

export async function showAccountList(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await listQrisAccounts();
    res.render('qris-accounts/index', {
      title: 'Akun QRIS',
      accounts,
    });
  } catch (err) {
    logger.error({ err }, 'showAccountList error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showNewAccountForm(req: Request, res: Response): Promise<void> {
  res.render('qris-accounts/form', {
    title: 'Tambah Akun QRIS',
    account: null,
    errors: null,
  });
}

export async function handleCreateAccount(req: Request, res: Response): Promise<void> {
  const parsed = QrisAccountCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.render('qris-accounts/form', {
      title: 'Tambah Akun QRIS',
      account: null,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    await createQrisAccount(parsed.data);
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil ditambahkan.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal menambahkan akun QRIS';
    res.render('qris-accounts/form', {
      title: 'Tambah Akun QRIS',
      account: null,
      errors: { _form: [message] },
    });
  }
}

export async function showEditAccountForm(req: Request, res: Response): Promise<void> {
  try {
    const account = await getQrisAccountById(req.params.id);
    if (!account) {
      res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
      return;
    }
    res.render('qris-accounts/form', {
      title: `Edit Akun: ${account.code}`,
      account,
      errors: null,
    });
  } catch (err) {
    logger.error({ err }, 'showEditAccountForm error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function handleUpdateAccount(req: Request, res: Response): Promise<void> {
  const parsed = QrisAccountUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const account = await getQrisAccountById(req.params.id);
    res.render('qris-accounts/form', {
      title: 'Edit Akun QRIS',
      account,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    await updateQrisAccount(req.params.id, parsed.data);
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil diperbarui.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal memperbarui akun QRIS';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}

export async function handleDeleteAccount(req: Request, res: Response): Promise<void> {
  try {
    await deleteQrisAccount(req.params.id);
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil dihapus.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus akun';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}

export async function handleToggleStatus(req: Request, res: Response): Promise<void> {
  try {
    const newStatus = await toggleAccountStatus(req.params.id);
    res.json({ success: true, status: newStatus });
  } catch (err) {
    logger.error({ err }, 'handleToggleStatus error');
    res.status(500).json({ success: false, error: 'Gagal mengubah status' });
  }
}

export async function handleSetHealth(req: Request, res: Response): Promise<void> {
  const { healthStatus } = req.body;
  if (!['healthy', 'degraded', 'down'].includes(healthStatus)) {
    res.status(400).json({ success: false, error: 'Status tidak valid' });
    return;
  }
  try {
    await setHealthStatus(req.params.id, healthStatus as 'healthy' | 'degraded' | 'down');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'handleSetHealth error');
    res.status(500).json({ success: false, error: 'Gagal mengubah status kesehatan' });
  }
}

export async function handleResetDailyUsage(req: Request, res: Response): Promise<void> {
  try {
    await resetDailyUsage(req.params.id);
    req.session.flash = { type: 'success', message: 'Penggunaan harian berhasil direset.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'handleResetDailyUsage error');
    req.session.flash = { type: 'error', message: 'Gagal mereset penggunaan harian.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}
