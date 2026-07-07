"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testReportLogin = testReportLogin;
exports.compareReportVsLiveSources = compareReportVsLiveSources;
exports.testMerchantConnection = testMerchantConnection;
exports.syncMerchantNow = syncMerchantNow;
exports.getSyncAllStatus = getSyncAllStatus;
exports.startSyncAllMerchants = startSyncAllMerchants;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const encryption_1 = require("../../core/encryption");
const app_orkut_gateway_1 = require("../../shared/gateways/app-orkut.gateway");
const orkut_app_detail_service_1 = require("../../shared/orkut-app-detail.service");
const orkut_panel_service_1 = require("../../shared/orkut-panel.service");
const mutation_ingest_service_1 = require("../../shared/mutation-ingest.service");
const mutation_matcher_service_1 = require("../../shared/mutation-matcher.service");
const orderkuota_report_python_service_1 = require("../../shared/orderkuota-report-python.service");
const qris_accounts_service_1 = require("../qris-accounts/qris-accounts.service");
const merchantSyncInFlight = new Map();
function explainReportAccessError(err) {
    const detail = err instanceof Error ? err.message : 'Gagal mengakses report.';
    if (/spawn\s+\S*python\S*\s+ENOENT/i.test(detail) || /\bENOENT\b/i.test(detail)) {
        return 'Python scraper report belum ditemukan di server. Gunakan python3 atau isi PYTHON_BIN/PYTHON_EXECUTABLE.';
    }
    if (/HTTP\s*469/i.test(detail) || /Gunakan Jaringan Internet Lainnya/i.test(detail)) {
        return 'Report OrderKuota menolak jaringan VPS ini (469: Gunakan Jaringan Internet Lainnya). Biasanya butuh IP/jaringan lain atau cookie + user-agent yang masih fresh.';
    }
    return detail;
}
function buildReadiness(account) {
    const hasSessionToken = !!account.sessionTokenEncrypted;
    const hasCookies = !!account.cookiesEncrypted;
    const hasWebCookies = !!account.webCookiesEncrypted;
    const hasDeviceId = !!account.deviceId;
    const hasPayload = !!account.qrisPayload;
    return {
        hasSessionToken,
        hasCookies,
        hasWebCookies,
        hasDeviceId,
        hasPayload,
        generateReady: account.status === 'active' && (hasSessionToken || hasPayload),
        mutationReady: account.status === 'active' && (hasSessionToken || hasCookies || hasWebCookies),
    };
}
async function getAccountOrThrow(id) {
    const account = await database_1.db.qrisAccount.findUnique({ where: { id } });
    if (!account) {
        throw new Error('Merchant QR tidak ditemukan.');
    }
    return account;
}
function baseReport(account) {
    return {
        account: {
            id: account.id,
            code: account.code,
            merchantName: account.merchantName,
            accountNumber: account.accountNumber,
            status: account.status,
        },
        readiness: buildReadiness(account),
    };
}
async function updateHealthStatus(accountId, checks) {
    const successCount = checks.filter((check) => check.ok).length;
    const hasTemporaryRateLimit = checks.some((check) => /rate limit|membatasi akses qris|469/i.test(check.detail));
    const nextStatus = successCount >= 2 ? 'healthy'
        : successCount >= 1 ? 'degraded'
            : hasTemporaryRateLimit ? 'degraded'
                : 'down';
    await database_1.db.qrisAccount.update({
        where: { id: accountId },
        data: { healthStatus: nextStatus },
    });
    return nextStatus;
}
async function storeConnectionTestSnapshot(accountId, checks) {
    const failedChecks = checks.filter((check) => !check.ok);
    await database_1.db.qrisAccount.update({
        where: { id: accountId },
        data: {
            lastConnectionTestAt: new Date(),
            lastConnectionTestStatus: failedChecks.length === 0 ? 'success' : checks.some((check) => check.ok) ? 'partial' : 'failed',
            lastConnectionTestError: failedChecks.length > 0 ? failedChecks.map((check) => `${check.label}: ${check.detail}`).join(' | ') : null,
        },
    });
}
async function upsertLivePayload(account) {
    if (!account.sessionTokenEncrypted) {
        return { refreshed: false, expired: null };
    }
    const terms = await app_orkut_gateway_1.appGateway.fetchQrisMerchantTerms(account);
    if (!terms?.qrisData) {
        return { refreshed: false, expired: null };
    }
    if (account.qrisPayload !== terms.qrisData) {
        await database_1.db.qrisAccount.update({
            where: { id: account.id },
            data: { qrisPayload: terms.qrisData },
        });
    }
    return { refreshed: true, expired: terms.expired ?? null };
}
async function ingestMutationBatch(accountId, mutations, walletCategoryOverride) {
    const created = [];
    for (const mutation of mutations) {
        const result = await (0, mutation_ingest_service_1.storeMutationIfNew)({
            qrisAccountId: accountId,
            amount: mutation.amount,
            type: mutation.type,
            balanceBefore: mutation.balanceBefore,
            balanceAfter: mutation.balanceAfter,
            issuerName: mutation.issuerName ?? null,
            rrn: mutation.rrn ?? null,
            walletCategory: walletCategoryOverride ?? mutation.walletCategory ?? null,
            transactionTime: mutation.transactionTime,
            rawHash: mutation.rawHash,
            rawDataJson: mutation.rawDataJson,
        });
        if (result.created) {
            created.push(result.mutation);
        }
    }
    return created;
}
async function enrichRecentMutationDetails(account, candidates) {
    if (!account.sessionTokenEncrypted)
        return [];
    const detailTargets = candidates
        .filter((mutation) => mutation.type === 'credit')
        .map((mutation) => ({
        mutation,
        rawId: (0, orkut_app_detail_service_1.readPresentedMutationRawId)(mutation.rawDataJson),
    }))
        .filter((item) => item.rawId)
        .slice(0, 6);
    const updated = [];
    for (const item of detailTargets) {
        const detail = await app_orkut_gateway_1.appGateway.fetchQrisMutationDetail(account, item.rawId).catch((err) => {
            if (err instanceof app_orkut_gateway_1.AppOrkutRateLimitError)
                throw err;
            logger_1.logger.warn({ err, accountCode: account.code, mutationId: item.mutation.id }, 'merchant-qr sync: failed to enrich mutation detail');
            return null;
        });
        if (!detail)
            continue;
        const issuerName = [detail.brandName, detail.senderName?.split('/')[0]?.trim()]
            .filter(Boolean)
            .join(' / ') || item.mutation.issuerName;
        const updatedMutation = await database_1.db.mutation.update({
            where: { id: item.mutation.id },
            data: {
                issuerName: issuerName ?? undefined,
                rawDataJson: (0, orkut_app_detail_service_1.mergeRawMutationWithAppDetail)(item.mutation.rawDataJson, detail),
                rrn: detail.rrn ?? undefined,
            },
        });
        await (0, mutation_ingest_service_1.publishMutationUpdated)(updatedMutation, 'detail_enriched');
        updated.push(updatedMutation);
    }
    return updated;
}
async function matchMutationCandidates(candidates) {
    let matchedTransactions = 0;
    for (const mutation of candidates) {
        if (mutation.type !== 'credit')
            continue;
        const result = await (0, mutation_matcher_service_1.tryMatchMutation)(mutation);
        if (result.matched)
            matchedTransactions += 1;
    }
    return matchedTransactions;
}
async function buildWebFallbackIndex(account) {
    const activeAccounts = await database_1.db.qrisAccount.findMany({
        where: { status: 'active' },
        orderBy: { code: 'asc' },
        select: { id: true },
    });
    const fallbackIndex = activeAccounts.findIndex((item) => item.id === account.id) + 1;
    return fallbackIndex > 0 ? fallbackIndex : 1;
}
function buildReportBadges(result) {
    return [
        {
            key: 'qris',
            label: 'QRIS OK',
            ok: result.qris.count > 0 || typeof result.qris.balance === 'number',
            detail: result.qris.count > 0
                ? `${result.qris.count} baris terbaca dari report QRIS.`
                : 'Belum ada baris QRIS yang terbaca.',
        },
        {
            key: 'utama',
            label: 'Utama OK',
            ok: result.utama.count > 0 || typeof result.utama.balance === 'number',
            detail: result.utama.count > 0
                ? `${result.utama.count} baris terbaca dari report utama.`
                : 'Belum ada baris mutasi utama yang terbaca.',
        },
        {
            key: 'session',
            label: 'Session Expired: No',
            ok: true,
            detail: 'Cookie masih valid dan belum terlihat expired.',
        },
        {
            key: 'cookie',
            label: 'Cookie Missing: No',
            ok: true,
            detail: 'Cookie report tersedia.',
        },
    ];
}
async function testReportLogin(input) {
    const normalizedCookie = (0, qris_accounts_service_1.normalizeCookieInput)(input.rawHeaders) || (0, qris_accounts_service_1.normalizeCookieInput)(input.webCookies);
    const normalizedUserAgent = (0, qris_accounts_service_1.normalizeUserAgentInput)(input.webUserAgent) || (0, qris_accounts_service_1.normalizeUserAgentInput)(input.rawHeaders);
    if (!normalizedCookie) {
        return {
            success: false,
            message: 'Cookie report belum ditemukan. Paste header mentah atau isi Web Session Cookie.',
            normalized: {
                cookie: null,
                userAgent: normalizedUserAgent,
            },
            badges: [
                {
                    key: 'cookie',
                    label: 'Cookie Missing',
                    ok: false,
                    detail: 'Field cookie masih kosong atau tidak bisa diparse.',
                },
            ],
            preview: {
                accountName: null,
                mainBalance: null,
                qrisBalance: null,
                qrisCount: 0,
                utamaCount: 0,
                qrisPagesRead: null,
                utamaPagesRead: null,
            },
            detectedPattern: {
                qris: null,
                utama: null,
            },
        };
    }
    try {
        const result = await (0, orderkuota_report_python_service_1.probeMerchantMutationsFromRawReportInput)({
            cookie: normalizedCookie,
            userAgent: normalizedUserAgent,
            target: 'both',
        });
        const accountName = result.qris.meta?.accountName || result.utama.meta?.accountName || null;
        return {
            success: true,
            message: 'Login report valid. QRIS dan mutasi utama bisa diakses.',
            normalized: {
                cookie: normalizedCookie,
                userAgent: normalizedUserAgent,
            },
            badges: buildReportBadges(result),
            preview: {
                accountName,
                mainBalance: result.utama.balance,
                qrisBalance: result.qris.balance,
                qrisCount: result.qris.count,
                utamaCount: result.utama.count,
                qrisPagesRead: result.qris.meta?.pagesRead ?? null,
                utamaPagesRead: result.utama.meta?.pagesRead ?? null,
            },
            detectedPattern: {
                qris: result.qris.meta?.detectedPattern ?? null,
                utama: result.utama.meta?.detectedPattern ?? null,
            },
        };
    }
    catch (err) {
        const detail = explainReportAccessError(err);
        const expired = /403|401|login|expired|csrf|forbidden|unauthorized/i.test(detail);
        return {
            success: false,
            message: detail,
            normalized: {
                cookie: normalizedCookie,
                userAgent: normalizedUserAgent,
            },
            badges: [
                {
                    key: 'qris',
                    label: 'QRIS OK',
                    ok: false,
                    detail: 'Report QRIS belum bisa dibaca.',
                },
                {
                    key: 'utama',
                    label: 'Utama OK',
                    ok: false,
                    detail: 'Report utama belum bisa dibaca.',
                },
                {
                    key: 'session',
                    label: `Session Expired: ${expired ? 'Yes' : 'No'}`,
                    ok: !expired,
                    detail: expired ? 'Cookie kemungkinan sudah expired atau logout.' : 'Tidak ada indikasi session expired.',
                },
                {
                    key: 'cookie',
                    label: 'Cookie Missing: No',
                    ok: true,
                    detail: 'Cookie sudah terdeteksi, tetapi akses report gagal.',
                },
            ],
            preview: {
                accountName: null,
                mainBalance: null,
                qrisBalance: null,
                qrisCount: 0,
                utamaCount: 0,
                qrisPagesRead: null,
                utamaPagesRead: null,
            },
            detectedPattern: {
                qris: null,
                utama: null,
            },
        };
    }
}
async function compareReportVsLiveSources(input) {
    const normalizedCookie = (0, qris_accounts_service_1.normalizeCookieInput)(input.rawHeaders) || (0, qris_accounts_service_1.normalizeCookieInput)(input.webCookies);
    const normalizedUserAgent = (0, qris_accounts_service_1.normalizeUserAgentInput)(input.webUserAgent) || (0, qris_accounts_service_1.normalizeUserAgentInput)(input.rawHeaders);
    const sessionToken = input.sessionToken?.trim() || '';
    const appRegId = input.cookies?.trim() || '';
    const deviceId = input.deviceId?.trim() || '';
    const mode = normalizedCookie && sessionToken ? 'hybrid'
        : sessionToken ? 'app'
            : normalizedCookie ? 'web'
                : 'unconfigured';
    const reportPart = {
        ok: false,
        accountName: null,
        mainBalance: null,
        qrisBalance: null,
        qrisCount: 0,
        utamaCount: 0,
        qrisPagesRead: null,
        utamaPagesRead: null,
        detectedPattern: {
            qris: null,
            utama: null,
        },
    };
    const livePart = {
        ok: false,
        mainBalance: null,
        qrisBalance: null,
        qrisCount: 0,
        utamaCount: 0,
    };
    if (normalizedCookie) {
        try {
            const result = await (0, orderkuota_report_python_service_1.probeMerchantMutationsFromRawReportInput)({
                cookie: normalizedCookie,
                userAgent: normalizedUserAgent,
                target: 'both',
            });
            reportPart.ok = true;
            reportPart.accountName = result.qris.meta?.accountName || result.utama.meta?.accountName || null;
            reportPart.mainBalance = result.utama.balance;
            reportPart.qrisBalance = result.qris.balance;
            reportPart.qrisCount = result.qris.count;
            reportPart.utamaCount = result.utama.count;
            reportPart.qrisPagesRead = result.qris.meta?.pagesRead ?? null;
            reportPart.utamaPagesRead = result.utama.meta?.pagesRead ?? null;
            reportPart.detectedPattern = {
                qris: result.qris.meta?.detectedPattern ?? null,
                utama: result.utama.meta?.detectedPattern ?? null,
            };
        }
        catch (err) {
            logger_1.logger.warn({ err }, 'compareReportVsLiveSources: report probe failed');
        }
    }
    if (sessionToken) {
        try {
            const tempAccount = {
                code: 'FORM_COMPARE',
                sessionTokenEncrypted: (0, encryption_1.encrypt)(sessionToken),
                cookiesEncrypted: appRegId ? (0, encryption_1.encrypt)(appRegId) : null,
                deviceId: deviceId || null,
            };
            const [qrisResult, utamaResult] = await Promise.all([
                app_orkut_gateway_1.appGateway.fetchMutationsAndBalance(tempAccount, { maxPages: 3 }),
                app_orkut_gateway_1.appGateway.fetchBalanceHistory(tempAccount),
            ]);
            livePart.ok = true;
            livePart.mainBalance = qrisResult.balance.mainBalance ?? utamaResult.mainBalance ?? null;
            livePart.qrisBalance = qrisResult.balance.qrisBalance ?? null;
            livePart.qrisCount = qrisResult.mutations.length;
            livePart.utamaCount = utamaResult.mutations.length;
        }
        catch (err) {
            logger_1.logger.warn({ err }, 'compareReportVsLiveSources: live app probe failed');
        }
    }
    const delta = {
        mainBalanceDiff: reportPart.mainBalance != null && livePart.mainBalance != null
            ? reportPart.mainBalance - livePart.mainBalance
            : null,
        qrisBalanceDiff: reportPart.qrisBalance != null && livePart.qrisBalance != null
            ? reportPart.qrisBalance - livePart.qrisBalance
            : null,
        qrisCountDiff: reportPart.ok && livePart.ok ? reportPart.qrisCount - livePart.qrisCount : null,
        utamaCountDiff: reportPart.ok && livePart.ok ? reportPart.utamaCount - livePart.utamaCount : null,
    };
    const success = reportPart.ok || livePart.ok;
    const message = reportPart.ok && livePart.ok
        ? 'Perbandingan report scraper dan live app API berhasil dibaca.'
        : reportPart.ok
            ? 'Hanya report scraper yang berhasil dibaca. Live app API belum siap.'
            : livePart.ok
                ? 'Hanya live app API yang berhasil dibaca. Report scraper belum siap.'
                : 'Kedua sumber belum berhasil dibaca dari input form saat ini.';
    return {
        success,
        message,
        mode,
        report: reportPart,
        live: livePart,
        delta,
    };
}
async function testMerchantConnection(id) {
    const account = await getAccountOrThrow(id);
    const reportBase = baseReport(account);
    const checks = [];
    if (account.status !== 'active') {
        checks.push({
            ok: false,
            label: 'Status Merchant',
            detail: 'Merchant sedang nonaktif.',
        });
    }
    if (account.sessionTokenEncrypted) {
        try {
            const balance = await app_orkut_gateway_1.appGateway.fetchAccountSummary(account);
            checks.push({
                ok: true,
                label: 'Koneksi App API',
                detail: `Saldo utama terbaca${typeof balance.mainBalance === 'number' ? ` Rp ${balance.mainBalance.toLocaleString('id-ID')}` : ''}` +
                    `${typeof balance.qrisBalance === 'number' ? `, saldo QRIS Rp ${balance.qrisBalance.toLocaleString('id-ID')}` : ''}.`,
            });
        }
        catch (err) {
            if (err instanceof app_orkut_gateway_1.AppOrkutRateLimitError) {
                checks.push({
                    ok: false,
                    label: 'Koneksi App API',
                    detail: 'OrderKuota sedang rate limit 5 menit. Tunggu sebentar lalu tes lagi.',
                });
            }
            else {
                checks.push({
                    ok: false,
                    label: 'Koneksi App API',
                    detail: err instanceof Error ? err.message : 'Gagal membaca app API.',
                });
            }
        }
        try {
            const payload = await upsertLivePayload(account);
            checks.push({
                ok: payload.refreshed,
                label: 'Template QRIS',
                detail: payload.refreshed
                    ? `Payload QRIS valid${payload.expired ? `, masa berlaku live ${payload.expired} detik.` : '.'}`
                    : 'Payload live belum berhasil dibaca saat ini.',
            });
        }
        catch (err) {
            if (err instanceof app_orkut_gateway_1.AppOrkutRateLimitError) {
                checks.push({
                    ok: false,
                    label: 'Template QRIS',
                    detail: 'Pembacaan payload ditahan provider sementara (469).',
                });
            }
            else {
                checks.push({
                    ok: false,
                    label: 'Template QRIS',
                    detail: err instanceof Error ? err.message : 'Gagal membaca payload QRIS.',
                });
            }
        }
    }
    if (account.webCookiesEncrypted || (!account.sessionTokenEncrypted && account.cookiesEncrypted)) {
        try {
            const reportProbe = await (0, orderkuota_report_python_service_1.probeMerchantMutationsFromReport)(account, 'qris');
            checks.push({
                ok: true,
                label: 'Koneksi Report Web',
                detail: `Report OrderKuota aktif, ${reportProbe.qris.count} baris mutasi QRIS terbaca.`,
            });
        }
        catch (err) {
            checks.push({
                ok: false,
                label: 'Koneksi Report Web',
                detail: explainReportAccessError(err),
            });
        }
    }
    if (!account.sessionTokenEncrypted && !account.cookiesEncrypted && !account.webCookiesEncrypted) {
        checks.push({
            ok: false,
            label: 'Kredensial',
            detail: 'Session token atau cookie belum diisi.',
        });
    }
    if (account.qrisPayload) {
        checks.push({
            ok: true,
            label: 'Generate QR',
            detail: 'Payload QRIS tersimpan dan siap dipakai sebagai fallback generate.',
        });
    }
    else {
        checks.push({
            ok: false,
            label: 'Generate QR',
            detail: 'Payload QRIS belum ada. Generate tetap bisa jika token live berhasil.',
        });
    }
    await updateHealthStatus(account.id, checks);
    await storeConnectionTestSnapshot(account.id, checks);
    const successCount = checks.filter((check) => check.ok).length;
    const mode = account.webCookiesEncrypted ? 'web'
        : account.sessionTokenEncrypted ? 'app'
            : account.cookiesEncrypted ? 'web'
                : account.qrisPayload ? 'payload-only'
                    : 'unconfigured';
    return {
        ...reportBase,
        success: successCount > 0,
        mode,
        checks,
        message: successCount === checks.length
            ? 'Semua pemeriksaan merchant berhasil.'
            : successCount > 0
                ? 'Sebagian koneksi merchant berhasil. Ada beberapa bagian yang masih perlu perhatian.'
                : 'Pemeriksaan merchant gagal. Cek lagi token, device, atau cookie.',
    };
}
async function syncMerchantNow(id) {
    const existing = merchantSyncInFlight.get(id);
    if (existing)
        return existing;
    const promise = (async () => {
        const account = await getAccountOrThrow(id);
        if (account.status !== 'active') {
            throw new Error('Merchant sedang nonaktif. Aktifkan dulu sebelum sinkron manual.');
        }
        const reportBase = baseReport(account);
        const checks = [];
        let newQrisMutations = 0;
        let newUtamaMutations = 0;
        let detailRefreshed = 0;
        let matchedTransactions = 0;
        let mainBalance = account.lastMainBalance ?? null;
        let qrisBalance = account.lastQrisBalance ?? null;
        let maderaBalance = account.lastMaderaBalance ?? null;
        let payloadRefreshed = false;
        let syncPartial = false;
        const partialReasons = [];
        const resolvedMode = account.webCookiesEncrypted ? 'web'
            : account.sessionTokenEncrypted ? 'app'
                : account.cookiesEncrypted ? 'web'
                    : 'unconfigured';
        try {
            if (account.webCookiesEncrypted || (!account.sessionTokenEncrypted && account.cookiesEncrypted)) {
                const reportStats = await (0, orderkuota_report_python_service_1.syncMerchantMutationsFromReport)(account, 'both');
                newQrisMutations = reportStats.newQrisMutations;
                newUtamaMutations = reportStats.newUtamaMutations;
                mainBalance = reportStats.mainBalance ?? mainBalance;
                qrisBalance = reportStats.qrisBalance ?? qrisBalance;
                checks.push({
                    ok: true,
                    label: 'Mutasi Report',
                    detail: `${newQrisMutations} mutasi QRIS baru dan ${newUtamaMutations} mutasi utama baru masuk dari report.orderkuota.com.`,
                });
                if (account.sessionTokenEncrypted) {
                    const payloadState = await upsertLivePayload(account);
                    payloadRefreshed = payloadState.refreshed;
                }
                const fallbackIndex = await buildWebFallbackIndex(account);
                const balanceSnapshot = await (0, orkut_panel_service_1.syncOrkutBalanceSnapshot)(account, fallbackIndex);
                if (balanceSnapshot) {
                    qrisBalance = balanceSnapshot.qrisBalance ?? qrisBalance;
                    maderaBalance = balanceSnapshot.maderaBalance ?? maderaBalance;
                }
                checks.push({
                    ok: true,
                    label: 'Saldo & Payload',
                    detail: `Saldo utama${typeof mainBalance === 'number' ? ` Rp ${mainBalance.toLocaleString('id-ID')}` : ''}${payloadRefreshed ? ', payload QRIS juga diperbarui.' : '.'}`,
                });
            }
            else if (account.sessionTokenEncrypted) {
                let createdQris = [];
                const recentKnownQris = await database_1.db.mutation.findMany({
                    where: {
                        qrisAccountId: account.id,
                        walletCategory: 'qris',
                    },
                    orderBy: { transactionTime: 'desc' },
                    take: 40,
                    select: { rawHash: true, transactionTime: true },
                });
                const latestKnownTime = recentKnownQris[0]?.transactionTime ?? null;
                const qrisResult = await app_orkut_gateway_1.appGateway.fetchIncrementalMutationsAndBalance(account, {
                    knownRawHashes: recentKnownQris.map((row) => row.rawHash),
                    fromTime: latestKnownTime ? new Date(latestKnownTime.getTime() - 120000) : null,
                    maxPages: 3,
                });
                createdQris = await ingestMutationBatch(account.id, qrisResult.mutations, 'qris');
                newQrisMutations = createdQris.length;
                const qrisLaneOk = qrisResult.balance.mainBalance !== null || qrisResult.balance.qrisBalance !== null;
                mainBalance = qrisResult.balance.mainBalance ?? mainBalance;
                qrisBalance = qrisResult.balance.qrisBalance ?? qrisBalance;
                await database_1.db.qrisAccount.update({
                    where: { id: account.id },
                    data: {
                        lastMainBalance: mainBalance,
                        lastQrisBalance: qrisBalance,
                        lastBalanceSyncAt: new Date(),
                        lastBalanceSyncStatus: qrisLaneOk ? 'synced' : 'partial',
                        lastBalanceSyncError: qrisLaneOk ? null : 'Provider belum mengirim data QRIS saat sinkron manual. Biasanya ini tanda 469 / rate limit sementara.',
                        lastBalanceSyncRawJson: JSON.stringify(qrisResult.balance),
                    },
                });
                if (!qrisLaneOk) {
                    syncPartial = true;
                    partialReasons.push('Provider belum mengirim data QRIS baru saat sinkron manual.');
                }
                checks.push({
                    ok: qrisLaneOk,
                    label: 'Mutasi QRIS',
                    detail: qrisLaneOk
                        ? `${newQrisMutations} mutasi baru masuk dari app OrderKuota.`
                        : 'Jalur mutasi QRIS sedang belum memberi data. Biasanya ini karena provider menahan akses sementara (469).',
                });
                const balanceResult = await app_orkut_gateway_1.appGateway.fetchBalanceHistory(account);
                const createdUtama = await ingestMutationBatch(account.id, balanceResult.mutations);
                newUtamaMutations = createdUtama.length;
                mainBalance = balanceResult.mainBalance ?? mainBalance;
                await database_1.db.qrisAccount.update({
                    where: { id: account.id },
                    data: {
                        lastMainBalance: mainBalance,
                        lastBalanceSyncAt: new Date(),
                        lastBalanceSyncStatus: syncPartial ? 'partial' : 'synced',
                        lastBalanceSyncError: syncPartial ? partialReasons.join(' ') : null,
                    },
                });
                const payloadState = await upsertLivePayload(account);
                payloadRefreshed = payloadState.refreshed;
                checks.push({
                    ok: true,
                    label: 'Saldo & Payload',
                    detail: `Saldo utama${typeof mainBalance === 'number' ? ` Rp ${mainBalance.toLocaleString('id-ID')}` : ''}${payloadRefreshed ? ', payload QRIS juga diperbarui.' : '.'}`,
                });
                const enriched = await enrichRecentMutationDetails(account, createdQris);
                detailRefreshed = enriched.length;
                matchedTransactions = await matchMutationCandidates(createdQris.map((mutation) => enriched.find((item) => item.id === mutation.id) ?? mutation));
            }
            else {
                throw new Error('Merchant belum punya session token atau cookie untuk sinkron manual.');
            }
            await updateHealthStatus(account.id, checks);
            return {
                ...reportBase,
                success: !syncPartial,
                mode: resolvedMode,
                checks,
                message: syncPartial
                    ? `Sinkron manual berjalan, tetapi belum sepenuhnya lengkap. ${partialReasons.join(' ')}`
                    : 'Sinkron manual berhasil dijalankan.',
                stats: {
                    newQrisMutations,
                    newUtamaMutations,
                    detailRefreshed,
                    matchedTransactions,
                    mainBalance,
                    qrisBalance,
                    maderaBalance,
                    payloadRefreshed,
                },
            };
        }
        catch (err) {
            const detail = err instanceof app_orkut_gateway_1.AppOrkutRateLimitError
                ? 'Provider sedang membatasi akses QRIS selama 5 menit.'
                : err instanceof Error
                    ? err.message
                    : 'Sinkron manual gagal.';
            checks.push({
                ok: false,
                label: 'Sinkron Manual',
                detail,
            });
            await database_1.db.qrisAccount.update({
                where: { id: account.id },
                data: {
                    lastBalanceSyncAt: new Date(),
                    lastBalanceSyncStatus: err instanceof app_orkut_gateway_1.AppOrkutRateLimitError ? 'rate_limited' : 'error',
                    lastBalanceSyncError: detail,
                },
            }).catch(() => undefined);
            await updateHealthStatus(account.id, checks).catch(() => undefined);
            logger_1.logger.error({ err, accountCode: account.code }, 'merchant-qr sync now failed');
            return {
                ...reportBase,
                success: false,
                mode: resolvedMode,
                checks,
                message: detail,
                stats: {
                    newQrisMutations,
                    newUtamaMutations,
                    detailRefreshed,
                    matchedTransactions,
                    mainBalance,
                    qrisBalance,
                    maderaBalance,
                    payloadRefreshed,
                },
            };
        }
    })();
    merchantSyncInFlight.set(id, promise);
    promise.finally(() => {
        if (merchantSyncInFlight.get(id) === promise) {
            merchantSyncInFlight.delete(id);
        }
    }).catch(() => undefined);
    return promise;
}
// ── Sinkron ALL (bulk): gate cooldown 60s + status utk freeze live ──────────
const SYNC_ALL_COOLDOWN_MS = 60000;
let syncAllState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    nextAllowedAt: 0,
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    lastError: null,
};
function getSyncAllStatus() {
    const now = Date.now();
    return {
        running: syncAllState.running,
        startedAt: syncAllState.startedAt,
        finishedAt: syncAllState.finishedAt,
        total: syncAllState.total,
        done: syncAllState.done,
        ok: syncAllState.ok,
        failed: syncAllState.failed,
        lastError: syncAllState.lastError,
        nextAllowedAt: syncAllState.nextAllowedAt,
        remainingMs: Math.max(0, syncAllState.nextAllowedAt - now),
    };
}
function startSyncAllMerchants() {
    const now = Date.now();
    if (syncAllState.running) {
        return {
            blocked: 'running',
            running: true,
            nextAllowedAt: syncAllState.nextAllowedAt,
            remainingMs: Math.max(0, syncAllState.nextAllowedAt - now),
        };
    }
    if (now < syncAllState.nextAllowedAt) {
        return {
            blocked: 'cooldown',
            running: false,
            nextAllowedAt: syncAllState.nextAllowedAt,
            remainingMs: syncAllState.nextAllowedAt - now,
        };
    }
    syncAllState = {
        running: true,
        startedAt: now,
        finishedAt: null,
        nextAllowedAt: now + SYNC_ALL_COOLDOWN_MS,
        total: 0,
        done: 0,
        ok: 0,
        failed: 0,
        lastError: null,
    };
    void (async () => {
        try {
            const accounts = await database_1.db.qrisAccount.findMany({
                where: { status: 'active', sessionTokenEncrypted: { not: null } },
                select: { id: true, code: true },
                orderBy: { code: 'asc' },
            });
            syncAllState.total = accounts.length;
            for (const acc of accounts) {
                try {
                    await syncMerchantNow(acc.id);
                    syncAllState.ok += 1;
                }
                catch (err) {
                    syncAllState.failed += 1;
                    syncAllState.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
                    logger_1.logger.warn({ err, accountCode: acc.code }, 'syncAll: 1 merchant gagal');
                }
                syncAllState.done += 1;
            }
        }
        catch (err) {
            syncAllState.lastError = err instanceof Error ? err.message : String(err);
            logger_1.logger.error({ err }, 'startSyncAllMerchants loop error');
        }
        finally {
            syncAllState.running = false;
            syncAllState.finishedAt = Date.now();
            syncAllState.nextAllowedAt = Date.now() + SYNC_ALL_COOLDOWN_MS;
        }
    })();
    return {
        blocked: false,
        running: true,
        nextAllowedAt: syncAllState.nextAllowedAt,
        remainingMs: SYNC_ALL_COOLDOWN_MS,
    };
}
//# sourceMappingURL=merchant-qr-sync.service.js.map