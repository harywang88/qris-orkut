/**
 * Orkut Fetch Scheduler
 *
 * Arsitektur baru:
 * - Local DB adalah sumber utama untuk dashboard + Python worker.
 * - OrderKuota hanya dipoll oleh worker scheduler ini.
 * - Setiap merchant punya interval custom sendiri dari menu Merchant QR.
 * - Akun aktif (punya transaksi open) diprioritaskan lebih cepat.
 * - Jika provider membalas 469, akun langsung cooldown 5 menit.
 */

import type { QrisAccount } from '@prisma/client';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import {
  APP_QRIS_RATE_LIMIT_COOLDOWN_MS,
  AppOrkutRateLimitError,
  appGateway,
} from '../../shared/gateways/app-orkut.gateway';
import type { RawMutation } from '../../shared/gateways/gateway.interface';
import { realGateway } from '../../shared/gateways/real-orkut.gateway';
import { publishMutationUpdated, storeMutationIfNew } from '../../shared/mutation-ingest.service';
import {
  mergeRawMutationWithAppDetail,
  readPresentedMutationRawId,
} from '../../shared/orkut-app-detail.service';
import {
  resolveOrkutAccountIndex,
  syncOrkutBalanceSnapshot,
} from '../../shared/orkut-panel.service';

const MASTER_TICK_MS = 1_000;
const ACTIVE_ACCOUNT_REFRESH_MS = 3_000;
const DETAIL_CANDIDATE_LOOKBACK_MS = 48 * 60 * 60 * 1_000;
const DETAIL_RESULT_BACKOFF_MS = 60_000;
const DETAIL_BATCH_SIZE = 2;

// ── System B: deteksi bayar via poll SALDO (endpoint /api/v2/get BEBAS-LIMIT) ──
// Poll saldo tiap 2s (akun aktif) / 15s (idle). Saat qrisBalance BERUBAH → tarik mutasi 1x
// (endpoint mutasi sensitif 469 hanya disentuh saat ADA bayar). Teruji 22/22 bayar ~2s, 0x469.
const SALDO_ACTIVE_MS = 2_000;
const SALDO_IDLE_MS = 15_000;
// qrisBalance terakhir yang DILIHAT proses ini per akun (deteksi perubahan saldo).
const qrisBalanceSeen = new Map<string, number>();

type LaneState = {
  running: boolean;
  nextAt: number;
};

type SchedulerState = {
  qris: LaneState;
  balance: LaneState;
  detail: LaneState;
};

const providerCooldownUntil = new Map<string, number>();
const detailRetryUntil = new Map<string, number>();
const schedulerState = new Map<string, SchedulerState>();

let activeAccountIds = new Set<string>();
let nextActiveRefreshAt = 0;
let masterTimer: NodeJS.Timeout | null = null;

function getRetryAfterSeconds(untilMs: number): number {
  return Math.max(1, Math.ceil((untilMs - Date.now()) / 1000));
}

function clampPollSeconds(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 5) return fallback;
  return Math.min(300, Math.max(5, Math.floor(value)));
}

function secondsToMs(value: number | null | undefined, fallback: number): number {
  return clampPollSeconds(value, fallback) * 1_000;
}

function getState(accountId: string): SchedulerState {
  const existing = schedulerState.get(accountId);
  if (existing) return existing;

  const created: SchedulerState = {
    qris: { running: false, nextAt: 0 },
    balance: { running: false, nextAt: 0 },
    detail: { running: false, nextAt: 0 },
  };
  schedulerState.set(accountId, created);
  return created;
}

function isAccountCoolingDown(accountId: string): boolean {
  return (providerCooldownUntil.get(accountId) ?? 0) > Date.now();
}

async function refreshActiveAccounts(now: number): Promise<void> {
  if (now < nextActiveRefreshAt) return;

  const activeRows = await db.transaction.findMany({
    where: {
      statusPay: 'open',
      expiresAt: { gt: new Date(now) },
    },
    select: { qrisAccountId: true },
  });

  activeAccountIds = new Set(activeRows.map((row) => row.qrisAccountId));
  nextActiveRefreshAt = now + ACTIVE_ACCOUNT_REFRESH_MS;
}

function getQrisLaneInterval(account: QrisAccount): number {
  return activeAccountIds.has(account.id)
    ? secondsToMs(account.qrisActivePollSeconds, 15)
    : secondsToMs(account.qrisIdlePollSeconds, 30);
}

function getSaldoLaneInterval(account: QrisAccount): number {
  return activeAccountIds.has(account.id) ? SALDO_ACTIVE_MS : SALDO_IDLE_MS;
}

function getBalanceLaneInterval(account: QrisAccount): number {
  return secondsToMs(account.balancePollSeconds, 30);
}

function getDetailLaneInterval(account: QrisAccount): number {
  return secondsToMs(account.detailPollSeconds, 300);
}

async function setProviderCooldown(account: QrisAccount, err: AppOrkutRateLimitError): Promise<void> {
  const retryAt = Date.now() + APP_QRIS_RATE_LIMIT_COOLDOWN_MS;
  const state = getState(account.id);
  providerCooldownUntil.set(account.id, retryAt);
  state.qris.nextAt = Math.max(state.qris.nextAt, retryAt);
  state.balance.nextAt = Math.max(state.balance.nextAt, retryAt);
  state.detail.nextAt = Math.max(state.detail.nextAt, retryAt);
  await db.qrisAccount.update({
    where: { id: account.id },
    data: {
      lastBalanceSyncAt: new Date(),
      lastBalanceSyncStatus: 'rate_limited',
      lastBalanceSyncError: err.message,
    },
  });
  logger.warn(
    {
      accountCode: account.code,
      retryAfterSeconds: getRetryAfterSeconds(retryAt),
    },
    'Orkut scheduler: account paused because provider returned rate limit',
  );
}

async function ingestMutationBatch(
  account: QrisAccount,
  mutations: RawMutation[],
  walletCategoryOverride?: 'qris' | 'utama' | 'madera',
): Promise<number> {
  let newCount = 0;

  for (const mutation of mutations) {
    const result = await storeMutationIfNew({
      qrisAccountId: account.id,
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

    if (result.created) newCount += 1;
  }

  return newCount;
}

async function runAppQrisLane(account: QrisAccount, state: SchedulerState): Promise<void> {
  state.qris.running = true;

  try {
    const recentKnownQris = await db.mutation.findMany({
      where: {
        qrisAccountId: account.id,
        walletCategory: 'qris',
      },
      orderBy: { transactionTime: 'desc' },
      take: 40,
      select: { rawHash: true, transactionTime: true },
    });
    const latestKnownTime = recentKnownQris[0]?.transactionTime ?? null;
    const result = await appGateway.fetchIncrementalMutationsAndBalance(account, {
      knownRawHashes: recentKnownQris.map((row) => row.rawHash),
      fromTime: latestKnownTime ? new Date(latestKnownTime.getTime() - 120_000) : null,
      maxPages: 3,
    });
    providerCooldownUntil.delete(account.id);

    const newCount = await ingestMutationBatch(account, result.mutations);
    const { mainBalance: qrisMain, qrisBalance } = result.balance;
    const qrisLaneOk = qrisMain !== null || qrisBalance !== null;

    await db.qrisAccount.update({
      where: { id: account.id },
      data: {
        lastQrisBalance: qrisBalance ?? account.lastQrisBalance,
        lastMainBalance: qrisMain ?? account.lastMainBalance,
        lastBalanceSyncAt: new Date(),
        lastBalanceSyncStatus: qrisLaneOk ? 'synced' : 'partial',
        lastBalanceSyncError: qrisLaneOk
          ? null
          : 'Provider belum mengirim data QRIS baru. Biasanya ini tanda 469 / rate limit sementara.',
        lastBalanceSyncRawJson: JSON.stringify(result.balance),
      },
    });

    if (newCount > 0) {
      logger.info(
        {
          accountCode: account.code,
          lane: 'qris',
          active: activeAccountIds.has(account.id),
          newMutations: newCount,
        },
        'Orkut scheduler: new QRIS mutations stored',
      );
    }
  } catch (err) {
    if (err instanceof AppOrkutRateLimitError) {
      await setProviderCooldown(account, err);
    } else {
      logger.error({ err, accountCode: account.code, lane: 'qris' }, 'Orkut scheduler: app qris lane error');
    }
  } finally {
    state.qris.running = false;
    state.qris.nextAt = Date.now() + getQrisLaneInterval(account);
  }
}

// System B inti: tarik mutasi QRIS 1x (maxPages:1). Dipanggil HANYA saat saldo QRIS berubah.
async function pullQrisMutationsOnce(account: QrisAccount): Promise<void> {
  const recentKnownQris = await db.mutation.findMany({
    where: { qrisAccountId: account.id, walletCategory: 'qris' },
    orderBy: { transactionTime: 'desc' },
    take: 40,
    select: { rawHash: true, transactionTime: true },
  });
  const latestKnownTime = recentKnownQris[0]?.transactionTime ?? null;
  const result = await appGateway.fetchIncrementalMutationsAndBalance(account, {
    knownRawHashes: recentKnownQris.map((row) => row.rawHash),
    fromTime: latestKnownTime ? new Date(latestKnownTime.getTime() - 120_000) : null,
    maxPages: 1,
  });
  providerCooldownUntil.delete(account.id);

  const newCount = await ingestMutationBatch(account, result.mutations);
  const { mainBalance: qrisMain, qrisBalance } = result.balance;
  await db.qrisAccount.update({
    where: { id: account.id },
    data: {
      lastQrisBalance: qrisBalance ?? account.lastQrisBalance,
      lastMainBalance: qrisMain ?? account.lastMainBalance,
      lastBalanceSyncAt: new Date(),
      lastBalanceSyncStatus: 'synced',
      lastBalanceSyncError: null,
    },
  });

  if (qrisBalance !== null && qrisBalance !== undefined) {
    qrisBalanceSeen.set(account.id, qrisBalance);
  }

  if (newCount > 0) {
    logger.info(
      { accountCode: account.code, lane: 'qris-pull', newMutations: newCount },
      'System B: mutasi QRIS baru tersimpan setelah saldo berubah',
    );
  }
}

// System B: lane SALDO — poll endpoint saldo (bebas limit) tiap 2s/15s, deteksi perubahan qrisBalance.
async function runAppSaldoLane(account: QrisAccount, state: SchedulerState): Promise<void> {
  state.qris.running = true;

  try {
    const summary = await appGateway.fetchAccountSummary(account);
    providerCooldownUntil.delete(account.id);

    const newQris = summary.qrisBalance;
    const newMain = summary.mainBalance;
    const prev = qrisBalanceSeen.has(account.id) ? qrisBalanceSeen.get(account.id) : undefined;

    await db.qrisAccount.update({
      where: { id: account.id },
      data: {
        lastQrisBalance: newQris ?? account.lastQrisBalance,
        lastMainBalance: newMain ?? account.lastMainBalance,
        lastBalanceSyncAt: new Date(),
        lastBalanceSyncStatus: 'synced',
        lastBalanceSyncError: null,
      },
    });

    if (newQris !== null && newQris !== undefined) {
      const changed = prev !== undefined && newQris !== prev;
      // Setelah restart, kalau akun aktif (ada QR nunggu), rekonsiliasi 1x untuk tangkap
      // pembayaran yang mungkin masuk saat worker mati.
      const firstSeenActive = prev === undefined && activeAccountIds.has(account.id);
      qrisBalanceSeen.set(account.id, newQris);
      if (changed || firstSeenActive) {
        await pullQrisMutationsOnce(account);
      }
    }
  } catch (err) {
    if (err instanceof AppOrkutRateLimitError) {
      await setProviderCooldown(account, err);
    } else {
      logger.error({ err, accountCode: account.code, lane: 'saldo' }, 'System B: saldo lane error');
    }
  } finally {
    state.qris.running = false;
    state.qris.nextAt = Date.now() + getSaldoLaneInterval(account);
  }
}

async function runAppBalanceLane(account: QrisAccount, state: SchedulerState): Promise<void> {
  state.balance.running = true;

  try {
    const result = await appGateway.fetchBalanceHistory(account);
    const newCount = await ingestMutationBatch(account, result.mutations);

    await db.qrisAccount.update({
      where: { id: account.id },
      data: {
        lastMainBalance: result.mainBalance ?? account.lastMainBalance,
        lastBalanceSyncAt: new Date(),
      },
    });

    if (newCount > 0) {
      logger.info(
        { accountCode: account.code, lane: 'balance', newMutations: newCount },
        'Orkut scheduler: new utama mutations stored',
      );
    }
  } catch (err) {
    logger.error({ err, accountCode: account.code, lane: 'balance' }, 'Orkut scheduler: app balance lane error');
  } finally {
    state.balance.running = false;
    state.balance.nextAt = Date.now() + getBalanceLaneInterval(account);
  }
}

function needsDetailEnrichment(rrn: string | null, rawId: string): boolean {
  const normalizedRrn = typeof rrn === 'string' ? rrn.trim() : '';
  if (!normalizedRrn) return true;
  return normalizedRrn === rawId;
}

async function runAppDetailLane(account: QrisAccount, state: SchedulerState): Promise<void> {
  state.detail.running = true;

  try {
    const candidates = await db.mutation.findMany({
      where: {
        qrisAccountId: account.id,
        type: 'credit',
        transactionTime: { gte: new Date(Date.now() - DETAIL_CANDIDATE_LOOKBACK_MS) },
      },
      orderBy: { transactionTime: 'desc' },
      take: 20,
    });

    const targets = candidates
      .map((mutation) => ({
        mutation,
        rawId: readPresentedMutationRawId(mutation.rawDataJson),
      }))
      .filter(({ mutation, rawId }) => {
        if (!rawId) return false;
        if (!needsDetailEnrichment(mutation.rrn, rawId)) return false;

        const retryAt = detailRetryUntil.get(mutation.id) ?? 0;
        return retryAt <= Date.now();
      })
      .slice(0, DETAIL_BATCH_SIZE);

    for (const target of targets) {
      try {
        const detail = await appGateway.fetchQrisMutationDetail(account, target.rawId);
        if (!detail) {
          detailRetryUntil.set(target.mutation.id, Date.now() + DETAIL_RESULT_BACKOFF_MS);
          continue;
        }

        const nextIssuerName =
          [detail.brandName, detail.senderName?.split('/')[0]?.trim()]
            .filter(Boolean)
            .join(' / ') || target.mutation.issuerName;

        const updatedMutation = await db.mutation.update({
          where: { id: target.mutation.id },
          data: {
            issuerName: nextIssuerName ?? undefined,
            rawDataJson: mergeRawMutationWithAppDetail(target.mutation.rawDataJson, detail),
            rrn: detail.rrn ?? undefined,
          },
        });

        await publishMutationUpdated(updatedMutation, 'detail_enriched');
        detailRetryUntil.delete(target.mutation.id);
      } catch (err) {
        if (err instanceof AppOrkutRateLimitError) {
          await setProviderCooldown(account, err);
          break;
        }

        logger.error(
          { err, accountCode: account.code, mutationId: target.mutation.id, lane: 'detail' },
          'Orkut scheduler: app detail lane error',
        );
        detailRetryUntil.set(target.mutation.id, Date.now() + DETAIL_RESULT_BACKOFF_MS);
      }
    }
  } finally {
    state.detail.running = false;
    state.detail.nextAt = Date.now() + getDetailLaneInterval(account);
  }
}

async function runWebQrisLane(account: QrisAccount, state: SchedulerState): Promise<void> {
  state.qris.running = true;

  try {
    const mutations = await realGateway.fetchMutations(account);
    const newCount = await ingestMutationBatch(account, mutations);

    if (newCount > 0) {
      logger.info(
        {
          accountCode: account.code,
          lane: 'web-qris',
          active: activeAccountIds.has(account.id),
          newMutations: newCount,
        },
        'Orkut scheduler: new web QRIS mutations stored',
      );
    }
  } catch (err) {
    logger.error({ err, accountCode: account.code, lane: 'web-qris' }, 'Orkut scheduler: web qris lane error');
  } finally {
    state.qris.running = false;
    state.qris.nextAt = Date.now() + getQrisLaneInterval(account);
  }
}

async function runWebBalanceLane(
  account: QrisAccount,
  state: SchedulerState,
  activeAccounts: Pick<QrisAccount, 'id'>[],
): Promise<void> {
  state.balance.running = true;

  try {
    const fallbackIndex = activeAccounts.findIndex((item) => item.id === account.id) + 1;
    const resolvedIndex = resolveOrkutAccountIndex(account, fallbackIndex > 0 ? fallbackIndex : 1);
    const balanceSnapshot = await syncOrkutBalanceSnapshot(account, resolvedIndex);

    if (balanceSnapshot) {
      const updateData: Record<string, unknown> = {
        lastBalanceSyncAt: new Date(balanceSnapshot.fetchedAt),
        lastBalanceSyncStatus: balanceSnapshot.status,
        lastBalanceSyncError: balanceSnapshot.errorMessage ?? null,
        lastBalanceSyncRawJson: balanceSnapshot.rawJson,
      };

      if (balanceSnapshot.mainBalance !== undefined) updateData.lastMainBalance = balanceSnapshot.mainBalance;
      if (balanceSnapshot.qrisBalance !== undefined) updateData.lastQrisBalance = balanceSnapshot.qrisBalance;
      if (balanceSnapshot.maderaBalance !== undefined) updateData.lastMaderaBalance = balanceSnapshot.maderaBalance;

      await db.qrisAccount.update({ where: { id: account.id }, data: updateData });

      if (balanceSnapshot.status !== 'synced') {
        logger.warn(
          {
            accountCode: account.code,
            lane: 'web-balance',
            status: balanceSnapshot.status,
            error: balanceSnapshot.errorMessage,
          },
          'Orkut scheduler: web balance sync finished with partial data',
        );
      }
    }
  } catch (err) {
    logger.error({ err, accountCode: account.code, lane: 'web-balance' }, 'Orkut scheduler: web balance lane error');
  } finally {
    state.balance.running = false;
    state.balance.nextAt = Date.now() + getBalanceLaneInterval(account);
  }
}

async function schedulerTick(): Promise<void> {
  const now = Date.now();
  await refreshActiveAccounts(now);

  const accounts = await db.qrisAccount.findMany({
    where: {
      status: 'active',
      OR: [
        { sessionTokenEncrypted: { not: null } },
        { cookiesEncrypted: { not: null } },
        { webCookiesEncrypted: { not: null } },
      ],
    },
    orderBy: { code: 'asc' },
  });

  if (accounts.length === 0) return;

  for (const account of accounts) {
    const state = getState(account.id);
    const useAppApi = !!account.sessionTokenEncrypted;

    if (useAppApi) {
      if (!state.qris.running && state.qris.nextAt <= now && !isAccountCoolingDown(account.id)) {
        void runAppSaldoLane(account, state); // System B: saldo-lane (bebas limit) gantikan poll mutasi periodik
      }

      if (!state.balance.running && state.balance.nextAt <= now && !isAccountCoolingDown(account.id)) {
        void runAppBalanceLane(account, state);
      }

      if (!state.detail.running && state.detail.nextAt <= now && !isAccountCoolingDown(account.id)) {
        void runAppDetailLane(account, state);
      }

      continue;
    }

    if (!state.qris.running && state.qris.nextAt <= now) {
      void runWebQrisLane(account, state);
    }

    if (!state.balance.running && state.balance.nextAt <= now) {
      void runWebBalanceLane(account, state, accounts);
    }
  }
}

export function startOrkutFetchLoop(): void {
  if (masterTimer) return;

  logger.info(
    {
      masterTickMs: MASTER_TICK_MS,
      activeRefreshMs: ACTIVE_ACCOUNT_REFRESH_MS,
      pythonWatcherDefaultSeconds: 2,
      fallbackSyncDefaultSeconds: 180,
      detailDefaultSeconds: 20,
    },
    'Orkut fetch scheduler started',
  );

  void schedulerTick().catch((err) => logger.error({ err }, 'Orkut scheduler: initial tick error'));

  masterTimer = setInterval(() => {
    void schedulerTick().catch((err) => logger.error({ err }, 'Orkut scheduler: tick error'));
  }, MASTER_TICK_MS);
}
