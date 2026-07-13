import { db } from '../../config/database';
import { encrypt, decrypt } from '../../core/encryption';
import { siteIdForAccount } from '../../shared/site.service';

// Ditolak saat mengaktifkan akun yang belum di-assign ke Site (gerbang aman merchant baru).
export class AccountActivationError extends Error {}

export function normalizeCookiePairs(raw: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const segment of raw.split(';')) {
    const token = segment.trim();
    if (!token || !token.includes('=')) continue;
    const [name, ...rest] = token.split('=');
    const key = name.trim();
    const value = rest.join('=').trim();
    if (!key || !value) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${key}=${value}`);
  }
  return parts.join('; ');
}

export function normalizeCookieInput(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.replace(/\r/g, '').trim();
  if (!text) return null;

  const cookieLines: string[] = [];
  const setCookiePairs: string[] = [];
  let captureMode: 'cookie' | 'set-cookie' | null = null;

  for (const sourceLine of text.split('\n')) {
    const line = sourceLine.trim();
    if (!line) continue;

    const cookieMatch = line.match(/^cookie\s*:\s*(.*)$/i);
    if (cookieMatch) {
      captureMode = 'cookie';
      if (cookieMatch[1]) cookieLines.push(cookieMatch[1].trim());
      continue;
    }

    const setCookieMatch = line.match(/^set-cookie\s*:\s*(.*)$/i);
    if (setCookieMatch) {
      captureMode = 'set-cookie';
      const normalized = normalizeCookiePairs(setCookieMatch[1]);
      const firstPair = normalized.split('; ')[0];
      if (firstPair) setCookiePairs.push(firstPair);
      continue;
    }

    if (/^[a-z-]+\s*:/i.test(line)) {
      captureMode = null;
      continue;
    }

    if (captureMode === 'cookie') {
      cookieLines.push(line);
      continue;
    }

    if (captureMode === 'set-cookie') {
      const normalized = normalizeCookiePairs(line);
      const firstPair = normalized.split('; ')[0];
      if (firstPair) setCookiePairs.push(firstPair);
    }
  }

  const cookieBlock = normalizeCookiePairs(cookieLines.join('; '));
  if (cookieBlock) {
    const existingNames = new Set(
      cookieBlock.split('; ').map((part) => part.split('=')[0]?.trim()).filter(Boolean),
    );
    const missingSetCookies = setCookiePairs.filter((pair) => {
      const key = pair.split('=')[0]?.trim();
      return key && !existingNames.has(key);
    });
    return normalizeCookiePairs([...missingSetCookies, cookieBlock].join('; ')) || null;
  }

  const direct = normalizeCookiePairs(text);
  if (direct) return direct;

  return normalizeCookiePairs(setCookiePairs.join('; ')) || null;
}

export function normalizeUserAgentInput(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.replace(/\r/g, '').trim();
  if (!text) return null;
  const match = text.match(/^user-agent\s*:\s*(.+)$/i);
  return (match ? match[1] : text).trim() || null;
}

export function normalizeAppRegIdInput(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.replace(/\r/g, '').trim();
  return text || null;
}

export async function listQrisAccounts() {
  return db.qrisAccount.findMany({ orderBy: { code: 'asc' } });
}

export async function listQrisAccountsStatus() {
  const accounts = await db.qrisAccount.findMany({
    orderBy: { code: 'asc' },
    select: {
      id: true,
      lastWatchProbeAt: true,
      lastWatchProbeStatus: true,
      lastWatchProbeError: true,
      lastConnectionTestAt: true,
      lastConnectionTestStatus: true,
      lastBalanceSyncAt: true,
      lastBalanceSyncStatus: true,
      sessionTokenEncrypted: true,
    },
  });

  const now = Date.now();
  return accounts.map((acc) => ({
    id: acc.id,
    lastWatchProbeAt: acc.lastWatchProbeAt?.toISOString() ?? null,
    lastWatchProbeStatus: acc.lastWatchProbeStatus,
    lastConnectionTestAt: acc.lastConnectionTestAt?.toISOString() ?? null,
    lastConnectionTestStatus: acc.lastConnectionTestStatus,
    lastBalanceSyncAt: acc.lastBalanceSyncAt?.toISOString() ?? null,
    lastBalanceSyncStatus: acc.lastBalanceSyncStatus,
    hasSession: !!acc.sessionTokenEncrypted,
    probeAgeMs: acc.lastWatchProbeAt ? now - acc.lastWatchProbeAt.getTime() : null,
  }));
}

export async function getQrisAccountById(id: string) {
  return db.qrisAccount.findUnique({ where: { id } });
}

export async function createQrisAccount(data: {
  code: string;
  accountNumber: string;
  merchantName: string;
  orkutAccountIndex?: number;
  dailyLimit?: number;
  qrisPayload?: string;
  sessionToken?: string;
  cookies?: string;
  webCookies?: string;
  webUserAgent?: string;
  deviceId?: string;
  transferPin?: string;
  balanceWatchActiveSeconds?: number;
  detailPollSeconds?: number;
}) {
  const normalizedAppRegId = normalizeAppRegIdInput(data.cookies);
  const normalizedWebCookies = normalizeCookieInput(data.webCookies);
  const normalizedWebUserAgent = normalizeUserAgentInput(data.webUserAgent);

  return db.qrisAccount.create({
    data: {
      code: data.code.toUpperCase(),
      accountNumber: data.accountNumber,
      merchantName: data.merchantName,
      orkutAccountIndex: data.orkutAccountIndex ?? null,
      dailyLimit: data.dailyLimit ?? 30_000_000,
      status: 'inactive', // FLOW AMAN: akun baru lahir NONAKTIF (parkir) -> aktif manual setelah di-assign Site
      healthStatus: 'healthy',
      lastAssignedAt: new Date(),
      qrisPayload: data.qrisPayload || null,
      sessionTokenEncrypted: data.sessionToken ? encrypt(data.sessionToken) : null,
      cookiesEncrypted: normalizedAppRegId ? encrypt(normalizedAppRegId) : null,
      webCookiesEncrypted: normalizedWebCookies ? encrypt(normalizedWebCookies) : null,
      webUserAgent: normalizedWebUserAgent,
      deviceId: data.deviceId || null,
      transferPinEncrypted: data.transferPin ? encrypt(data.transferPin) : null,
      watcherStrategy: 'python_balance',
      balanceWatchActiveSeconds: data.balanceWatchActiveSeconds ?? 2,
      balanceWatchIdleSeconds: data.balanceWatchActiveSeconds ?? 2,
      fallbackSyncActiveSeconds: 0,
      fallbackSyncIdleSeconds: 0,
      qrisActivePollSeconds: 300,
      qrisIdlePollSeconds: 300,
      balancePollSeconds: 300,
      detailPollSeconds: data.detailPollSeconds ?? 20,
    },
  });
}

export async function updateQrisAccount(
  id: string,
  data: {
    accountNumber?: string;
    merchantName?: string;
    orkutAccountIndex?: number;
    dailyLimit?: number;
    qrisPayload?: string;
    sessionToken?: string;
    cookies?: string;
    webCookies?: string;
    webUserAgent?: string;
    deviceId?: string;
    transferPin?: string;
    balanceWatchActiveSeconds?: number;
    detailPollSeconds?: number;
  },
) {
  const updateData: Record<string, unknown> = {};

  if (data.accountNumber !== undefined) updateData.accountNumber = data.accountNumber;
  if (data.merchantName !== undefined) updateData.merchantName = data.merchantName;
  if (data.orkutAccountIndex !== undefined) {
    updateData.orkutAccountIndex = data.orkutAccountIndex ?? null;
  }
  if (data.dailyLimit !== undefined) updateData.dailyLimit = data.dailyLimit;
  if (data.qrisPayload !== undefined) updateData.qrisPayload = data.qrisPayload || null;
  if (data.deviceId !== undefined) updateData.deviceId = data.deviceId || null;
  if (data.webUserAgent !== undefined) {
    updateData.webUserAgent = normalizeUserAgentInput(data.webUserAgent);
  }
  updateData.watcherStrategy = 'python_balance';
  if (data.balanceWatchActiveSeconds !== undefined) {
    updateData.balanceWatchActiveSeconds = data.balanceWatchActiveSeconds;
    updateData.balanceWatchIdleSeconds = data.balanceWatchActiveSeconds;
  }
  updateData.fallbackSyncActiveSeconds = 0;
  updateData.fallbackSyncIdleSeconds = 0;
  updateData.qrisActivePollSeconds = 300;
  updateData.qrisIdlePollSeconds = 300;
  updateData.balancePollSeconds = 300;
  if (data.detailPollSeconds !== undefined) updateData.detailPollSeconds = data.detailPollSeconds;

  if (data.sessionToken !== undefined) {
    updateData.sessionTokenEncrypted = data.sessionToken ? encrypt(data.sessionToken) : null;
  }
  if (data.cookies !== undefined) {
    const normalizedAppRegId = normalizeAppRegIdInput(data.cookies);
    updateData.cookiesEncrypted = normalizedAppRegId ? encrypt(normalizedAppRegId) : null;
  }
  if (data.webCookies !== undefined) {
    const normalizedWebCookies = normalizeCookieInput(data.webCookies);
    updateData.webCookiesEncrypted = normalizedWebCookies ? encrypt(normalizedWebCookies) : null;
  }
  if (data.transferPin !== undefined) {
    updateData.transferPinEncrypted = data.transferPin ? encrypt(data.transferPin) : null;
  }

  return db.qrisAccount.update({ where: { id }, data: updateData });
}

export async function toggleAccountStatus(id: string): Promise<string> {
  const account = await db.qrisAccount.findUniqueOrThrow({ where: { id } });
  const newStatus = account.status === 'active' ? 'inactive' : 'active';
  // GERBANG AMAN: akun hanya boleh AKTIF bila sudah di-assign ke Site (cegah akun belum-siap ikut generate/round-robin).
  if (newStatus === 'active' && !siteIdForAccount(id)) {
    throw new AccountActivationError('Akun harus di-assign ke Site dulu sebelum diaktifkan.');
  }
  await db.qrisAccount.update({ where: { id }, data: { status: newStatus } });
  return newStatus;
}

export async function setHealthStatus(
  id: string,
  healthStatus: 'healthy' | 'degraded' | 'down',
): Promise<void> {
  await db.qrisAccount.update({ where: { id }, data: { healthStatus } });
}

export async function deleteQrisAccount(id: string): Promise<void> {
  const account = await db.qrisAccount.findUnique({ where: { id } });
  if (!account) {
    throw new Error('Akun QRIS tidak ditemukan.');
  }

  await db.$transaction(async (tx) => {
    await tx.mutation.deleteMany({
      where: { qrisAccountId: id },
    });

    await tx.depositAttempt.deleteMany({
      where: {
        transaction: {
          qrisAccountId: id,
        },
      },
    });

    await tx.amountLock.deleteMany({
      where: { qrisAccountId: id },
    });

    await tx.transaction.deleteMany({
      where: { qrisAccountId: id },
    });

    await tx.qrisAccount.delete({
      where: { id },
    });
  });
}

export async function resetDailyUsage(id: string): Promise<void> {
  await db.qrisAccount.update({
    where: { id },
    data: { usedToday: 0, lastResetAt: new Date() },
  });
}

/**
 * Returns the decrypted session token and cookies for display in the edit form.
 * Only called when admin explicitly requests it.
 */
export async function getDecryptedCredentials(id: string) {
  const account = await db.qrisAccount.findUniqueOrThrow({ where: { id } });
  return {
    sessionToken: account.sessionTokenEncrypted
      ? decrypt(account.sessionTokenEncrypted)
      : null,
    cookies: account.cookiesEncrypted ? decrypt(account.cookiesEncrypted) : null,
    webCookies: account.webCookiesEncrypted ? decrypt(account.webCookiesEncrypted) : null,
    webUserAgent: account.webUserAgent ?? null,
    transferPin: account.transferPinEncrypted ? decrypt(account.transferPinEncrypted) : null,
  };
}
