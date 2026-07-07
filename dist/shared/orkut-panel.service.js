"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyOrkutMutationDescription = classifyOrkutMutationDescription;
exports.summarizeOrkutAccountBalances = summarizeOrkutAccountBalances;
exports.resolveOrkutAccountIndex = resolveOrkutAccountIndex;
exports.syncOrkutBalanceSnapshot = syncOrkutBalanceSnapshot;
exports.performOrkutSettlementAction = performOrkutSettlementAction;
exports.fetchOrkutTransferBanks = fetchOrkutTransferBanks;
exports.inquireOrkutBankAccount = inquireOrkutBankAccount;
exports.transferOrkutBankFromMadera = transferOrkutBankFromMadera;
const config_1 = require("../config");
const encryption_1 = require("../core/encryption");
const ORKUT_MUTATION_BASE_URL = 'https://orderkuota.com';
function parseAmountValue(value) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.trunc(value);
    if (typeof value === 'string') {
        const cleaned = value.replace(/[^\d-]/g, '').trim();
        if (!cleaned)
            return undefined;
        const parsed = Number.parseInt(cleaned, 10);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function parseBooleanValue(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(normalized))
            return true;
        if (['0', 'false', 'no', 'off'].includes(normalized))
            return false;
    }
    return undefined;
}
function parseObjectBalance(data, keys) {
    if (!data || typeof data !== 'object')
        return undefined;
    const record = data;
    for (const key of keys) {
        const value = parseAmountValue(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function toJsonString(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return '{}';
    }
}
function asRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    return value;
}
function asRecordArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}
function readStringValue(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}
function buildHeaders(cookies, referer, userAgent) {
    return {
        Cookie: cookies,
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json,text/javascript,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
        Referer: referer,
        Origin: new URL(referer).origin,
    };
}
function looksLikeWebCookie(value) {
    return /PHPSESSID=|user_id=|user_key=|cf_clearance=/i.test(value);
}
function parseJsonLike(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return { rawText: trimmed };
    }
}
function readTransferError(payload, fallbackStatus) {
    if (!payload) {
        return fallbackStatus ? `HTTP ${fallbackStatus}` : 'respons kosong dari panel OrderKuota';
    }
    const directMessage = [
        payload.error,
        payload.message,
        payload.msg,
        payload.detail,
    ].find((value) => typeof value === 'string' && value.trim().length > 0);
    if (directMessage)
        return directMessage;
    const rawText = payload.rawText;
    if (typeof rawText === 'string' && rawText.trim().length > 0) {
        return rawText.trim();
    }
    return fallbackStatus ? `HTTP ${fallbackStatus}` : 'request ditolak panel OrderKuota';
}
function parseTransferBankOptions(payload) {
    if (!payload)
        return [];
    const directBanks = asRecordArray(payload.banks);
    const nestedResults = asRecord(payload.results);
    const nestedBanksArray = asRecordArray(nestedResults?.banks);
    const nestedBanksRecord = asRecord(nestedResults?.banks) ?? asRecord(payload.banks);
    const mappedFromRecord = nestedBanksRecord
        ? Object.entries(nestedBanksRecord).map(([code, raw]) => {
            const info = asRecord(raw);
            return {
                code: readStringValue(info?.code) || code,
                fee: parseAmountValue(info?.fee) ?? null,
                name: readStringValue(info?.name) || code,
                status: readStringValue(info?.status) || 'UNKNOWN',
            };
        })
        : [];
    const combined = [...directBanks, ...nestedBanksArray]
        .map((raw) => ({
        code: readStringValue(raw.code) || '',
        fee: parseAmountValue(raw.fee) ?? null,
        name: readStringValue(raw.name) || readStringValue(raw.bank_name) || '',
        status: readStringValue(raw.status) || 'UNKNOWN',
    }))
        .filter((item) => item.code && item.name);
    const deduped = new Map();
    [...combined, ...mappedFromRecord].forEach((item) => {
        if (!item.code || !item.name)
            return;
        deduped.set(item.code, item);
    });
    return [...deduped.values()].sort((left, right) => left.name.localeCompare(right.name));
}
async function postOrkutBankTransfer(account, fallbackIndex, body) {
    const cookies = resolveWebPanelCookie(account);
    if (!cookies) {
        throw new Error('Merchant belum punya Web Session Cookie yang valid untuk settlement panel.');
    }
    const accountIndex = resolveOrkutAccountIndex(account, fallbackIndex);
    const balanceBaseUrl = config_1.config.ORKUT_BALANCE_BASE_URL || ORKUT_MUTATION_BASE_URL;
    const referer = buildMerchantUrl(balanceBaseUrl, 'settlement-orkut');
    const endpoint = buildMerchantUrl(balanceBaseUrl, 'ajax/bank-transfer.php');
    const headers = {
        ...buildHeaders(cookies, referer, account.webUserAgent ?? undefined),
        Accept: '*/*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ account: accountIndex, ...body }),
        signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    return {
        accountIndex,
        payload: parseJsonLike(text),
        status: res.status,
    };
}
function resolveEncryptedCookieSource(account) {
    return account.webCookiesEncrypted ?? account.cookiesEncrypted ?? null;
}
function resolveWebPanelCookie(account) {
    const encryptedCookieSource = resolveEncryptedCookieSource(account);
    if (!encryptedCookieSource)
        return null;
    try {
        const decrypted = (0, encryption_1.decrypt)(encryptedCookieSource);
        return looksLikeWebCookie(decrypted) ? decrypted : null;
    }
    catch {
        return null;
    }
}
function buildMerchantUrl(baseUrl, pathname) {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL(pathname.replace(/^\/+/, ''), normalizedBase).toString();
}
async function fetchJson(url, headers) {
    const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        return null;
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return { rawText: trimmed };
    }
}
function classifyOrkutMutationDescription(description) {
    const text = description.toLowerCase();
    if (text.includes('pindah saldo ke madera')) {
        return 'utama';
    }
    if (text.includes('madera')
        || text.includes('topup madera')
        || text.includes('bi fast out')
        || text.includes('bifast out')
        || text.includes('transfer bi fast')
        || text.includes('biaya transfer bi fast')) {
        return 'madera';
    }
    if (text.includes('pencairan qris')
        || text.includes('pencairan saldo qris')
        || text.includes('biaya percepatan pencairan qris')
        || text.includes('withdraw qris')
        || text.includes('tarik saldo qris')
        || text.includes('pindah saldo ke madera')) {
        return 'utama';
    }
    return 'utama';
}
function summarizeOrkutAccountBalances(accounts) {
    const totals = accounts.reduce((acc, account) => {
        acc.mainBalance += account.lastMainBalance ?? 0;
        acc.qrisBalance += account.lastQrisBalance ?? 0;
        acc.maderaBalance += account.lastMaderaBalance ?? 0;
        if (account.lastBalanceSyncAt) {
            acc.syncedAccounts += 1;
            if (!acc.updatedAt || account.lastBalanceSyncAt > acc.updatedAt) {
                acc.updatedAt = account.lastBalanceSyncAt;
            }
        }
        return acc;
    }, {
        mainBalance: 0,
        qrisBalance: 0,
        maderaBalance: 0,
        syncedAccounts: 0,
        updatedAt: null,
    });
    return {
        totalAccounts: accounts.length,
        syncedAccounts: totals.syncedAccounts,
        mainBalance: totals.mainBalance,
        qrisBalance: totals.qrisBalance,
        maderaBalance: totals.maderaBalance,
        updatedAt: totals.updatedAt ? totals.updatedAt.toISOString() : null,
    };
}
function resolveOrkutAccountIndex(account, fallbackIndex) {
    if (account.orkutAccountIndex && account.orkutAccountIndex > 0) {
        return account.orkutAccountIndex;
    }
    return fallbackIndex;
}
async function syncOrkutBalanceSnapshot(account, fallbackIndex) {
    const cookies = resolveWebPanelCookie(account);
    if (!cookies)
        return null;
    try {
        // keep decrypt failure branch compatible with previous caller expectations
        if (!cookies)
            throw new Error('missing_cookies');
    }
    catch {
        return {
            status: 'error',
            source: 'merged',
            accountIndex: resolveOrkutAccountIndex(account, fallbackIndex),
            rawJson: '{}',
            errorMessage: 'failed_to_decrypt_cookies',
            fetchedAt: new Date().toISOString(),
        };
    }
    const accountIndex = resolveOrkutAccountIndex(account, fallbackIndex);
    const balanceBaseUrl = config_1.config.ORKUT_BALANCE_BASE_URL || ORKUT_MUTATION_BASE_URL;
    const referer = `${balanceBaseUrl}/akun/riwayat-saldo`;
    const headers = buildHeaders(cookies, referer, account.webUserAgent ?? undefined);
    const combinedUrl = `${balanceBaseUrl}/settlement-orkut?action=get_combined&account=${accountIndex}&_=${Date.now()}`;
    const mainUrl = `${balanceBaseUrl}/fetch-main-balance.php`;
    const qrisUrl = `${balanceBaseUrl}/fetch-qris-balance.php`;
    const maderaUrl = `${balanceBaseUrl}/fetch-madera-balance.php`;
    const combined = await fetchJson(combinedUrl, headers);
    const combinedMain = parseObjectBalance(combined, ['balance', 'main_balance', 'total_balance']);
    const combinedQris = parseObjectBalance(combined, ['qris_balance', 'pending_balance']);
    const combinedMadera = parseObjectBalance(combined, ['madera_balance']);
    const combinedWithdrawEnabled = combined
        ? parseBooleanValue(combined.withdraw_enabled)
        : undefined;
    const combinedWithdrawMin = combined
        ? parseAmountValue(combined.withdraw_min)
        : undefined;
    const combinedWithdrawMax = combined
        ? parseAmountValue(combined.withdraw_max)
        : undefined;
    let mainBalance = combinedMain;
    let qrisBalance = combinedQris;
    let maderaBalance = combinedMadera;
    let payloadSource = 'combined';
    let rawPayload = combined;
    if (mainBalance === undefined || qrisBalance === undefined || maderaBalance === undefined) {
        const [mainPayload, qrisPayload, maderaPayload] = await Promise.all([
            fetchJson(mainUrl, headers),
            fetchJson(qrisUrl, headers),
            fetchJson(maderaUrl, headers),
        ]);
        mainBalance ?? (mainBalance = parseObjectBalance(mainPayload, ['total_balance', 'balance', 'main_balance']));
        qrisBalance ?? (qrisBalance = parseObjectBalance(qrisPayload, ['total_balance', 'balance', 'qris_balance', 'pending_balance']));
        maderaBalance ?? (maderaBalance = parseObjectBalance(maderaPayload, ['total_balance', 'balance', 'madera_balance']));
        payloadSource = 'merged';
        rawPayload = { combined, mainPayload, qrisPayload, maderaPayload };
    }
    if (mainBalance === undefined && qrisBalance === undefined && maderaBalance === undefined) {
        return {
            status: 'error',
            source: payloadSource,
            accountIndex,
            rawJson: toJsonString(rawPayload),
            errorMessage: 'no_balance_payload_received',
            fetchedAt: new Date().toISOString(),
        };
    }
    const foundCount = [mainBalance, qrisBalance, maderaBalance].filter((value) => value !== undefined).length;
    return {
        status: foundCount === 3 ? 'synced' : 'partial',
        source: payloadSource,
        accountIndex,
        mainBalance,
        qrisBalance,
        maderaBalance,
        withdrawEnabled: combinedWithdrawEnabled,
        withdrawMin: combinedWithdrawMin,
        withdrawMax: combinedWithdrawMax,
        rawJson: toJsonString(rawPayload),
        fetchedAt: new Date().toISOString(),
    };
}
async function performOrkutSettlementAction(account, fallbackIndex, action, amount) {
    const cookies = resolveWebPanelCookie(account);
    if (!cookies) {
        throw new Error('Merchant belum punya Web Session Cookie yang valid untuk settlement panel.');
    }
    const accountIndex = resolveOrkutAccountIndex(account, fallbackIndex);
    const balanceBaseUrl = config_1.config.ORKUT_BALANCE_BASE_URL || ORKUT_MUTATION_BASE_URL;
    const referer = `${balanceBaseUrl}/settlement-orkut`;
    const headers = {
        ...buildHeaders(cookies, referer, account.webUserAgent ?? undefined),
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const res = await fetch(`${balanceBaseUrl}/settlement-orkut?action=${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ account: accountIndex, amount }),
        signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    const payload = parseJsonLike(text);
    const ok = res.ok && payload && payload.success === true;
    if (!ok) {
        throw new Error(readTransferError(payload, res.status));
    }
    const referenceNo = (typeof payload.reference_no === 'string' && payload.reference_no) ||
        (typeof payload.referenceNo === 'string' && payload.referenceNo) ||
        (typeof payload.ref === 'string' && payload.ref) ||
        null;
    const message = (typeof payload.message === 'string' && payload.message) ||
        (typeof payload.msg === 'string' && payload.msg) ||
        `${action === 'withdraw' ? 'Penarikan QRIS' : 'Topup Madera'} berhasil diproses.`;
    return {
        success: true,
        action,
        accountIndex,
        message,
        referenceNo,
        rawJson: toJsonString(payload),
    };
}
async function fetchOrkutTransferBanks(account, fallbackIndex) {
    const { accountIndex, payload, status } = await postOrkutBankTransfer(account, fallbackIndex, {
        action: 'get_banks',
    });
    const success = parseBooleanValue(payload?.success) === true;
    const banks = parseTransferBankOptions(payload);
    const message = readStringValue(payload?.message) || readStringValue(payload?.msg) || null;
    if (!success && banks.length === 0) {
        throw new Error(readTransferError(payload, status));
    }
    return {
        accountIndex,
        banks,
        message,
        rawJson: toJsonString(payload),
        success: success || banks.length > 0,
    };
}
async function inquireOrkutBankAccount(account, fallbackIndex, params) {
    const { accountIndex, payload, status } = await postOrkutBankTransfer(account, fallbackIndex, {
        action: 'inquiry',
        account_number: params.accountNumber,
        amount: params.amount,
        bank_code: params.bankCode,
    });
    const success = parseBooleanValue(payload?.success) === true;
    const results = asRecord(payload?.results);
    const accountName = readStringValue(payload?.account_name)
        || readStringValue(results?.account_name)
        || readStringValue(results?.name)
        || null;
    const accountNumber = readStringValue(payload?.account_number)
        || readStringValue(results?.account_number)
        || params.accountNumber;
    const bankCode = readStringValue(payload?.bank_code)
        || readStringValue(results?.bank_code)
        || params.bankCode;
    const bankName = readStringValue(payload?.bank_name)
        || readStringValue(results?.bank_name)
        || bankCode;
    const sessionId = readStringValue(payload?.session_id)
        || readStringValue(results?.session_id)
        || null;
    const fee = parseAmountValue(payload?.fee)
        ?? parseAmountValue(results?.fee)
        ?? null;
    const message = readStringValue(payload?.message)
        || readStringValue(payload?.msg)
        || readStringValue(payload?.error)
        || readStringValue(results?.message)
        || null;
    if (!success) {
        throw new Error(readTransferError(payload, status));
    }
    return {
        accountIndex,
        accountName,
        accountNumber,
        bankCode,
        bankName,
        fee,
        message,
        rawJson: toJsonString(payload),
        sessionId,
        success,
    };
}
async function transferOrkutBankFromMadera(account, fallbackIndex, params) {
    const body = {
        action: 'transfer',
        account_name: params.accountName,
        account_number: params.accountNumber,
        amount: params.amount,
        bank_code: params.bankCode,
        bank_name: params.bankName || params.bankCode,
    };
    if (params.sessionId)
        body.session_id = params.sessionId;
    if (params.widgetMerchantId !== undefined && params.widgetMerchantId !== null) {
        body.widget_merchant_id = params.widgetMerchantId;
    }
    const { accountIndex, payload, status } = await postOrkutBankTransfer(account, fallbackIndex, body);
    const success = parseBooleanValue(payload?.success) === true;
    const results = asRecord(payload?.results);
    const redirectUrl = readStringValue(payload?.redirect_url)
        || readStringValue(results?.redirect_url)
        || null;
    const referenceNo = readStringValue(payload?.reference_no)
        || readStringValue(payload?.referenceNo)
        || readStringValue(payload?.ref)
        || readStringValue(payload?.id)
        || readStringValue(results?.reference_no)
        || readStringValue(results?.referenceNo)
        || readStringValue(results?.ref)
        || readStringValue(results?.id)
        || null;
    const fee = parseAmountValue(payload?.fee)
        ?? parseAmountValue(results?.fee)
        ?? null;
    const message = readStringValue(payload?.message)
        || readStringValue(payload?.msg)
        || readStringValue(payload?.error)
        || readStringValue(results?.message)
        || null;
    if (!success) {
        return {
            accountIndex,
            accountName: params.accountName,
            accountNumber: params.accountNumber,
            bankCode: params.bankCode,
            bankName: params.bankName || params.bankCode,
            fee,
            message: message || readTransferError(payload, status),
            rawJson: toJsonString(payload),
            redirectUrl,
            referenceNo,
            status: 'failed',
            success: false,
        };
    }
    return {
        accountIndex,
        accountName: params.accountName,
        accountNumber: params.accountNumber,
        bankCode: readStringValue(payload?.bank_code) || readStringValue(results?.bank_code) || params.bankCode,
        bankName: readStringValue(payload?.bank_name) || readStringValue(results?.bank_name) || params.bankName || params.bankCode,
        fee,
        message: message || 'Transfer bank berhasil diproses.',
        rawJson: toJsonString(payload),
        redirectUrl,
        referenceNo,
        status: redirectUrl ? 'processing' : 'done',
        success: true,
    };
}
//# sourceMappingURL=orkut-panel.service.js.map