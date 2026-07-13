import { spawn } from 'child_process';
import type { Mutation, QrisAccount } from '@prisma/client';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { decrypt } from '../core/encryption';
import { storeMutationIfNew } from './mutation-ingest.service';

const WEB_REPORT_BASE = 'https://report.orderkuota.com';
const WEB_REPORT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

/** Autologin ke Web Report -> cookie sesi fresh (ci_session) atau null. */
export async function autologinReportCookie(autologinUrl: string): Promise<{ cookie: string; userAgent: string } | null> {
  try {
    const res = await fetch(autologinUrl, {
      headers: {
        'User-Agent': WEB_REPORT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: WEB_REPORT_BASE + '/transaksi',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    const hdr = res.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies: string[] = typeof hdr.getSetCookie === 'function' ? hdr.getSetCookie() : [];
    const jar: Record<string, string> = {};
    for (const sc of setCookies) {
      const m = /^\s*([^=]+)=([^;]+)/.exec(sc);
      if (m) jar[m[1].trim()] = m[2].trim();
    }
    if (!jar.ci_session) {
      logger.warn({ status: res.status }, 'autologinReportCookie: ci_session tidak ditemukan');
      return null;
    }
    const parts: string[] = [];
    if (jar.csrf_cookie_name) parts.push('csrf_cookie_name=' + jar.csrf_cookie_name);
    parts.push('ci_session=' + jar.ci_session);
    return { cookie: parts.join('; '), userAgent: WEB_REPORT_UA };
  } catch (err) {
    logger.warn({ err }, 'autologinReportCookie error');
    return null;
  }
}

// Cache cookie ci_session (server set Max-Age 7200 = 2 jam) supaya TIDAK login-ulang tiap request
// -> mencegah burst 429 dari Cloudflare report.orderkuota.com (akar masalah "OUT semua").
type ReportCookie = { cookie: string; userAgent: string };
const reportCookieCache = new Map<string, { c: ReportCookie; exp: number }>();
const reportBackoff = new Map<string, number>(); // key -> waktu (ms) berhenti coba setelah gagal/429
const REPORT_COOKIE_TTL_MS = 100 * 60 * 1000; // 100 menit (< 2 jam server)
const REPORT_BACKOFF_MS = 5 * 60 * 1000;       // diam 5 menit setelah gagal (anti-hammer saat 429)
// Serialkan autologin: hanya 1 autologin jalan pada satu waktu + jeda kecil -> anti-burst.
let reportAutologinChain: Promise<unknown> = Promise.resolve();
function serializeAutologin(url: string): Promise<ReportCookie | null> {
  const task = async (): Promise<ReportCookie | null> => {
    const r = await autologinReportCookie(url);
    await new Promise((res) => setTimeout(res, 700));
    return r;
  };
  const next = reportAutologinChain.then(task, task);
  reportAutologinChain = next.catch(() => undefined);
  return next;
}

async function autologinCookieForAccount(
  webReportUrlEncrypted?: string | null,
): Promise<{ cookie: string; userAgent: string } | null> {
  if (!webReportUrlEncrypted) return null;
  const key = webReportUrlEncrypted;
  const now = Date.now();
  const cached = reportCookieCache.get(key);
  if (cached && cached.exp > now) return cached.c;            // cookie masih segar -> 0 request
  const bo = reportBackoff.get(key);
  if (bo && bo > now) return cached ? cached.c : null;        // lagi backoff -> jangan hammer, pakai cookie lama bila ada
  let url: string;
  try { url = decrypt(webReportUrlEncrypted); } catch { return null; }
  const auto = await serializeAutologin(url);
  if (!auto) { reportBackoff.set(key, now + REPORT_BACKOFF_MS); return cached ? cached.c : null; }
  reportCookieCache.set(key, { c: auto, exp: Date.now() + REPORT_COOKIE_TTL_MS });
  reportBackoff.delete(key);
  return auto;
}

// Watchdog: tiap 60 dtk, akun yang cookie-nya hilang/mau-habis -> AUTO login pakai link permanen.
// Aman dari 429: cookie segar dilewati (0 request) + serialize + backoff (reuse infra di atas).
const REPORT_WATCHDOG_MS = 60 * 1000;
const REPORT_REFRESH_MARGIN_MS = 10 * 60 * 1000; // login-ulang bila sisa < 10 menit
async function ensureReportCookieFresh(enc: string): Promise<'skip' | 'ok' | 'fail'> {
  const now = Date.now();
  const cached = reportCookieCache.get(enc);
  const bo = reportBackoff.get(enc);
  if (bo && bo > now) return 'skip';
  if (cached && cached.exp > now + REPORT_REFRESH_MARGIN_MS) return 'skip';
  let url: string;
  try { url = decrypt(enc); } catch { return 'fail'; }
  const auto = await serializeAutologin(url);
  if (!auto) { reportBackoff.set(enc, now + REPORT_BACKOFF_MS); return 'fail'; }
  reportCookieCache.set(enc, { c: auto, exp: Date.now() + REPORT_COOKIE_TTL_MS });
  reportBackoff.delete(enc);
  return 'ok';
}
let reportWatchdogTimer: ReturnType<typeof setInterval> | null = null;
export function startReportLoginWatchdog(): void {
  if (reportWatchdogTimer) return;
  const tick = async (): Promise<void> => {
    try {
      const accounts = await db.qrisAccount.findMany({
        where: { status: 'active', webReportUrlEncrypted: { not: null } },
        select: { webReportUrlEncrypted: true },
      });
      let relogin = 0;
      for (const a of accounts) {
        if (!a.webReportUrlEncrypted) continue;
        if ((await ensureReportCookieFresh(a.webReportUrlEncrypted)) === 'ok') relogin++;
      }
      if (relogin) logger.info({ relogin }, 'reportLoginWatchdog: auto re-login web report');
    } catch (err) { logger.warn({ err }, 'reportLoginWatchdog error'); }
  };
  reportWatchdogTimer = setInterval(() => { void tick(); }, REPORT_WATCHDOG_MS);
  setTimeout(() => { void tick(); }, 8000);
  logger.info('reportLoginWatchdog started (auto re-login web report tiap 60s)');
}


type WalletTarget = 'qris' | 'utama' | 'both';

type RawPythonMutation = {
  amount: number;
  type: 'credit' | 'debit';
  balanceBefore: number;
  balanceAfter: number;
  issuerName: string | null;
  rrn: string | null;
  walletCategory: 'qris' | 'utama' | 'madera' | null;
  transactionTime: string;
  rawHash: string;
  rawDataJson: string;
};

type PythonWalletPayload = {
  mutations: RawPythonMutation[];
  count: number;
  balance: number | null;
  meta?: {
    accountName?: string | null;
    detectedPattern?: string | null;
    pagesRead?: number | null;
    pageBase?: string | null;
  };
};

type PythonScrapeResult = {
  ok: boolean;
  target: WalletTarget;
  qris: PythonWalletPayload;
  utama: PythonWalletPayload;
};

export type ReportSyncStats = {
  mainBalance: number | null;
  qrisBalance: number | null;
  newQrisMutations: number;
  newUtamaMutations: number;
};

const reportSyncInFlight = new Map<string, Promise<ReportSyncStats>>();
const reportSyncLastRunAt = new Map<string, number>();
const DEFAULT_REPORT_SYNC_MAX_AGE_MS = 15_000;

function getPythonBinCandidates(): string[] {
  const explicit = [
    process.env.PYTHON_BIN?.trim(),
    process.env.PYTHON_EXECUTABLE?.trim(),
  ].filter((value): value is string => !!value);
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }
  return process.platform === 'win32'
    ? ['python', 'py']
    : ['python3', 'python'];
}

function getCookieSource(account: Pick<QrisAccount, 'webCookiesEncrypted' | 'cookiesEncrypted'>): string | null {
  return account.webCookiesEncrypted ?? account.cookiesEncrypted ?? null;
}

function decryptReportCookie(account: Pick<QrisAccount, 'code' | 'webCookiesEncrypted' | 'cookiesEncrypted'>): string {
  const cookieSource = getCookieSource(account);
  if (!cookieSource) {
    throw new Error('Web Session Cookie merchant belum diisi.');
  }
  try {
    return decrypt(cookieSource);
  } catch (err) {
    logger.warn({ err, accountCode: account.code }, 'report-python: failed to decrypt report cookie');
    throw new Error('Web Session Cookie merchant tidak bisa dibuka.');
  }
}

// merchantId QRIS (api/v2/qris/mutasi/{id}) = angka di LINK AUTOLOGIN (sumber sahih).
// account.accountNumber bisa nomor HP/rekening -> merchantId salah -> HTTP 403 / fallback /mutasi_qris 404.
function deriveMerchantId(account: any): string | undefined {
  let merchantId: string | undefined = (account && account.accountNumber) || undefined;
  try {
    const enc = account && account.webReportUrlEncrypted;
    if (enc) { const m = String(decrypt(enc)).match(/\/autologin\/(\d+)/); if (m) merchantId = m[1]; }
  } catch { /* fallback accountNumber */ }
  return merchantId;
}

function runPythonReportScraper(
  account: Pick<QrisAccount, 'code' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>,
  target: WalletTarget,
): Promise<PythonScrapeResult> {
  return runPythonReportScraperRaw({
    cookie: decryptReportCookie(account),
    userAgent: account.webUserAgent || undefined,
    target,
    merchantId: deriveMerchantId(account),
  });
}

function runPythonReportScraperRaw(input: {
    maxPages?: number;
    merchantId?: string;
  cookie: string;
  userAgent?: string | null;
  target: WalletTarget;
}): Promise<PythonScrapeResult> {
  const payload = JSON.stringify({
    cookie: input.cookie,
    userAgent: input.userAgent || undefined,
    target: input.target,
    maxPages: input.maxPages ?? 3,
    merchantId: input.merchantId,
  });

  const candidates = getPythonBinCandidates();

  const trySpawn = (index: number): Promise<PythonScrapeResult> => new Promise((resolve, reject) => {
    const bin = candidates[index];
    const child = spawn(
      bin,
      ['python/orderkuota_report_scraper.py', '--stdin'],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && index + 1 < candidates.length) {
        resolve(trySpawn(index + 1));
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python scraper keluar dengan kode ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as PythonScrapeResult);
      } catch (err) {
        reject(new Error(`Output scraper Python tidak valid: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    child.stdin.end(payload);
  });

  return trySpawn(0);
}

async function ingestWalletMutations(accountId: string, rows: RawPythonMutation[]): Promise<number> {
  let createdCount = 0;
  for (const row of rows) {
    const result = await storeMutationIfNew({
      qrisAccountId: accountId,
      amount: row.amount,
      type: row.type,
      balanceBefore: row.balanceBefore,
      balanceAfter: row.balanceAfter,
      issuerName: row.issuerName ?? null,
      rrn: row.rrn ?? null,
      walletCategory: row.walletCategory ?? null,
      transactionTime: new Date(row.transactionTime),
      rawHash: row.rawHash,
      rawDataJson: row.rawDataJson,
    });
    if (result.created) createdCount += 1;
  }
  return createdCount;
}

export async function probeMerchantMutationsFromReport(
  account: Pick<QrisAccount, 'code' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>,
  target: WalletTarget = 'both',
): Promise<PythonScrapeResult> {
  const auto = await autologinCookieForAccount((account as any).webReportUrlEncrypted);
  const merchantId = deriveMerchantId(account);
  if (auto) return runPythonReportScraperRaw({ cookie: auto.cookie, userAgent: auto.userAgent, target, merchantId });
  return runPythonReportScraper(account, target);
}

export async function probeMerchantMutationsFromRawReportInput(input: {
  cookie: string;
  userAgent?: string | null;
  target?: WalletTarget;
  merchantId?: string;
}): Promise<PythonScrapeResult> {
  return runPythonReportScraperRaw({
    cookie: input.cookie,
    userAgent: input.userAgent,
    target: input.target ?? 'both',
    merchantId: input.merchantId,
  });
}

export type { PythonScrapeResult, WalletTarget };

export async function syncMerchantMutationsFromReport(
  account: Pick<
    QrisAccount,
    'id' | 'code' | 'lastMainBalance' | 'lastQrisBalance' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'
  >,
  target: WalletTarget = 'both',
): Promise<ReportSyncStats> {
  const statsKey = `${account.id}:${target}`;
  const existing = reportSyncInFlight.get(statsKey);
  if (existing) return existing;

  const promise = (async () => {
    const auto = await autologinCookieForAccount((account as any).webReportUrlEncrypted);
    const merchantId = deriveMerchantId(account);
    const scrapeResult = auto
      ? await runPythonReportScraperRaw({ cookie: auto.cookie, userAgent: auto.userAgent, target, merchantId })
      : await runPythonReportScraper(account, target);
    const newQrisMutations = target === 'utama'
      ? 0
      : await ingestWalletMutations(account.id, scrapeResult.qris.mutations);
    const newUtamaMutations = target === 'qris'
      ? 0
      : await ingestWalletMutations(account.id, scrapeResult.utama.mutations);

    const mainBalance = scrapeResult.utama.balance ?? account.lastMainBalance ?? null;
    const qrisBalance = scrapeResult.qris.balance ?? account.lastQrisBalance ?? null;

    await db.qrisAccount.update({
      where: { id: account.id },
      data: {
        lastMainBalance: mainBalance,
        lastQrisBalance: qrisBalance,
        lastBalanceSyncAt: new Date(),
        lastBalanceSyncStatus: 'synced',
        lastBalanceSyncError: null,
        lastBalanceSyncRawJson: JSON.stringify({
          source: 'python_report_scraper',
          target,
          qrisCount: scrapeResult.qris.count,
          utamaCount: scrapeResult.utama.count,
        }),
      },
    });

    reportSyncLastRunAt.set(statsKey, Date.now());
    return {
      mainBalance,
      qrisBalance,
      newQrisMutations,
      newUtamaMutations,
    };
  })();

  reportSyncInFlight.set(statsKey, promise);
  promise.finally(() => {
    if (reportSyncInFlight.get(statsKey) === promise) {
      reportSyncInFlight.delete(statsKey);
    }
  }).catch(() => undefined);
  return promise;
}

export async function syncMerchantMutationsFromReportIfStale(
  account: Pick<
    QrisAccount,
    'id' | 'code' | 'lastMainBalance' | 'lastQrisBalance' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'
  >,
  target: WalletTarget = 'both',
  maxAgeMs = DEFAULT_REPORT_SYNC_MAX_AGE_MS,
): Promise<ReportSyncStats | null> {
  if (!getCookieSource(account)) return null;
  const statsKey = `${account.id}:${target}`;
  const lastRunAt = reportSyncLastRunAt.get(statsKey) ?? 0;
  if (Date.now() - lastRunAt < maxAgeMs) {
    return null;
  }
  return syncMerchantMutationsFromReport(account, target);
}


/** Cek status login Web Report: none (belum ada link) | active | expired. */
export async function checkWebReportLogin(webReportUrlEncrypted?: string | null): Promise<'none' | 'active' | 'expired'> {
  if (!webReportUrlEncrypted) return 'none';
  // Pakai cookie tercache (login-ulang hanya bila kadaluarsa) -> status tanpa hammer report.orderkuota.
  const auto = await autologinCookieForAccount(webReportUrlEncrypted);
  return auto ? 'active' : 'expired';
}


export async function fetchReportWalletLive(
  account: Pick<QrisAccount, 'code' | 'accountNumber' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'> & { webReportUrlEncrypted?: string | null },
  wallet: 'qris' | 'utama',
  maxPages = 5,
): Promise<PythonWalletPayload | null> {
  const auto = await autologinCookieForAccount((account as any).webReportUrlEncrypted);
  let cookie: string;
  let userAgent: string | undefined;
  if (auto) {
    cookie = auto.cookie;
    userAgent = auto.userAgent;
  } else {
    try { cookie = decryptReportCookie(account); } catch { return null; }
    userAgent = account.webUserAgent || undefined;
  }
  if (!cookie) return null;
  // merchantId QRIS (api/v2/qris/mutasi/{id}) = angka di LINK AUTOLOGIN (sumber sahih).
  // account.accountNumber bisa nomor HP/rekening -> merchantId salah -> HTTP 403.
  let merchantId: string | undefined = account.accountNumber || undefined;
  try {
    const enc = (account as { webReportUrlEncrypted?: string | null }).webReportUrlEncrypted;
    if (enc) { const m = String(decrypt(enc)).match(/\/autologin\/(\d+)/); if (m) merchantId = m[1]; }
  } catch { /* fallback ke accountNumber */ }
  const result = await runPythonReportScraperRaw({ cookie, userAgent, target: wallet, maxPages, merchantId });
  return wallet === 'qris' ? result.qris : result.utama;
}

/**
 * Fase 4: tarik mutasi QRIS terbaru dari web report (autologin API v2) lalu ingest ke DB.
 * CREDIT-saja + saldoAkhir>0: report kadang label penarikan sbg debit, dan bal=0 bikin dedup
 * NORRN (mutv2) tabrakan antar pembayaran. Ingest via storeMutationIfNew (dedup dedupKey).
 * MELEMPAR error kalau report gagal keras (403/Cloudflare/exit!=0) -> pemanggil WAJIB try/catch.
 */
export async function fetchAndIngestReportQrisCredit(
  account: Pick<QrisAccount, 'id' | 'code' | 'accountNumber' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'> & { webReportUrlEncrypted?: string | null },
  maxPages = 1,
): Promise<number> {
  const payload = await fetchReportWalletLive(account, 'qris', maxPages);
  const rows = (payload?.mutations ?? []).filter((m) => m.type === 'credit' && Number(m.balanceAfter) > 0);
  if (rows.length === 0) return 0;
  return ingestWalletMutations(account.id, rows);
}
