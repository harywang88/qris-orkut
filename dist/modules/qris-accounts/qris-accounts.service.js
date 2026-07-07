"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCookiePairs = normalizeCookiePairs;
exports.normalizeCookieInput = normalizeCookieInput;
exports.normalizeUserAgentInput = normalizeUserAgentInput;
exports.normalizeAppRegIdInput = normalizeAppRegIdInput;
exports.listQrisAccounts = listQrisAccounts;
exports.listQrisAccountsStatus = listQrisAccountsStatus;
exports.getQrisAccountById = getQrisAccountById;
exports.createQrisAccount = createQrisAccount;
exports.updateQrisAccount = updateQrisAccount;
exports.toggleAccountStatus = toggleAccountStatus;
exports.setHealthStatus = setHealthStatus;
exports.deleteQrisAccount = deleteQrisAccount;
exports.resetDailyUsage = resetDailyUsage;
exports.getDecryptedCredentials = getDecryptedCredentials;
const database_1 = require("../../config/database");
const encryption_1 = require("../../core/encryption");
function normalizeCookiePairs(raw) {
    const seen = new Set();
    const parts = [];
    for (const segment of raw.split(';')) {
        const token = segment.trim();
        if (!token || !token.includes('='))
            continue;
        const [name, ...rest] = token.split('=');
        const key = name.trim();
        const value = rest.join('=').trim();
        if (!key || !value)
            continue;
        if (seen.has(key))
            continue;
        seen.add(key);
        parts.push(`${key}=${value}`);
    }
    return parts.join('; ');
}
function normalizeCookieInput(raw) {
    if (!raw)
        return null;
    const text = raw.replace(/\r/g, '').trim();
    if (!text)
        return null;
    const cookieLines = [];
    const setCookiePairs = [];
    let captureMode = null;
    for (const sourceLine of text.split('\n')) {
        const line = sourceLine.trim();
        if (!line)
            continue;
        const cookieMatch = line.match(/^cookie\s*:\s*(.*)$/i);
        if (cookieMatch) {
            captureMode = 'cookie';
            if (cookieMatch[1])
                cookieLines.push(cookieMatch[1].trim());
            continue;
        }
        const setCookieMatch = line.match(/^set-cookie\s*:\s*(.*)$/i);
        if (setCookieMatch) {
            captureMode = 'set-cookie';
            const normalized = normalizeCookiePairs(setCookieMatch[1]);
            const firstPair = normalized.split('; ')[0];
            if (firstPair)
                setCookiePairs.push(firstPair);
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
            if (firstPair)
                setCookiePairs.push(firstPair);
        }
    }
    const cookieBlock = normalizeCookiePairs(cookieLines.join('; '));
    if (cookieBlock) {
        const existingNames = new Set(cookieBlock.split('; ').map((part) => part.split('=')[0]?.trim()).filter(Boolean));
        const missingSetCookies = setCookiePairs.filter((pair) => {
            const key = pair.split('=')[0]?.trim();
            return key && !existingNames.has(key);
        });
        return normalizeCookiePairs([...missingSetCookies, cookieBlock].join('; ')) || null;
    }
    const direct = normalizeCookiePairs(text);
    if (direct)
        return direct;
    return normalizeCookiePairs(setCookiePairs.join('; ')) || null;
}
function normalizeUserAgentInput(raw) {
    if (!raw)
        return null;
    const text = raw.replace(/\r/g, '').trim();
    if (!text)
        return null;
    const match = text.match(/^user-agent\s*:\s*(.+)$/i);
    return (match ? match[1] : text).trim() || null;
}
function normalizeAppRegIdInput(raw) {
    if (!raw)
        return null;
    const text = raw.replace(/\r/g, '').trim();
    return text || null;
}
async function listQrisAccounts() {
    return database_1.db.qrisAccount.findMany({ orderBy: { code: 'asc' } });
}
async function listQrisAccountsStatus() {
    const accounts = await database_1.db.qrisAccount.findMany({
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
async function getQrisAccountById(id) {
    return database_1.db.qrisAccount.findUnique({ where: { id } });
}
async function createQrisAccount(data) {
    const normalizedAppRegId = normalizeAppRegIdInput(data.cookies);
    const normalizedWebCookies = normalizeCookieInput(data.webCookies);
    const normalizedWebUserAgent = normalizeUserAgentInput(data.webUserAgent);
    return database_1.db.qrisAccount.create({
        data: {
            code: data.code.toUpperCase(),
            accountNumber: data.accountNumber,
            merchantName: data.merchantName,
            orkutAccountIndex: data.orkutAccountIndex ?? null,
            dailyLimit: data.dailyLimit ?? 30000000,
            status: 'active',
            healthStatus: 'healthy',
            qrisPayload: data.qrisPayload || null,
            sessionTokenEncrypted: data.sessionToken ? (0, encryption_1.encrypt)(data.sessionToken) : null,
            cookiesEncrypted: normalizedAppRegId ? (0, encryption_1.encrypt)(normalizedAppRegId) : null,
            webCookiesEncrypted: normalizedWebCookies ? (0, encryption_1.encrypt)(normalizedWebCookies) : null,
            webUserAgent: normalizedWebUserAgent,
            deviceId: data.deviceId || null,
            transferPinEncrypted: data.transferPin ? (0, encryption_1.encrypt)(data.transferPin) : null,
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
async function updateQrisAccount(id, data) {
    const updateData = {};
    if (data.accountNumber !== undefined)
        updateData.accountNumber = data.accountNumber;
    if (data.merchantName !== undefined)
        updateData.merchantName = data.merchantName;
    if (data.orkutAccountIndex !== undefined) {
        updateData.orkutAccountIndex = data.orkutAccountIndex ?? null;
    }
    if (data.dailyLimit !== undefined)
        updateData.dailyLimit = data.dailyLimit;
    if (data.qrisPayload !== undefined)
        updateData.qrisPayload = data.qrisPayload || null;
    if (data.deviceId !== undefined)
        updateData.deviceId = data.deviceId || null;
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
    if (data.detailPollSeconds !== undefined)
        updateData.detailPollSeconds = data.detailPollSeconds;
    if (data.sessionToken !== undefined) {
        updateData.sessionTokenEncrypted = data.sessionToken ? (0, encryption_1.encrypt)(data.sessionToken) : null;
    }
    if (data.cookies !== undefined) {
        const normalizedAppRegId = normalizeAppRegIdInput(data.cookies);
        updateData.cookiesEncrypted = normalizedAppRegId ? (0, encryption_1.encrypt)(normalizedAppRegId) : null;
    }
    if (data.webCookies !== undefined) {
        const normalizedWebCookies = normalizeCookieInput(data.webCookies);
        updateData.webCookiesEncrypted = normalizedWebCookies ? (0, encryption_1.encrypt)(normalizedWebCookies) : null;
    }
    if (data.transferPin !== undefined) {
        updateData.transferPinEncrypted = data.transferPin ? (0, encryption_1.encrypt)(data.transferPin) : null;
    }
    return database_1.db.qrisAccount.update({ where: { id }, data: updateData });
}
async function toggleAccountStatus(id) {
    const account = await database_1.db.qrisAccount.findUniqueOrThrow({ where: { id } });
    const newStatus = account.status === 'active' ? 'inactive' : 'active';
    await database_1.db.qrisAccount.update({ where: { id }, data: { status: newStatus } });
    return newStatus;
}
async function setHealthStatus(id, healthStatus) {
    await database_1.db.qrisAccount.update({ where: { id }, data: { healthStatus } });
}
async function deleteQrisAccount(id) {
    const account = await database_1.db.qrisAccount.findUnique({ where: { id } });
    if (!account) {
        throw new Error('Akun QRIS tidak ditemukan.');
    }
    await database_1.db.$transaction(async (tx) => {
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
async function resetDailyUsage(id) {
    await database_1.db.qrisAccount.update({
        where: { id },
        data: { usedToday: 0, lastResetAt: new Date() },
    });
}
/**
 * Returns the decrypted session token and cookies for display in the edit form.
 * Only called when admin explicitly requests it.
 */
async function getDecryptedCredentials(id) {
    const account = await database_1.db.qrisAccount.findUniqueOrThrow({ where: { id } });
    return {
        sessionToken: account.sessionTokenEncrypted
            ? (0, encryption_1.decrypt)(account.sessionTokenEncrypted)
            : null,
        cookies: account.cookiesEncrypted ? (0, encryption_1.decrypt)(account.cookiesEncrypted) : null,
        webCookies: account.webCookiesEncrypted ? (0, encryption_1.decrypt)(account.webCookiesEncrypted) : null,
        webUserAgent: account.webUserAgent ?? null,
        transferPin: account.transferPinEncrypted ? (0, encryption_1.decrypt)(account.transferPinEncrypted) : null,
    };
}
//# sourceMappingURL=qris-accounts.service.js.map