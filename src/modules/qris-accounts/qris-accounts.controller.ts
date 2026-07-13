import { Request, Response } from 'express';
import { z } from 'zod';
import {
  listQrisAccounts,
  createQrisAccount,
  getQrisAccountById,
  updateQrisAccount,
  deleteQrisAccount,
  toggleAccountStatus,
  AccountActivationError,
  setHealthStatus,
  resetDailyUsage,
} from './qris-accounts.service';
import { qrisReceivedTodayMap } from '../../shared/daily-usage.service';
import {
  listSites,
  attachSiteInfo,
  createSite,
  updateSite,
  deleteSite,
  setAccountSite,
} from '../../shared/site.service';
import { db } from '../../config/database';
import { logAction } from '../../shared/audit-log.service';
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
  code: z.string().min(1).max(10).regex(/^[A-Z0-9]+$/i, 'Kode hanya boleh huruf dan angka'),
  accountNumber: z.string().trim().min(1).max(50),
  merchantName: z.string().trim().min(1).max(100),
  orkutAccountIndex: optionalInt(1, 999),
  dailyLimit: z.coerce.number().int().min(0).default(30000000),
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

// "Kesehatan" LIVE (bukan snapshot Tes Koneksi yg basi). healthy = aktif + token ada + saldo-sync
// tak error & tak basi. degraded = jalan tapi error/parsial/macet >24 jam. down = tak ada token.
type HealthInput = {
  status: string;
  healthStatus?: string | null;
  sessionTokenEncrypted?: string | null;
  lastBalanceSyncError?: string | null;
  lastBalanceSyncStatus?: string | null;
  lastBalanceSyncAt?: Date | string | null;
};
function computeLiveHealth(a: HealthInput): string {
  if (a.status !== 'active') return a.healthStatus || 'down';
  if (!a.sessionTokenEncrypted) return 'down';
  const errored =
    !!a.lastBalanceSyncError ||
    a.lastBalanceSyncStatus === 'error' ||
    a.lastBalanceSyncStatus === 'failed';
  if (errored) return 'degraded';
  const ageMs = a.lastBalanceSyncAt ? Date.now() - new Date(a.lastBalanceSyncAt).getTime() : null;
  if (ageMs !== null && ageMs > 24 * 60 * 60 * 1000) return 'degraded'; // sync macet >24 jam
  return 'healthy';
}

export async function showAccountList(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await listQrisAccounts();
    const sites = listSites();
    // "Penggunaan Harian" = total PAID hari ini (WIB) per akun — SAMA seperti Kirim Uang.
    const WIB_MS = 7 * 60 * 60 * 1000;
    const todayWibStart = new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
    // Penggunaan Harian = SEMUA uang masuk QRIS hari ini (WIB) = paid + pending (mutasi kredit).
    const paidTodayMap = await qrisReceivedTodayMap();
    const accountsWithSite = attachSiteInfo(accounts).map((a) => ({
      ...a,
      usedToday: paidTodayMap[a.id] || 0,
      healthStatus: computeLiveHealth(a),
    }));
    res.render('qris-accounts/index', {
      title: 'Akun QRIS',
      accounts: accountsWithSite,
      sites,
    });
  } catch (err) {
    logger.error({ err }, 'showAccountList error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showNewAccountForm(req: Request, res: Response): Promise<void> {
  res.render('qris-accounts/form', { title: 'Tambah Akun QRIS', account: null, errors: null });
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
    void logAction(req, { category: 'account', action: 'account_create', severity: 'important', summary: 'Menambah akun QRIS ' + parsed.data.code, targetType: 'QrisAccount', targetName: parsed.data.code, detail: { merchantName: parsed.data.merchantName, accountNumber: parsed.data.accountNumber, dailyLimit: parsed.data.dailyLimit } });
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil ditambahkan.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err) {
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
    res.render('qris-accounts/form', { title: `Edit Akun: ${account.code}`, account, errors: null });
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
    const _acc = await getQrisAccountById(req.params.id);
    await updateQrisAccount(req.params.id, parsed.data);
    void logAction(req, { category: 'account', action: 'account_update', summary: 'Mengedit akun QRIS ' + (_acc?.code || req.params.id), targetType: 'QrisAccount', targetId: req.params.id, targetName: _acc?.code, detail: { code: parsed.data.code, merchantName: parsed.data.merchantName, accountNumber: parsed.data.accountNumber, dailyLimit: parsed.data.dailyLimit, orkutAccountIndex: parsed.data.orkutAccountIndex } });
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil diperbarui.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal memperbarui akun QRIS';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}

export async function handleDeleteAccount(req: Request, res: Response): Promise<void> {
  try {
    const _acc = await getQrisAccountById(req.params.id);
    await deleteQrisAccount(req.params.id);
    void logAction(req, { category: 'account', action: 'account_delete', severity: 'critical', summary: 'Menghapus akun QRIS ' + (_acc?.code || req.params.id), targetType: 'QrisAccount', targetId: req.params.id, targetName: _acc?.code });
    req.session.flash = { type: 'success', message: 'Akun QRIS berhasil dihapus.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus akun';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}

export async function handleToggleStatus(req: Request, res: Response): Promise<void> {
  try {
    const newStatus = await toggleAccountStatus(req.params.id);
    void logAction(req, { category: 'account', action: 'account_toggle', severity: 'important', summary: (newStatus === 'active' ? 'Mengaktifkan' : 'Menonaktifkan') + ' akun QRIS', targetType: 'QrisAccount', targetId: req.params.id, detail: { status: newStatus } });
    res.json({ success: true, status: newStatus });
  } catch (err) {
    if (err instanceof AccountActivationError) { res.status(400).json({ success: false, error: err.message }); return; }
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
    await setHealthStatus(req.params.id, healthStatus);
    void logAction(req, { category: 'account', action: 'account_set_health', summary: 'Set kesehatan akun QRIS: ' + healthStatus, targetType: 'QrisAccount', targetId: req.params.id, detail: { healthStatus } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'handleSetHealth error');
    res.status(500).json({ success: false, error: 'Gagal mengubah status kesehatan' });
  }
}

export async function handleResetDailyUsage(req: Request, res: Response): Promise<void> {
  try {
    await resetDailyUsage(req.params.id);
    void logAction(req, { category: 'account', action: 'account_reset_daily', summary: 'Reset penggunaan harian akun QRIS', targetType: 'QrisAccount', targetId: req.params.id });
    req.session.flash = { type: 'success', message: 'Penggunaan harian berhasil direset.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'handleResetDailyUsage error');
    req.session.flash = { type: 'error', message: 'Gagal mereset penggunaan harian.' };
    res.redirect(withBasePath('/qris-accounts', config.APP_BASE_PATH));
  }
}

// ── Kelola Site (JSON sidecar) + assign akun -> site ──────────────────────────
export function handleCreateSite(req: Request, res: Response): void {
  try {
    const site = createSite(req.body && req.body.name, req.body && req.body.color);
    void logAction(req, { category: 'site', action: 'site_create', summary: 'Menambah site "' + ((site && site.name) || '') + '"', targetType: 'Site', targetId: site && site.id, targetName: site && site.name, detail: { color: site && site.color } });
    res.json({ success: true, site });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menambah site' });
  }
}
export function handleUpdateSite(req: Request, res: Response): void {
  try {
    const site = updateSite(req.params.sid, req.body || {});
    void logAction(req, { category: 'site', action: 'site_update', summary: 'Mengubah site "' + ((site && site.name) || '') + '"', targetType: 'Site', targetId: req.params.sid, targetName: site && site.name, detail: { name: req.body && req.body.name, color: req.body && req.body.color } });
    res.json({ success: true, site });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal mengubah site' });
  }
}
export function handleDeleteSite(req: Request, res: Response): void {
  try {
    const _s = listSites().find((x) => x.id === req.params.sid);
    deleteSite(req.params.sid);
    void logAction(req, { category: 'site', action: 'site_delete', severity: 'important', summary: 'Menghapus site "' + ((_s && _s.name) || req.params.sid) + '"', targetType: 'Site', targetId: req.params.sid, targetName: _s && _s.name });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menghapus site' });
  }
}
export function handleAssignSite(req: Request, res: Response): void {
  try {
    const _sid = (req.body && req.body.siteId) || '';
    const _s = _sid ? listSites().find((x) => x.id === _sid) : null;
    setAccountSite(req.params.id, _sid);
    void logAction(req, { category: 'site', action: 'site_assign', summary: 'Menetapkan akun ke ' + (_sid ? ('site "' + ((_s && _s.name) || '') + '"') : '(Tanpa site)'), targetType: 'QrisAccount', targetId: req.params.id, detail: { siteId: _sid, siteName: (_s && _s.name) || null } });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menetapkan site' });
  }
}
