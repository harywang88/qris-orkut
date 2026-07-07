"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeMerchantMutationsFromReport = probeMerchantMutationsFromReport;
exports.probeMerchantMutationsFromRawReportInput = probeMerchantMutationsFromRawReportInput;
exports.syncMerchantMutationsFromReport = syncMerchantMutationsFromReport;
exports.syncMerchantMutationsFromReportIfStale = syncMerchantMutationsFromReportIfStale;
const child_process_1 = require("child_process");
const database_1 = require("../config/database");
const logger_1 = require("../config/logger");
const encryption_1 = require("../core/encryption");
const mutation_ingest_service_1 = require("./mutation-ingest.service");
const reportSyncInFlight = new Map();
const reportSyncLastRunAt = new Map();
const DEFAULT_REPORT_SYNC_MAX_AGE_MS = 15000;
function getPythonBinCandidates() {
    const explicit = [
        process.env.PYTHON_BIN?.trim(),
        process.env.PYTHON_EXECUTABLE?.trim(),
    ].filter((value) => !!value);
    if (explicit.length > 0) {
        return [...new Set(explicit)];
    }
    return process.platform === 'win32'
        ? ['python', 'py']
        : ['python3', 'python'];
}
function getCookieSource(account) {
    return account.webCookiesEncrypted ?? account.cookiesEncrypted ?? null;
}
function decryptReportCookie(account) {
    const cookieSource = getCookieSource(account);
    if (!cookieSource) {
        throw new Error('Web Session Cookie merchant belum diisi.');
    }
    try {
        return (0, encryption_1.decrypt)(cookieSource);
    }
    catch (err) {
        logger_1.logger.warn({ err, accountCode: account.code }, 'report-python: failed to decrypt report cookie');
        throw new Error('Web Session Cookie merchant tidak bisa dibuka.');
    }
}
function runPythonReportScraper(account, target) {
    return runPythonReportScraperRaw({
        cookie: decryptReportCookie(account),
        userAgent: account.webUserAgent || undefined,
        target,
    });
}
function runPythonReportScraperRaw(input) {
    const payload = JSON.stringify({
        cookie: input.cookie,
        userAgent: input.userAgent || undefined,
        target: input.target,
        maxPages: 3,
    });
    const candidates = getPythonBinCandidates();
    const trySpawn = (index) => new Promise((resolve, reject) => {
        const bin = candidates[index];
        const child = (0, child_process_1.spawn)(bin, ['python/orderkuota_report_scraper.py', '--stdin'], {
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
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
            if (err.code === 'ENOENT' && index + 1 < candidates.length) {
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
                resolve(JSON.parse(stdout));
            }
            catch (err) {
                reject(new Error(`Output scraper Python tidak valid: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
        child.stdin.end(payload);
    });
    return trySpawn(0);
}
async function ingestWalletMutations(accountId, rows) {
    let createdCount = 0;
    for (const row of rows) {
        const result = await (0, mutation_ingest_service_1.storeMutationIfNew)({
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
        if (result.created)
            createdCount += 1;
    }
    return createdCount;
}
async function probeMerchantMutationsFromReport(account, target = 'both') {
    return runPythonReportScraper(account, target);
}
async function probeMerchantMutationsFromRawReportInput(input) {
    return runPythonReportScraperRaw({
        cookie: input.cookie,
        userAgent: input.userAgent,
        target: input.target ?? 'both',
    });
}
async function syncMerchantMutationsFromReport(account, target = 'both') {
    const statsKey = `${account.id}:${target}`;
    const existing = reportSyncInFlight.get(statsKey);
    if (existing)
        return existing;
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
        await database_1.db.qrisAccount.update({
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
async function syncMerchantMutationsFromReportIfStale(account, target = 'both', maxAgeMs = DEFAULT_REPORT_SYNC_MAX_AGE_MS) {
    if (!getCookieSource(account))
        return null;
    const statsKey = `${account.id}:${target}`;
    const lastRunAt = reportSyncLastRunAt.get(statsKey) ?? 0;
    if (Date.now() - lastRunAt < maxAgeMs) {
        return null;
    }
    return syncMerchantMutationsFromReport(account, target);
}
//# sourceMappingURL=orderkuota-report-python.service.js.map