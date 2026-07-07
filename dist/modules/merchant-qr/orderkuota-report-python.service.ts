import { spawn } from 'child_process';
import type { Mutation, QrisAccount } from '@prisma/client';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { decrypt } from '../core/encryption';
import { storeMutationIfNew } from './mutation-ingest.service';

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

function runPythonReportScraper(
  account: Pick<QrisAccount, 'code' | 'webCookiesEncrypted' | 'cookiesEncrypted' | 'webUserAgent'>,
  target: WalletTarget,
): Promise<PythonScrapeResult> {
  return runPythonReportScraperRaw({
    cookie: decryptReportCookie(account),
    userAgent: account.webUserAgent || undefined,
    target,
  });
}

function runPythonReportScraperRaw(input: {
  cookie: string;
  userAgent?: string | null;
  target: WalletTarget;
}): Promise<PythonScrapeResult> {
  const payload = JSON.stringify({
    cookie: input.cookie,
    userAgent: input.userAgent || undefined,
    target: input.target,
    maxPages: 3,
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
  return runPythonReportScraper(account, target);
}

export async function probeMerchantMutationsFromRawReportInput(input: {
  cookie: string;
  userAgent?: string | null;
  target?: WalletTarget;
}): Promise<PythonScrapeResult> {
  return runPythonReportScraperRaw({
    cookie: input.cookie,
    userAgent: input.userAgent,
    target: input.target ?? 'both',
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
    const scrapeResult = await runPythonReportScraper(account, target);
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
