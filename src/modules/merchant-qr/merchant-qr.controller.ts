import { Request, Response } from 'express';
import { z } from 'zod';
import {
  listQrisAccounts,
  listQrisAccountsStatus,
  getQrisAccountById,
  getDecryptedCredentials,
  createQrisAccount,
  updateQrisAccount,
  deleteQrisAccount,
  toggleAccountStatus,
  setHealthStatus,
  resetDailyUsage,
} from '../qris-accounts/qris-accounts.service';
import {
  compareReportVsLiveSources,
  syncMerchantNow,
  testMerchantConnection,
  testReportLogin,
  saveWebReportLink,
  testWebReportLink,
  getWebReportStatus,
  startSyncAllMerchants,
  getSyncAllStatus,
  syncAppMutationsNow,
  syncReportMutationsNow,
  syncAppAllMerchants,
  syncReportAllMerchants,
  listAppCooldownStatus,
  AppCooldownError,
  AppThrottleError,
} from './merchant-qr-sync.service';
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

const MerchantQrCreateSchema = z.object({
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
  webCookies: optionalText(12000),
  webUserAgent: optionalText(500),
  deviceId: optionalText(100),
  transferPin: optionalText(20),
  balanceWatchActiveSeconds: optionalInt(1, 10).default(2),
  detailPollSeconds: optionalInt(15, 120).default(20),
});

const MerchantQrUpdateSchema = z.object({
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
  webCookies: optionalText(12000),
  webUserAgent: optionalText(500),
  deviceId: optionalText(100),
  transferPin: optionalText(20),
  balanceWatchActiveSeconds: optionalInt(1, 10),
  detailPollSeconds: optionalInt(15, 120),
});

type MerchantFormAccount = (NonNullable<Awaited<ReturnType<typeof getQrisAccountById>>> & {
  transferPin?: string | null;
}) | null;

async function getMerchantFormAccount(id: string): Promise<MerchantFormAccount> {
  const account = await getQrisAccountById(id);
  if (!account) return null;

  const credentials = await getDecryptedCredentials(id);
  return {
    ...account,
    transferPin: credentials.transferPin ?? '',
  };
}

function renderMerchantForm(
  res: Response,
  opts: {
    title: string;
    account: MerchantFormAccount;
    errors: Record<string, string[] | undefined> | null;
  },
): void {
  res.render('merchant-qr/form', opts);
}

export async function showMerchantQrList(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await listQrisAccounts();
    res.render('merchant-qr/index', {
      title: 'Merchant QR',
      accounts,
    });
  } catch (err) {
    logger.error({ err }, 'showMerchantQrList error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showNewMerchantQrForm(req: Request, res: Response): Promise<void> {
  renderMerchantForm(res, {
    title: 'Tambah Merchant QR',
    account: null,
    errors: null,
  });
}

export async function handleCreateMerchantQr(req: Request, res: Response): Promise<void> {
  const parsed = MerchantQrCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    renderMerchantForm(res, {
      title: 'Tambah Merchant QR',
      account: null,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    await createQrisAccount(parsed.data);
    req.session.flash = {
      type: 'success',
      message: 'Merchant QR berhasil ditambahkan dan otomatis siap dipakai di Generate QR serta semua menu mutasi.',
    };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal menambahkan Merchant QR';
    renderMerchantForm(res, {
      title: 'Tambah Merchant QR',
      account: null,
      errors: { _form: [message] },
    });
  }
}

export async function showEditMerchantQrForm(req: Request, res: Response): Promise<void> {
  try {
    const account = await getMerchantFormAccount(req.params.id);
    if (!account) {
      res.status(404).render('error/404', { title: 'Tidak Ditemukan' });
      return;
    }
    renderMerchantForm(res, {
      title: `Edit Merchant QR: ${account.code}`,
      account,
      errors: null,
    });
  } catch (err) {
    logger.error({ err }, 'showEditMerchantQrForm error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function handleUpdateMerchantQr(req: Request, res: Response): Promise<void> {
  const parsed = MerchantQrUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const account = await getMerchantFormAccount(req.params.id);
    renderMerchantForm(res, {
      title: 'Edit Merchant QR',
      account,
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    await updateQrisAccount(req.params.id, parsed.data);
    req.session.flash = {
      type: 'success',
      message: 'Merchant QR berhasil diperbarui.',
    };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal memperbarui Merchant QR';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  }
}

export async function handleDeleteMerchantQr(req: Request, res: Response): Promise<void> {
  try {
    await deleteQrisAccount(req.params.id);
    req.session.flash = { type: 'success', message: 'Merchant QR berhasil dihapus.' };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gagal menghapus Merchant QR';
    req.session.flash = { type: 'error', message };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  }
}

export async function handleToggleMerchantQrStatus(req: Request, res: Response): Promise<void> {
  try {
    const newStatus = await toggleAccountStatus(req.params.id);
    res.json({ success: true, status: newStatus });
  } catch (err) {
    logger.error({ err }, 'handleToggleMerchantQrStatus error');
    res.status(500).json({ success: false, error: 'Gagal mengubah status Merchant QR' });
  }
}

export async function handleSetMerchantQrHealth(req: Request, res: Response): Promise<void> {
  const { healthStatus } = req.body;
  if (!['healthy', 'degraded', 'down'].includes(healthStatus)) {
    res.status(400).json({ success: false, error: 'Status tidak valid' });
    return;
  }
  try {
    await setHealthStatus(req.params.id, healthStatus as 'healthy' | 'degraded' | 'down');
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'handleSetMerchantQrHealth error');
    res.status(500).json({ success: false, error: 'Gagal mengubah status kesehatan Merchant QR' });
  }
}

export async function handleResetMerchantQrDailyUsage(req: Request, res: Response): Promise<void> {
  try {
    await resetDailyUsage(req.params.id);
    req.session.flash = { type: 'success', message: 'Penggunaan harian Merchant QR berhasil direset.' };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'handleResetMerchantQrDailyUsage error');
    req.session.flash = { type: 'error', message: 'Gagal mereset penggunaan harian Merchant QR.' };
    res.redirect(withBasePath('/merchant-qr', config.APP_BASE_PATH));
  }
}

export async function handleTestMerchantQrConnection(req: Request, res: Response): Promise<void> {
  try {
    const report = await testMerchantConnection(req.params.id);
    res.json({ success: true, report });
  } catch (err) {
    logger.error({ err }, 'handleTestMerchantQrConnection error');
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Gagal mengetes koneksi merchant.',
    });
  }
}

export async function handleSyncMerchantQrNow(req: Request, res: Response): Promise<void> {
  try {
    const report = await syncMerchantNow(req.params.id);
    res.json({ success: true, report });
  } catch (err) {
    logger.error({ err }, 'handleSyncMerchantQrNow error');
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Gagal menjalankan sinkron manual.',
    });
  }
}

export async function handleTestMerchantQrReportLogin(req: Request, res: Response): Promise<void> {
  try {
    const report = await testReportLogin({
      rawHeaders: typeof req.body?.rawHeaders === 'string' ? req.body.rawHeaders : null,
      webCookies: typeof req.body?.webCookies === 'string' ? req.body.webCookies : null,
      webUserAgent: typeof req.body?.webUserAgent === 'string' ? req.body.webUserAgent : null,
    });
    res.status(report.success ? 200 : 400).json({ success: report.success, report });
  } catch (err) {
    logger.error({ err }, 'handleTestMerchantQrReportLogin error');
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Gagal mengetes login report.',
    });
  }
}

export async function handleCompareMerchantQrSources(req: Request, res: Response): Promise<void> {
  try {
    const report = await compareReportVsLiveSources({
      rawHeaders: typeof req.body?.rawHeaders === 'string' ? req.body.rawHeaders : null,
      webCookies: typeof req.body?.webCookies === 'string' ? req.body.webCookies : null,
      webUserAgent: typeof req.body?.webUserAgent === 'string' ? req.body.webUserAgent : null,
      sessionToken: typeof req.body?.sessionToken === 'string' ? req.body.sessionToken : null,
      cookies: typeof req.body?.cookies === 'string' ? req.body.cookies : null,
      deviceId: typeof req.body?.deviceId === 'string' ? req.body.deviceId : null,
    });
    res.status(report.success ? 200 : 400).json({ success: report.success, report });
  } catch (err) {
    logger.error({ err }, 'handleCompareMerchantQrSources error');
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'Gagal membandingkan source merchant.',
    });
  }
}

export async function getMerchantQrStatusApi(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await listQrisAccountsStatus();
    res.json({ ok: true, accounts });
  } catch (err) {
    logger.error({ err }, 'getMerchantQrStatusApi error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil status merchant.' });
  }
}

// ── Sinkron ALL (bulk) ────────────────────────────────────────────────────────
export async function handleSyncAllMerchants(req: Request, res: Response): Promise<void> {
  try {
    const gate = startSyncAllMerchants();
    if (gate.blocked) {
      res.status(429).json({
        success: false,
        blocked: gate.blocked,
        running: !!gate.running,
        nextAllowedAt: gate.nextAllowedAt,
        remainingMs: gate.remainingMs,
        error:
          gate.blocked === 'running'
            ? 'Sinkron ALL sedang berjalan.'
            : 'Sinkron ALL baru bisa lagi setelah cooldown 1 menit.',
      });
      return;
    }
    res.json({
      success: true,
      started: true,
      running: true,
      nextAllowedAt: gate.nextAllowedAt,
      remainingMs: gate.remainingMs,
    });
  } catch (err) {
    logger.error({ err }, 'handleSyncAllMerchants error');
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Gagal menjalankan Sinkron ALL.' });
  }
}

export async function getSyncAllStatusApi(req: Request, res: Response): Promise<void> {
  try {
    res.json(Object.assign({ ok: true }, getSyncAllStatus()));
  } catch (err) {
    logger.error({ err }, 'getSyncAllStatusApi error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil status Sinkron ALL.' });
  }
}

// ── Web Report link handlers (menu Merchant QR, kolom aksi) ──
export async function handleSaveWebReportUrl(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '');
    const url = String((req.body && req.body.url) ?? '');
    const result = await saveWebReportLink(id, url);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    logger.error({ err }, 'handleSaveWebReportUrl error');
    res.status(500).json({ ok: false, message: 'Gagal menyimpan link Web Report.' });
  }
}

export async function handleTestWebReportUrl(req: Request, res: Response): Promise<void> {
  try {
    const url = String((req.body && req.body.url) ?? '').trim();
    const report = await testWebReportLink(url);
    res.json(report);
  } catch (err) {
    logger.error({ err }, 'handleTestWebReportUrl error');
    res.status(500).json({ success: false, message: 'Gagal menguji link Web Report.' });
  }
}


export async function handleWebReportStatus(req: Request, res: Response): Promise<void> {
  try {
    const result = await getWebReportStatus(String(req.params.id || ''));
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'handleWebReportStatus error');
    res.status(500).json({ status: 'expired' });
  }
}


// ── Tombol Sinkron App/Report terpisah ──────────────────────────────────────
export async function handleSyncAppNow(req: Request, res: Response): Promise<void> {
  try {
    const r = await syncAppMutationsNow(req.params.id);
    res.json({ success: true, source: 'app', ...r });
  } catch (err) {
    if (err instanceof AppCooldownError) {
      res.status(429).json({
        success: false,
        cooldown: true,
        remainingMs: err.remainingMs,
        error: `App-api cooldown 469, sisa ${Math.ceil(err.remainingMs / 1000)} detik.`,
      });
      return;
    }
    if (err instanceof AppThrottleError) {
      res.status(429).json({
        success: false,
        throttle: true,
        remainingMs: err.remainingMs,
        error: `Tunggu ${Math.ceil(err.remainingMs / 1000)} detik sebelum App Sinkron lagi.`,
      });
      return;
    }
    logger.error({ err }, 'handleSyncAppNow error');
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Gagal App Sinkron.' });
  }
}

export async function handleSyncReportNow(req: Request, res: Response): Promise<void> {
  try {
    const r = await syncReportMutationsNow(req.params.id);
    res.json({ success: true, source: 'report', ...r });
  } catch (err) {
    logger.error({ err }, 'handleSyncReportNow error');
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Gagal Report Sinkron.' });
  }
}

export async function handleSyncAppAll(req: Request, res: Response): Promise<void> {
  try {
    const r = await syncAppAllMerchants();
    res.json({ success: true, source: 'app', ...r });
  } catch (err) {
    if (err instanceof AppThrottleError) {
      res.status(429).json({ success: false, throttle: true, remainingMs: err.remainingMs, error: `Tunggu ${Math.ceil(err.remainingMs / 1000)} detik sebelum App Sinkron ALL lagi.` });
      return;
    }
    logger.error({ err }, 'handleSyncAppAll error');
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Gagal App Sinkron ALL.' });
  }
}

export async function handleSyncReportAll(req: Request, res: Response): Promise<void> {
  try {
    const r = await syncReportAllMerchants();
    res.json({ success: true, source: 'report', ...r });
  } catch (err) {
    logger.error({ err }, 'handleSyncReportAll error');
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Gagal Report Sinkron ALL.' });
  }
}

export async function getAppCooldownStatusApi(req: Request, res: Response): Promise<void> {
  try {
    const data = await listAppCooldownStatus();
    res.json({ ok: true, ...data });
  } catch (err) {
    logger.error({ err }, 'getAppCooldownStatusApi error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil status cooldown.' });
  }
}
