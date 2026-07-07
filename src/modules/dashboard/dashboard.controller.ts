import { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { OutboxEvent, QrisAccount, Prisma } from '@prisma/client';
import { config } from '../../config';
import { db } from '../../config/database';
import { qrisReceivedTodayMap } from '../../shared/daily-usage.service';
import { logger } from '../../config/logger';
import { withBasePath } from '../../core/base-path';
import { decrypt } from '../../core/encryption';
import {
  createSettlement,
  inquireSettlementBankAccount,
  listSettlementTransferBanks,
  listSettlements,
  processSettlement,
  reconcileProcessingMaderaTransfers,
} from '../../shared/settlement.service';
import { writeAuditLog } from '../../shared/audit-log.service';
import { getWalletBalance } from '../../shared/wallet-ledger.service';
import {
  classifyOrkutMutationDescription,
  resolveOrkutAccountIndex,
  syncOrkutBalanceSnapshot,
  summarizeOrkutAccountBalances,
} from '../../shared/orkut-panel.service';
import {
  dedupePresentedQrisMutations,
  enrichPresentedQrisMutationsWithWebReport,
  fetchOrkutWebReportPayments,
  type PresentedQrisMutation,
} from '../../shared/orkut-web-report.service';
import {
  syncMerchantMutationsFromReport,
  syncMerchantMutationsFromReportIfStale,
} from '../../shared/orderkuota-report-python.service';
import { appGateway, type AppQrisMutationDetail } from '../../shared/gateways/app-orkut.gateway';
import {
  enrichPresentedQrisMutationsWithAppDetails,
  mergeRawMutationWithAppDetail,
  readPresentedMutationRawId,
} from '../../shared/orkut-app-detail.service';
import { publishMutationUpdated, storeMutationIfNew } from '../../shared/mutation-ingest.service';
import { listOutboxEventsSince, parseOutboxPayload } from '../../shared/outbox.service';
import { generateDashboardQrTransaction } from '../../shared/dashboard-generate-qr.service';
import { mapMaderaFeedItem } from '../../shared/madera-history.service';
import {
  getSiteScopeForUser,
  listAccounts,
  createAlias,
  updateAlias,
  deleteAlias,
  MENU_DEFS,
  type AccessUser,
} from '../../shared/alias-access.service';
import {
  accountIdsForSite,
  attachSiteInfo,
  buildResolver,
  getAccountSiteMap,
  listSites,
  siteNameForAccount,
} from '../../shared/site.service';

// ── Scope site untuk alias-tenant (Fase 6) ────────────────────────────────────
// null = tak dibatasi (master / alias "semua site"). Array = hanya akun site tsb.
function getScopeAccountIds(user: AccessUser | undefined): string[] | null {
  const scope = getSiteScopeForUser(user);
  if (!scope) return null;
  return accountIdsForSite(scope);
}

function accountInScope(user: AccessUser | undefined, accountId: string | null | undefined): boolean {
  const ids = getScopeAccountIds(user);
  if (ids === null) return true;
  return !!accountId && ids.includes(accountId);
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDateInput(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.replace(/[^\d]/g, '');
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTransactionPeriod(value: unknown): 'today' | 'yesterday' | '7d' | '30d' | 'custom' | 'all' {
  if (value === 'today' || value === 'yesterday' || value === '7d' || value === '30d' || value === 'custom') {
    return value;
  }
  return 'all';
}

function getTransactionDateRange(query: Request['query']) {
  const period = normalizeTransactionPeriod(query.period);
  const now = new Date();

  if (period === 'today') {
    return { period, from: startOfDay(now), to: endOfDay(now), fromValue: '', toValue: '' };
  }

  if (period === 'yesterday') {
    const target = addDays(now, -1);
    return { period, from: startOfDay(target), to: endOfDay(target), fromValue: '', toValue: '' };
  }

  if (period === '7d') {
    const target = addDays(now, -6);
    return { period, from: startOfDay(target), to: endOfDay(now), fromValue: '', toValue: '' };
  }

  if (period === '30d') {
    const target = addDays(now, -29);
    return { period, from: startOfDay(target), to: endOfDay(now), fromValue: '', toValue: '' };
  }

  const fromValue = typeof query.from === 'string' ? query.from : '';
  const toValue = typeof query.to === 'string' ? query.to : '';
  const from = parseDateInput(query.from);
  const to = parseDateInput(query.to);

  if (period === 'custom') {
    return {
      period,
      from: from ? startOfDay(from) : null,
      to: to ? endOfDay(to) : null,
      fromValue,
      toValue,
    };
  }

  return { period, from: null, to: null, fromValue, toValue };
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
  }).format(amount);
}

type MutationSource = 'qris' | 'utama' | 'madera';

function normalizeMutationSource(value: unknown): MutationSource {
  if (value === 'utama' || value === 'madera' || value === 'qris') return value;
  return 'qris';
}

function getMutationSourceLabel(source: MutationSource): string {
  if (source === 'qris') return 'QRIS';
  if (source === 'utama') return 'Saldo Utama';
  return 'Saldo Madera';
}

function getMutationSourceSubtitle(source: MutationSource): string {
  if (source === 'qris') {
    return 'Data mutasi QRIS dari orderkuota.com - diperbarui otomatis tiap 2 detik';
  }
  if (source === 'utama') {
    return 'Data mutasi ledger saldo utama - diperbarui otomatis tiap 2 detik';
  }
  return 'Data mutasi ledger saldo madera - diperbarui otomatis tiap 2 detik';
}

function getMutationApiUrl(source: MutationSource): string {
  return withBasePath(`/dashboard/api/mutations?source=${source}&limit=500`, config.APP_BASE_PATH);
}

type QrisMutationBucket = 'all' | 'qris' | 'utama' | 'madera';
type MutationCategory = 'qris' | 'utama' | 'madera';
type ParsedMutationPayload = Record<string, unknown>;
const DETAIL_ENRICH_COOLDOWN_MS = 5 * 60 * 1000;
const qrisDetailEnrichAttempts = new Map<string, number>();

function normalizeQrisBucket(value: unknown): QrisMutationBucket {
  if (value === 'qris' || value === 'utama' || value === 'madera' || value === 'all') {
    return value;
  }
  return 'all';
}

function getCategoryLabel(category: string): string {
  if (category === 'qris') return 'QRIS';
  if (category === 'madera') return 'Madera';
  return 'Utama';
}

function normalizeMutationCategory(value: unknown): MutationCategory | null {
  if (value === 'qris' || value === 'utama' || value === 'madera') return value;
  return null;
}

function hasExplicitUtamaMarker(text: string): boolean {
  return (
    text.includes('pencairan qris')
    || text.includes('pencairan saldo qris')
    || text.includes('biaya percepatan pencairan qris')
    || text.includes('withdraw qris')
    || text.includes('tarik saldo qris')
    || text.includes('pindah saldo ke madera')
  );
}

function hasExplicitMaderaMarker(text: string): boolean {
  return (
    text.includes('topup madera')
    || text.includes('bi fast out')
    || text.includes('bifast out')
    || text.includes('transfer bi fast')
    || text.includes('biaya transfer bi fast')
  );
}

function isUtamaShadowMutation(rawDataJson: string): boolean {
  try {
    const parsed = JSON.parse(rawDataJson) as {
      description?: string;
      keterangan?: string;
      note?: string;
      ket?: string;
    };
    const description = readString(parsed.description || parsed.keterangan || parsed.note || parsed.ket).toLowerCase();
    // Row "Pencairan Saldo QRIS ..." diperlakukan sebagai bayangan QRIS
    // agar Mutasi Utama tetap mengikuti format saldo utama aplikasi.
    return description.includes('pencairan saldo qris');
  } catch {
    return false;
  }
}

function readMutationCategory(rawDataJson: string, storedCategory?: unknown): MutationCategory {
  const normalizedStored = normalizeMutationCategory(storedCategory);
  try {
    const parsed = JSON.parse(rawDataJson) as {
      description?: string;
      keterangan?: string;
      note?: string;
      ket?: string;
      walletCategory?: string;
    };
    const parsedStored = normalizeMutationCategory(parsed.walletCategory);
    const description = readString(parsed.description || parsed.keterangan || parsed.note || parsed.ket);
    const text = description.toLowerCase();

    if (description) {
      if (text.includes('pencairan saldo qris')) return 'qris';
      if (hasExplicitMaderaMarker(text)) return 'madera';
      if (hasExplicitUtamaMarker(text)) return 'utama';
    }

    if (parsedStored) return parsedStored;
    if (normalizedStored) return normalizedStored;

    if (description) {
      return classifyOrkutMutationDescription(description);
    }
  } catch {
    // ignore malformed raw JSON and fall back to the main ledger bucket
  }
  if (normalizedStored) return normalizedStored;
  return 'utama';
}

function parseRawMutationPayload(rawDataJson: string): ParsedMutationPayload {
  try {
    const parsed = JSON.parse(rawDataJson) as ParsedMutationPayload;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNestedString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return readString((value as Record<string, unknown>)[key]);
}

function hasDisplayTimeSeconds(value: string | null | undefined): boolean {
  return typeof value === 'string' && /\d{2}:\d{2}:\d{2}$/.test(value.trim());
}

function resolveMutationReferenceCandidate(raw: ParsedMutationPayload, fallbackRrn: string | null): string {
  const explicitReference =
    readString(raw.issuer_ref) ||
    readString(raw.rrn) ||
    readString(raw.ref) ||
    readString(raw.reference) ||
    readString(raw.reference_no) ||
    readString(raw.no_referensi) ||
    readString(raw.noReferensi) ||
    readString(raw.rrn_code) ||
    readString(raw.referenceNumber);

  if (explicitReference) return explicitReference;

  const descriptionReferenceSource =
    readString(raw.description) ||
    readString(raw.keterangan) ||
    readString(raw.note) ||
    readString(raw.ket);
  if (descriptionReferenceSource) {
    const referenceMatch = descriptionReferenceSource.match(/(?:R#|RRN[:#\s]?|REF[:#\s]?)([A-Z0-9]+)/i);
    if (referenceMatch?.[1]) {
      return referenceMatch[1];
    }
  }

  const fallbackValue = readString(fallbackRrn);
  if (!fallbackValue) return '';

  const rawId = readString(raw.id);
  if (rawId && fallbackValue === rawId) {
    return '';
  }

  return fallbackValue;
}

function shouldAttemptQrisDetailEnrichment(accountId: string, rawId: string): boolean {
  const key = `${accountId}:${rawId}`;
  const lastAttempt = qrisDetailEnrichAttempts.get(key) ?? 0;
  return Date.now() - lastAttempt >= DETAIL_ENRICH_COOLDOWN_MS;
}

function markQrisDetailEnrichmentAttempt(accountId: string, rawId: string): void {
  qrisDetailEnrichAttempts.set(`${accountId}:${rawId}`, Date.now());
}

function formatMutationTimestamp(value: Date): string {
  return value.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }) + ' ' + value.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });
}

type MaderaInferenceAccount = {
  id: string;
  code: string;
  merchantName: string;
  sessionTokenEncrypted: string | null;
  cookiesEncrypted: string | null;
  deviceId: string | null;
  lastMaderaBalance: number | null;
};

type InferredMaderaMutation = {
  id: string;
  amount: number;
  type: 'credit' | 'debit';
  balanceAfter: number;
  time: Date;
  rawDataJson: string;
  description: string;
};

function inferMaderaDirection(description: string, fallbackType: 'credit' | 'debit'): 'credit' | 'debit' {
  const text = description.toLowerCase();
  if (
    text.includes('ke madera')
    || text.includes('topup madera')
    || text.includes('pindah saldo ke madera')
    || text.includes('saldo masuk madera')
  ) {
    return 'credit';
  }

  if (
    text.includes('dari madera')
    || text.includes('madera ke bank')
    || text.includes('transfer madera')
    || text.includes('tarik madera')
    || text.includes('saldo keluar madera')
    || text.includes('bi fast out')
    || text.includes('bifast out')
    || text.includes('transfer bi fast')
    || text.includes('biaya transfer bi fast')
  ) {
    return 'debit';
  }

  return fallbackType === 'debit' ? 'credit' : 'debit';
}

async function inferMaderaStateFromAppHistory(
  account: MaderaInferenceAccount,
): Promise<{ balance: number | null; mutations: InferredMaderaMutation[]; note: string | null }> {
  if (!account.sessionTokenEncrypted) {
    return {
      balance: account.lastMaderaBalance,
      mutations: [],
      note: null,
    };
  }

  const history = await appGateway.fetchBalanceHistory(account);
  const related = history.mutations
    .map((mutation) => {
      const raw = parseRawMutationPayload(mutation.rawDataJson);
      const description =
        readString(raw.keterangan) ||
        readString(raw.description) ||
        '';
      if (classifyOrkutMutationDescription(description) !== 'madera') {
        return null;
      }

      return {
        id: `${account.id}:${mutation.rawHash}`,
        amount: mutation.amount,
        type: inferMaderaDirection(description, mutation.type as 'credit' | 'debit'),
        time: mutation.transactionTime,
        rawDataJson: mutation.rawDataJson,
        description,
      };
    })
    .filter((item): item is { id: string; amount: number; type: 'credit' | 'debit'; time: Date; rawDataJson: string; description: string } => item !== null)
    .sort((left, right) => right.time.getTime() - left.time.getTime());

  if (related.length === 0) {
    return {
      balance: account.lastMaderaBalance,
      mutations: [],
      note: null,
    };
  }

  const inferredBalance = typeof account.lastMaderaBalance === 'number'
    ? account.lastMaderaBalance
    : Math.max(
      0,
      related.reduce((sum, item) => sum + (item.type === 'credit' ? item.amount : -item.amount), 0),
    );

  let runningBalance = inferredBalance;
  const rows = related.map((item) => {
    const row: InferredMaderaMutation = {
      id: item.id,
      amount: item.amount,
      type: item.type,
      balanceAfter: runningBalance,
      time: item.time,
      rawDataJson: item.rawDataJson,
      description: item.description,
    };
    runningBalance -= item.type === 'credit' ? item.amount : -item.amount;
    return row;
  });

  return {
    balance: inferredBalance,
    mutations: rows,
    note: 'Saldo Madera ditaksir dari histori topup/keluar Madera pada aplikasi.',
  };
}

function parseSettlementNoteMarkers(note: string | null | undefined): {
  cleanNote: string | null;
  fee: number | null;
  total: number | null;
} {
  const text = String(note || '');
  const feeMatch = text.match(/\[\[FEE:(\d+)\]\]/);
  const totalMatch = text.match(/\[\[TOTAL:(\d+)\]\]/);
  const cleanNote = text
    .replace(/\s*\[\[(?:FEE|TOTAL|REDIRECT_URL):.+?\]\]\s*/g, ' ')
    .replace(/\s+\|\s*$/g, '')
    .trim();

  return {
    cleanNote: cleanNote || null,
    fee: feeMatch ? Number.parseInt(feeMatch[1], 10) : null,
    total: totalMatch ? Number.parseInt(totalMatch[1], 10) : null,
  };
}

type MaderaSyntheticEntry = {
  amount: number;
  description: string;
  id: string;
  referenceNo: string | null;
  rawDataJson: string;
  time: Date;
  type: 'credit' | 'debit';
  weight: number;
};

type MaderaTopupHistoryEntry = {
  amount: number;
  description: string;
  rawDataJson: string;
  referenceNo: string | null;
  time: Date;
};

function isMaderaTopupDescription(description: string): boolean {
  const text = description.toLowerCase();
  return text.includes('pindah saldo ke madera') || text.includes('topup madera');
}

function extractMaderaReference(description: string): string | null {
  const pMatch = description.match(/P#([A-Z0-9]+)/i);
  if (pMatch?.[1]) return `P#${pMatch[1]}`;
  const rMatch = description.match(/R#([A-Z0-9]+)/i);
  if (rMatch?.[1]) return `R#${rMatch[1]}`;
  return null;
}

type BuildMaderaPresentedMutationsResult = {
  mutations: PresentedQrisMutation[];
  note: string | null;
};

function buildMaderaPresentedMutations(
  account: { code: string; id: string; lastMaderaBalance: number | null; merchantName: string; orkutAccountIndex: number | null },
  topupHistory: MaderaTopupHistoryEntry[],
  settlements: Array<{
    amount: number;
    createdAt: Date;
    fromWallet: string;
    id: string;
    note: string | null;
    processedAt: Date | null;
    referenceNo: string | null;
    toWallet: string;
  }>,
  currentBalance: number | null,
): BuildMaderaPresentedMutationsResult {
  const entries: MaderaSyntheticEntry[] = [];
  let note: string | null = null;

  for (const topup of topupHistory) {
    const topupReference =
      extractMaderaReference(topup.description)
      || topup.referenceNo
      || null;
    const normalizedTopupDescription = topupReference
      ? `TOPUP MADERA ${topupReference.replace(/^P#/i, '')}`
      : 'TOPUP MADERA';
    const topupRawDataJson = JSON.stringify({
      description: normalizedTopupDescription,
      keterangan: normalizedTopupDescription,
      tanggal: formatMutationTimestamp(topup.time),
      no_referensi: topup.referenceNo,
      walletCategory: 'madera',
      source_note: topup.description,
    });

    entries.push({
      id: `${account.id}:topup:${topup.referenceNo || topup.time.getTime()}:${topup.amount}`,
      amount: topup.amount,
      type: 'credit',
      time: topup.time,
      weight: 40,
      referenceNo: topup.referenceNo,
      description: normalizedTopupDescription,
      rawDataJson: topupRawDataJson,
    });
  }

  for (const settlement of settlements) {
    const noteMeta = parseSettlementNoteMarkers(settlement.note);
    const baseTime = settlement.processedAt ?? settlement.createdAt;

    if (settlement.fromWallet === 'madera' && settlement.toWallet === 'bank') {
      const ownerName = (noteMeta.cleanNote || '').split('|')[0]?.trim() || '';
      const transferDescription = ownerName ? `BI FAST OUT ${ownerName}` : 'BI FAST OUT';
      const transferRawDataJson = JSON.stringify({
        description: transferDescription,
        keterangan: transferDescription,
        tanggal: formatMutationTimestamp(baseTime),
        no_referensi: settlement.referenceNo,
        walletCategory: 'madera',
      });
      entries.push({
        id: `${settlement.id}:transfer`,
        amount: settlement.amount,
        type: 'debit',
        time: baseTime,
        weight: 20,
        referenceNo: settlement.referenceNo ?? null,
        description: transferDescription,
        rawDataJson: transferRawDataJson,
      });

      const feeAmount = noteMeta.fee ?? 2500;
      if (feeAmount > 0) {
        const feeTime = new Date(baseTime.getTime() + 1000);
        const feeDescription = 'BIAYA TRANSFER BI FAST';
        const feeRawDataJson = JSON.stringify({
          description: feeDescription,
          keterangan: feeDescription,
          tanggal: formatMutationTimestamp(feeTime),
          no_referensi: settlement.referenceNo,
          walletCategory: 'madera',
        });
        entries.push({
          id: `${settlement.id}:fee`,
          amount: feeAmount,
          type: 'debit',
          time: feeTime,
          weight: 30,
          referenceNo: settlement.referenceNo ?? null,
          description: feeDescription,
          rawDataJson: feeRawDataJson,
        });
      }
    }
  }

  const dedupedEntries = Array.from(new Map(
    entries.map((entry) => {
      const key = `${entry.time.getTime()}|${entry.type}|${entry.amount}|${entry.description}`;
      return [key, entry] as const;
    }),
  ).values());

  const knownCurrentBalance = typeof currentBalance === 'number'
    ? currentBalance
    : account.lastMaderaBalance;
  const sumCredit = dedupedEntries.reduce((sum, entry) => (
    entry.type === 'credit' ? sum + entry.amount : sum
  ), 0);
  const sumDebit = dedupedEntries.reduce((sum, entry) => (
    entry.type === 'debit' ? sum + entry.amount : sum
  ), 0);
  const balanceDrift = typeof knownCurrentBalance === 'number'
    ? (sumCredit - sumDebit - knownCurrentBalance)
    : 0;

  if (balanceDrift > 0) {
    const latestEntryTime = dedupedEntries
      .slice()
      .sort((left, right) => right.time.getTime() - left.time.getTime())[0]?.time
      ?? new Date();
    const inferredTransferAmount = balanceDrift > 2500 ? balanceDrift - 2500 : 0;
    const inferredFeeAmount = balanceDrift > 2500 ? 2500 : balanceDrift;

    if (inferredTransferAmount > 0) {
      const transferTime = new Date(latestEntryTime.getTime() + 1000);
      const transferDescription = 'BI FAST OUT (Auto Sinkron)';
      dedupedEntries.push({
        id: `${account.id}:inferred:transfer:${transferTime.getTime()}:${inferredTransferAmount}`,
        amount: inferredTransferAmount,
        type: 'debit',
        time: transferTime,
        weight: 25,
        referenceNo: null,
        description: transferDescription,
        rawDataJson: JSON.stringify({
          description: transferDescription,
          keterangan: transferDescription,
          tanggal: formatMutationTimestamp(transferTime),
          walletCategory: 'madera',
          inferred: true,
        }),
      });
    }

    if (inferredFeeAmount > 0) {
      const feeTime = new Date(latestEntryTime.getTime() + 2000);
      const feeDescription = 'BIAYA TRANSFER BI FAST (Auto Sinkron)';
      dedupedEntries.push({
        id: `${account.id}:inferred:fee:${feeTime.getTime()}:${inferredFeeAmount}`,
        amount: inferredFeeAmount,
        type: 'debit',
        time: feeTime,
        weight: 30,
        referenceNo: null,
        description: feeDescription,
        rawDataJson: JSON.stringify({
          description: feeDescription,
          keterangan: feeDescription,
          tanggal: formatMutationTimestamp(feeTime),
          walletCategory: 'madera',
          inferred: true,
        }),
      });
    }

    note = 'Sebagian mutasi Madera diselaraskan otomatis dari selisih saldo terbaru agar saldo akhir tetap akurat.';
  }

  const chronologicalEntries = dedupedEntries
    .slice()
    .sort((left, right) => {
      const timeDiff = left.time.getTime() - right.time.getTime();
      if (timeDiff !== 0) return timeDiff;
      return left.weight - right.weight;
    });

  const netMutation = chronologicalEntries.reduce((sum, entry) => (
    entry.type === 'credit' ? sum + entry.amount : sum - entry.amount
  ), 0);
  let openingBalance = typeof knownCurrentBalance === 'number'
    ? knownCurrentBalance - netMutation
    : 0;
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    openingBalance = 0;
  }

  let runningBalance = openingBalance;
  const projectedEntries = chronologicalEntries.map((entry) => {
    runningBalance = entry.type === 'credit'
      ? runningBalance + entry.amount
      : runningBalance - entry.amount;
    return {
      ...entry,
      balanceAfter: runningBalance,
    };
  });

  const sortedEntries = projectedEntries
    .sort((left, right) => {
      const timeDiff = right.time.getTime() - left.time.getTime();
      if (timeDiff !== 0) return timeDiff;
      return right.weight - left.weight;
    });

  const __maderaSiteName = siteNameForAccount(account.id);
  const mutations = sortedEntries.map((entry) => {
    const rrnValue = 'referenceNo' in entry ? entry.referenceNo : null;

    const presentation = parseMutationPresentation(entry.rawDataJson, {
      type: entry.type,
      issuerName: account.merchantName,
      rrn: rrnValue,
      description: entry.description,
      transactionTime: entry.time,
      matched: true,
    });

    return {
      id: entry.id,
      source: 'qris' as const,
      accountCode: account.code,
      merchant: account.merchantName,
      settlementIndex: account.orkutAccountIndex,
      category: 'madera' as const,
      categoryLabel: getCategoryLabel('madera'),
      walletLabel: getCategoryLabel('madera'),
      amount: entry.amount,
      type: entry.type,
      issuerName: account.merchantName,
      rrn: presentation.rrnDisplay,
      matched: true,
      statusLabel: 'Mutasi Madera',
      statusKind: 'matched',
      statusCode: presentation.statusCode,
      statusText: presentation.statusText,
      description: presentation.descriptionLine,
      senderName: presentation.senderName,
      bankEwallet: presentation.bankEwallet,
      brandName: presentation.brandName,
      displayTime: presentation.displayTime,
      rawDataJson: entry.rawDataJson,
      balanceAfter: entry.balanceAfter,
      time: entry.time,
      createdAt: entry.time,
      siteName: __maderaSiteName,
      userIdExt: null,
    };
  });

  return { mutations, note };
}

function parseMutationPresentation(
  rawDataJson: string,
  fallback: {
    type: string;
    issuerName: string | null;
    rrn: string | null;
    description: string;
    transactionTime: Date;
    matched: boolean;
  },
) {
  const raw = parseRawMutationPayload(rawDataJson);
  const rawTimestamp =
    readString(raw.tanggal) ||
    readString(raw.date) ||
    readString(raw.created_at) ||
    readString(raw.waktu);
  const rawDescription =
    readString(raw.keterangan) ||
    readString(raw.description) ||
    readString(raw.note) ||
    readString(raw.ket);
  const rawStatus = readString(raw.status).toUpperCase();
  const brandName =
    readNestedString(raw.brand, 'name') ||
    readString(raw.brand_name) ||
    readString(raw.brand);
  const issuerCandidate =
    readString(raw.bank) ||
    readString(raw.bank_name) ||
    readString(raw.issuer) ||
    readString(raw.bank_ewallet) ||
    readString(raw.bankEwallet) ||
    (fallback.issuerName ?? '');
  const referenceCandidate = resolveMutationReferenceCandidate(raw, fallback.rrn);

  const desc = rawDescription || fallback.description;
  const directSender =
    readString(raw.buyer_ref) ||
    readString(raw.sender_name) ||
    readString(raw.senderName);
  const descParts = desc.split('/').map((part) => part.trim()).filter(Boolean);
  const networkName = descParts[0] || '';
  const senderTail = descParts.length > 1 ? descParts.slice(1).join(' / ') : '';
  const senderName = directSender || senderTail || desc || fallback.issuerName || 'Tidak terbaca';
  const bankParts = [brandName, issuerCandidate, networkName]
    .filter((part) => part && part !== 'Orderkuota QRIS')
    .filter((part, index, arr) => arr.indexOf(part) === index);
  const bankEwallet = bankParts.join(' / ') || fallback.issuerName || 'OrderKuota';
  const statusCode = rawStatus === 'IN' || rawStatus === 'OUT'
    ? rawStatus
    : fallback.type === 'credit'
      ? 'IN'
      : 'OUT';

  return {
    raw,
    displayTime: rawTimestamp || formatMutationTimestamp(fallback.transactionTime),
    statusCode,
    statusText: statusCode === 'IN' ? 'Dana Masuk' : 'Dana Keluar',
    reconciliationLabel: fallback.matched ? 'MATCH' : 'Belum cocok',
    senderName,
    bankEwallet,
    rrnDisplay: referenceCandidate || null,
    descriptionLine: desc,
    brandName: brandName || null,
  };
}

async function getQrisBalanceSummary() {
  const accounts = await db.qrisAccount.findMany({
    where: { status: 'active' },
    select: {
      lastMainBalance: true,
      lastQrisBalance: true,
      lastMaderaBalance: true,
      lastBalanceSyncAt: true,
    },
  });

  const summary = summarizeOrkutAccountBalances(accounts);
  return summary.syncedAccounts > 0 ? summary : null;
}

async function renderMutationsPage(req: Request, res: Response, source: MutationSource): Promise<void> {
  const balanceSummary = source === 'qris' ? await getQrisBalanceSummary() : null;

  res.render('mutations/index', {
    title: `Mutasi ${getMutationSourceLabel(source)}`,
    source,
    sourceLabel: getMutationSourceLabel(source),
    sourceSubtitle: getMutationSourceSubtitle(source),
    apiUrl: getMutationApiUrl(source),
    balanceSummary,
    query: req.query,
  });
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
// "Kesehatan" LIVE (bukan snapshot Tes Koneksi yg basi & memasukkan cek Report-Web/469 yg kita LEWATI).
// healthy = aktif + token ada + saldo-sync tak error & tak basi. degraded = jalan tapi error/parsial. down = tak ada token.
function computeLiveHealth(a: QrisAccount): string {
  if (a.status !== 'active') return a.healthStatus || 'down';
  if (!a.sessionTokenEncrypted) return 'down';
  const errored = !!a.lastBalanceSyncError
    || a.lastBalanceSyncStatus === 'error'
    || a.lastBalanceSyncStatus === 'failed';
  if (errored) return 'degraded';
  const ageMs = a.lastBalanceSyncAt ? (Date.now() - new Date(a.lastBalanceSyncAt).getTime()) : null;
  if (ageMs !== null && ageMs > 24 * 60 * 60 * 1000) return 'degraded'; // sync macet >24 jam
  return 'healthy';
}

export async function showDashboard(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);

    const [
      totalToday,
      paidToday,
      activeAccounts,
      totalClients,
      failedDeposits,
      manualReview,
      queueLag,
    ] = await Promise.all([
      db.transaction.count({ where: { createdAt: { gte: todayStart, lte: todayEnd } } }),
      db.transaction.count({
        where: { statusPay: 'paid', paidAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.qrisAccount.count({ where: { status: 'active' } }),
      db.client.count({ where: { status: 'active' } }),
      db.transaction.count({ where: { statusBot: 'deposit_failed' } }),
      db.transaction.count({ where: { statusBot: 'manual_review' } }),
      db.transaction.count({ where: { statusPay: 'paid', statusBot: 'deposit_queued' } }),
    ]);

    const paidAggregate = await db.transaction.aggregate({
      where: { statusPay: 'paid', paidAt: { gte: todayStart, lte: todayEnd } },
      _sum: { finalAmount: true },
    });
    const paidAmountToday = paidAggregate._sum.finalAmount ?? 0;

    // 7-day chart data
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const recentTx = await db.transaction.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true, finalAmount: true, statusPay: true },
      orderBy: { createdAt: 'asc' },
    });

    const chartLabels: string[] = [];
    const chartCounts: number[] = [];
    const chartAmounts: number[] = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      chartLabels.push(label);

      const dayStart = startOfDay(d);
      const dayEnd = endOfDay(d);
      const dayTx = recentTx.filter((t) => t.createdAt >= dayStart && t.createdAt <= dayEnd);
      chartCounts.push(dayTx.length);
      chartAmounts.push(dayTx.filter((t) => t.statusPay === 'paid').reduce((sum, t) => sum + t.finalAmount, 0));
    }

    const recentTransactionsRaw = await db.transaction.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { name: true, panelCode: true } },
        qrisAccount: { select: { id: true, code: true, merchantName: true } },
      },
    });
    const _resolveSite = buildResolver();
    const recentTransactions = recentTransactionsRaw.map((tx) => Object.assign({}, tx, { siteName: _resolveSite(tx.qrisAccountId).siteName }));

    const qrisAccountsRaw = await db.qrisAccount.findMany({ orderBy: { code: 'asc' } });
    // Limit Harian = total PAID hari ini (WIB) per akun (bukan reserve saat generate); auto-reset ganti hari.
    // Kesehatan = LIVE (computeLiveHealth), bukan snapshot basi -> normal jadi "healthy", bukan "degraded".
    const WIB_MS = 7 * 60 * 60 * 1000;
    const todayWibStart = new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
    // Status Akun QRIS = SEMUA uang masuk QRIS hari ini (WIB) = paid + pending (mutasi kredit).
    const paidTodayMap = await qrisReceivedTodayMap();
    const qrisAccounts = qrisAccountsRaw.map((a) => Object.assign({}, a, { usedToday: paidTodayMap[a.id] || 0, healthStatus: computeLiveHealth(a) }));

    res.render('dashboard/index', {
      title: 'Dashboard',
      stats: {
        totalToday,
        paidToday,
        paidAmountToday,
        paidAmountTodayFormatted: formatRupiah(paidAmountToday),
        activeAccounts,
        totalClients,
        failedDeposits,
        manualReview,
        queueLag,
      },
      chartData: {
        labels: JSON.stringify(chartLabels),
        counts: JSON.stringify(chartCounts),
        amounts: JSON.stringify(chartAmounts),
      },
      recentTransactions,
      qrisAccounts,
    });
  } catch (err) {
    logger.error({ err }, 'showDashboard error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── History Generate QR & Transaction: SATU mesin (showTransactions).
//    /dashboard/history  -> semua status (History Generate QR)
//    /dashboard/transactions -> dikunci paid (opts.paidOnly). Halaman lama history/index.ejs DIPENSIUNKAN.
// ── Paid Transactions ─────────────────────────────────────────────────────────
export async function showTransactions(
  req: Request,
  res: Response,
  opts: { paidOnly?: boolean; title?: string } = {},
): Promise<void> {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = 50;
  const offset = (page - 1) * limit;
  const paidOnly = !!(opts && opts.paidOnly); // menu Transaction = dikunci paid
  try {
    const dateRange = getTransactionDateRange(req.query);
    const where: Record<string, unknown> = {};
    const accountCode = typeof req.query.accountCode === 'string' ? req.query.accountCode.trim() : '';
    const clientId = typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
    const statusPay = typeof req.query.statusPay === 'string' ? req.query.statusPay.trim() : '';
    const statusBot = typeof req.query.statusBot === 'string' ? req.query.statusBot.trim() : '';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const nominalRaw = typeof req.query.nominal === 'string' ? req.query.nominal : '';
    const nominal = parsePositiveNumber(nominalRaw.replace(/[^\d]/g, ''));

    if (clientId) where.clientId = clientId;
    if (statusPay) where.statusPay = statusPay;
    if (statusBot) where.statusBot = statusBot;
    if (accountCode) {
      where.qrisAccount = { code: accountCode };
    }
    if (dateRange.from || dateRange.to) {
      where.createdAt = {
        ...(dateRange.from ? { gte: dateRange.from } : {}),
        ...(dateRange.to ? { lte: dateRange.to } : {}),
      };
    }
    if (nominal !== null) {
      where.finalAmount = nominal;
    }
    if (keyword) {
      where.OR = [
        { qrId: { contains: keyword } },
        { userIdExt: { contains: keyword } },
        { externalReference: { contains: keyword } },
        { note: { contains: keyword } },
        { issuerName: { contains: keyword } },
        { rrn: { contains: keyword } },
        { qrisAccount: { merchantName: { contains: keyword } } },
        { qrisAccount: { code: { contains: keyword } } },
        { client: { name: { contains: keyword } } },
        { client: { panelCode: { contains: keyword } } },
      ];
    }
    // Filter Site (dari sites.json via akun->site) + scope alias-tenant (Fase 6: showTransactions dulu belum discope).
    const site = typeof req.query.site === 'string' ? req.query.site.trim() : '';
    const scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    let siteAccountIds: string[] | null = null;
    if (site === 'none') {
      const _allAccts = await db.qrisAccount.findMany({ select: { id: true } });
      const _map = getAccountSiteMap();
      siteAccountIds = _allAccts.filter((a) => !_map[a.id]).map((a) => a.id);
    } else if (site) {
      siteAccountIds = accountIdsForSite(site);
    }
    let effectiveAccountIds: string[] | null = null;
    if (scopeIds && siteAccountIds) effectiveAccountIds = siteAccountIds.filter((id) => scopeIds.includes(id));
    else if (scopeIds) effectiveAccountIds = scopeIds;
    else if (siteAccountIds) effectiveAccountIds = siteAccountIds;
    if (effectiveAccountIds) where.qrisAccountId = { in: effectiveAccountIds };
    // Menu Transaction: KUNCI hanya paid (server-side) — QR generate/open/expired mustahil masuk walau via URL.
    if (paidOnly) where.statusPay = 'paid';

    const [transactionsRaw, total] = await Promise.all([
      db.transaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }],
        take: limit,
        skip: offset,
        include: {
          client: { select: { name: true, panelCode: true } },
          qrisAccount: { select: { id: true, code: true, merchantName: true } },
          mutations: {
            select: {
              rrn: true,
              issuerName: true,
              transactionTime: true,
              createdAt: true,
            },
            orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
            take: 3,
          },
        },
      }),
      db.transaction.count({ where }),
    ]);

    const transactions = await Promise.all(transactionsRaw.map(async (tx) => {
      const fallbackMutation = tx.mutations.find((mutation) => mutation.rrn || mutation.issuerName) ?? tx.mutations[0];
      if (tx.statusPay !== 'paid' || !fallbackMutation) {
        return tx;
      }
      const patch: { rrn?: string; issuerName?: string; paidAt?: Date } = {};
      if (!tx.rrn && fallbackMutation.rrn) patch.rrn = fallbackMutation.rrn;
      if (!tx.issuerName && fallbackMutation.issuerName) patch.issuerName = fallbackMutation.issuerName;
      if (!tx.paidAt && fallbackMutation.transactionTime) patch.paidAt = fallbackMutation.transactionTime;
      if (Object.keys(patch).length === 0) {
        return tx;
      }
      await db.transaction.update({
        where: { id: tx.id },
        data: patch,
      });
      return {
        ...tx,
        ...patch,
      };
    }));

    const [clients, qrisAccounts, paidAgg, statusPayAgg, statusBotAgg] = await Promise.all([
      db.client.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      db.qrisAccount.findMany({ select: { id: true, code: true, merchantName: true }, orderBy: { code: 'asc' } }),
      db.transaction.aggregate({ where, _sum: { finalAmount: true, feeAmount: true } }),
      db.transaction.groupBy({
        by: ['statusPay'],
        where,
        _count: { _all: true },
      }),
      db.transaction.groupBy({
        by: ['statusBot'],
        where,
        _count: { _all: true },
      }),
    ]);
    const totalPaid = paidAgg._sum.finalAmount ?? 0;
    const totalFee = paidAgg._sum.feeAmount ?? 0;
    const statusPayMap = statusPayAgg.reduce<Record<string, number>>((acc, row) => {
      acc[row.statusPay] = row._count._all;
      return acc;
    }, {});
    const statusBotMap = statusBotAgg.reduce<Record<string, number>>((acc, row) => {
      acc[row.statusBot] = row._count._all;
      return acc;
    }, {});
    const openCount = statusPayMap.open ?? 0;
    const paidCount = statusPayMap.paid ?? 0;
    const expiredCount = statusPayMap.expired ?? 0;
    const reviewCount = statusBotMap.manual_review ?? 0;
    const _resolveSite = buildResolver();
    const transactionsWithSite = transactions.map((tx) => Object.assign({}, tx, { siteName: _resolveSite(tx.qrisAccountId).siteName }));
    // Sematkan siteId ke tiap akun QRIS agar dropdown filter Akun bisa disaring per Site (client-side).
    const qrisAccountsWithSite = qrisAccounts.map((a) => ({ id: a.id, code: a.code, merchantName: a.merchantName, siteId: _resolveSite(a.id).siteId || 'none' }));
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    res.render('transactions/index', {
      title: opts.title || 'Transaksi QR',
      paidOnly,
      transactions: transactionsWithSite,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      clients,
      qrisAccounts: qrisAccountsWithSite,
      sites,
      totalPaid,
      totalFee,
      query: {
        ...req.query,
        period: dateRange.period,
        from: dateRange.fromValue,
        to: dateRange.toValue,
        keyword,
        accountCode,
        clientId,
        statusPay,
        statusBot,
        nominal: nominalRaw,
      },
      stats: {
        openCount,
        paidCount,
        expiredCount,
        reviewCount,
      },
      isDev: process.env.NODE_ENV !== 'production',
    });
  } catch (err) {
    logger.error({ err }, 'showTransactions error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────
export async function getTransactionsSnapshotApi(req: Request, res: Response): Promise<void> {
  try {
    const qrIds = Array.isArray(req.body?.qrIds)
      ? req.body.qrIds.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 100)
      : [];
    if (qrIds.length === 0) {
      res.json({ ok: true, transactions: [] });
      return;
    }
    const transactions = await db.transaction.findMany({
      where: { qrId: { in: qrIds } },
      select: {
        qrId: true,
        qrisAccountId: true,
        statusPay: true,
        statusBot: true,
        rrn: true,
        issuerName: true,
        paidAt: true,
        createdAt: true,
        expiresAt: true,
        mutations: {
          select: {
            rrn: true,
            issuerName: true,
            transactionTime: true,
            createdAt: true,
          },
          orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
          take: 3,
        },
      },
    });
    const snapshot = await Promise.all(transactions.map(async (tx) => {
      const fallbackMutation = tx.mutations.find((mutation) => mutation.rrn || mutation.issuerName) ?? tx.mutations[0] ?? null;
      const nextRrn = tx.rrn || fallbackMutation?.rrn || null;
      const nextIssuer = tx.issuerName || fallbackMutation?.issuerName || null;
      const nextPaidAt = tx.paidAt || fallbackMutation?.transactionTime || null;
      if (tx.statusPay === 'paid' && ((!tx.rrn && nextRrn) || (!tx.issuerName && nextIssuer) || (!tx.paidAt && nextPaidAt))) {
        await db.transaction.update({
          where: { qrId: tx.qrId },
          data: {
            ...(tx.rrn ? {} : { rrn: nextRrn ?? undefined }),
            ...(tx.issuerName ? {} : { issuerName: nextIssuer ?? undefined }),
            ...(tx.paidAt ? {} : { paidAt: nextPaidAt ?? undefined }),
          },
        });
      }
      return {
        qrId: tx.qrId,
        qrisAccountId: tx.qrisAccountId,
        statusPay: tx.statusPay,
        statusBot: tx.statusBot,
        rrn: nextRrn,
        issuerName: nextIssuer,
        paidAt: nextPaidAt,
        createdAt: tx.createdAt,
        expiresAt: tx.expiresAt,
      };
    }));
    res.json({ ok: true, transactions: snapshot });
  } catch (err) {
    logger.error({ err }, 'getTransactionsSnapshotApi error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil snapshot transaksi.' });
  }
}

// Transaksi TERBARU (utk live "baris baru" di menu Transaction). Murni baca DB LOKAL (tanpa OrderKuota).
// Format baris IDENTIK dgn tableData di views/transactions/index.ejs supaya bisa langsung addData.
export async function getLatestTransactionsApi(req: Request, res: Response): Promise<void> {
  try {
    const take = Math.min(50, Math.max(1, parseInt(String(req.query?.take ?? '30'), 10) || 30));
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const transactionsRaw = await db.transaction.findMany({
      where: _scopeIds ? { qrisAccountId: { in: _scopeIds } } : undefined,
      orderBy: [{ createdAt: 'desc' }, { updatedAt: 'desc' }],
      take,
      include: {
        client: { select: { name: true, panelCode: true } },
        qrisAccount: { select: { id: true, code: true, merchantName: true } },
        mutations: {
          select: { rrn: true, issuerName: true, transactionTime: true, createdAt: true },
          orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
          take: 3,
        },
      },
    });
    const _resolveSite = buildResolver();
    const transactions = transactionsRaw.map((tx) => {
      const fb = tx.mutations.find((m) => m.rrn || m.issuerName) ?? tx.mutations[0] ?? null;
      return {
        id: tx.id,
        qrId: tx.qrId,
        qrisAccountId: tx.qrisAccountId,
        clientName: tx.client?.name || '-',
        panelCode: tx.client?.panelCode || '-',
        accountCode: tx.qrisAccount.code,
        merchantName: tx.qrisAccount.merchantName,
        requestedAmount: tx.requestedAmount,
        finalAmount: tx.finalAmount,
        feeAmount: tx.feeAmount || 0,
        uniqueCode: tx.uniqueCode,
        statusPay: tx.statusPay,
        statusBot: tx.statusBot,
        expiresAt: tx.expiresAt,
        paidAt: tx.paidAt || fb?.transactionTime || null,
        createdAt: tx.createdAt,
        note: tx.note,
        issuerName: tx.issuerName || fb?.issuerName || null,
        rrn: tx.rrn || fb?.rrn || null,
        receiptUrl: tx.receiptUrl,
        qrImageBase64: tx.qrImageBase64,
        userIdExt: tx.userIdExt,
        externalReference: tx.externalReference,
        metadataJson: tx.metadataJson,
        siteName: _resolveSite(tx.qrisAccountId).siteName,
      };
    });
    res.json({ ok: true, transactions });
  } catch (err) {
    logger.error({ err }, 'getLatestTransactionsApi error');
    res.status(500).json({ ok: false, error: 'Gagal mengambil transaksi terbaru.' });
  }
}

export async function showMutations(req: Request, res: Response): Promise<void> {
  try {
    res.redirect(withBasePath('/dashboard/mutations/qris', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'showMutations error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showMutationsQris(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await db.qrisAccount.findMany({
      where: { status: 'active' },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        merchantName: true,
        orkutAccountIndex: true,
        lastMainBalance: true,
        lastQrisBalance: true,
        lastBalanceSyncStatus: true,
        healthStatus: true,
      },
    });
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    const _resolveSite = buildResolver();
    const accountsWithSite = (_scopeIds ? accounts.filter((a) => _scopeIds.includes(a.id)) : accounts).map((a) => Object.assign({}, a, { siteName: _resolveSite(a.id).siteName || '' }));
    res.render('mutations/qris', {
      title: 'Mutasi QRIS',
      accounts: accountsWithSite,
      sites,
      streamUrl: withBasePath('/dashboard/api/mutations/stream', config.APP_BASE_PATH),
    });
  } catch (err) {
    logger.error({ err }, 'showMutationsQris error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

function formatOutboxSseEvent(event: OutboxEvent) {
  const payload = parseOutboxPayload(event.payloadJson);
  return {
    id: event.id,
    topic: event.topic,
    qrisAccountId: event.qrisAccountId,
    createdAt: event.createdAt.toISOString(),
    payload,
  };
}

export async function streamMutationsSse(req: Request, res: Response): Promise<void> {
  const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
  let cursor = new Date(Date.now() - 5000);
  let lastEventId = '';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (eventName: string, data: Record<string, unknown>) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send('ready', {
    ok: true,
    accountId: accountId ?? null,
    connectedAt: new Date().toISOString(),
  });
  const heartbeat = setInterval(() => {
    send('heartbeat', { ts: new Date().toISOString() });
  }, 15000);
  const watcher = setInterval(async () => {
    try {
      const events = await listOutboxEventsSince(cursor, lastEventId, accountId);
      if (events.length === 0) return;
      cursor = events[events.length - 1].createdAt;
      lastEventId = events[events.length - 1].id;
      send('mutation.delta', {
        count: events.length,
        latestAt: cursor.toISOString(),
        events: events.map(formatOutboxSseEvent),
      });
    } catch (err) {
      logger.error({ err, accountId }, 'streamMutationsSse watcher error');
      send('error', { message: 'stream_error' });
    }
  }, 1000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(watcher);
    res.end();
  });
}

export async function showMutationsUtama(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await db.qrisAccount.findMany({
      where: { status: 'active', sessionTokenEncrypted: { not: null } },
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, merchantName: true, orkutAccountIndex: true,
        lastMainBalance: true, lastQrisBalance: true,
        lastBalanceSyncStatus: true, healthStatus: true,
      },
    });
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    const _resolveSite = buildResolver();
    const accountsWithSite = (_scopeIds ? accounts.filter((a) => _scopeIds.includes(a.id)) : accounts).map((a) => Object.assign({}, a, { siteName: _resolveSite(a.id).siteName || '' }));
    res.render('mutations/utama', {
      title: 'Saldo Utama',
      accounts: accountsWithSite,
      sites,
      walletBucket: 'utama',
      walletRefresh: 'utama',
      walletField: 'lastMainBalance',
      walletTitle: 'Mutasi Utama',
      walletSubTitle: 'Riwayat mutasi saldo utama dari semua akun OrderKuota (debet/kredit)',
      walletLabel: 'Saldo Utama',
      emptySubTitle: 'Klik tab akun di atas untuk melihat mutasi saldo utama',
      loadingLabel: 'Memuat mutasi saldo utama...',
      emptyHint: 'Belum ada riwayat saldo utama untuk akun ini.<br>Worker akan menarik data dari OrderKuota API setiap 30 detik.',
    });
  } catch (err) {
    logger.error({ err }, 'showMutationsUtama error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function showMutationsMadera(req: Request, res: Response): Promise<void> {
  try {
    await reconcileProcessingMaderaTransfers().catch((err) => {
      logger.warn({ err }, 'showMutationsMadera: unable to reconcile processing madera transfers');
    });
    const accounts = await db.qrisAccount.findMany({
      where: { status: 'active' },
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, merchantName: true, orkutAccountIndex: true,
        lastMaderaBalance: true, lastQrisBalance: true,
        lastBalanceSyncStatus: true, healthStatus: true,
      },
    });
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    const _resolveSite = buildResolver();
    const accountsWithSite = (_scopeIds ? accounts.filter((a) => _scopeIds.includes(a.id)) : accounts).map((a) => Object.assign({}, a, { siteName: _resolveSite(a.id).siteName || '' }));
    res.render('mutations/utama', {
      title: 'Saldo Madera',
      accounts: accountsWithSite,
      sites,
      streamUrl: withBasePath('/dashboard/api/mutations/stream', config.APP_BASE_PATH),
      walletBucket: 'madera',
      walletRefresh: 'madera',
      walletField: 'lastMaderaBalance',
      walletTitle: 'Mutasi Madera',
      walletSubTitle: 'Riwayat mutasi saldo Madera per akun OrderKuota.',
      walletLabel: 'Saldo Madera',
      emptySubTitle: 'Klik tab akun di atas untuk melihat mutasi saldo Madera',
      loadingLabel: 'Memuat mutasi saldo Madera...',
      emptyHint: 'Belum ada riwayat saldo Madera untuk akun ini.<br>Saldo dan mutasi akan tersinkron saat akun dipilih atau saat settlement dijalankan.',
    });
  } catch (err) {
    logger.error({ err }, 'showMutationsMadera error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── Mutations JSON (for 2-second frontend poll) ───────────────────────────────
export async function showMaderaNobuHistory(req: Request, res: Response): Promise<void> {
  try {
    const accountsRaw = await db.qrisAccount.findMany({
      where: { status: 'active' },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true, lastMaderaBalance: true, healthStatus: true },
    });
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _scoped = _scopeIds ? accountsRaw.filter((a) => _scopeIds.includes(a.id)) : accountsRaw;
    const _resolveSite = buildResolver();
    const accounts = _scoped.map((a) => Object.assign({}, a, { siteName: _resolveSite(a.id).siteName }));
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    res.render('madera-nobu/index', { title: 'History Transaksi Nobu', accounts, sites });
  } catch (err) {
    logger.error({ err }, 'showMaderaNobuHistory error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

const capturingProofs = new Set<string>();

export async function handleCaptureSettlementProofApi(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '');
    const dir = path.join(process.cwd(), 'data', 'nobu-proofs');
    const outPath = path.join(dir, id + '.png');
    if (fs.existsSync(outPath)) { res.json({ ok: true, status: 'ready' }); return; }
    if (capturingProofs.has(id)) { res.json({ ok: true, status: 'processing' }); return; }
    const settlement = await db.settlementRequest.findUnique({ where: { id } });
    if (!settlement || !settlement.qrisAccountId) { res.status(404).json({ ok: false, message: 'Transaksi tidak ditemukan.' }); return; }
    const account = await db.qrisAccount.findUnique({ where: { id: settlement.qrisAccountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    capturingProofs.add(id);
    (async () => {
      try {
        const urlRes = await (appGateway as any).fetchMaderaHistoryWebviewUrl(account);
        if (urlRes && urlRes.ok && urlRes.url) {
          try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
          const shot = await (appGateway as any).captureMaderaHistoryScreenshotAsync(urlRes.url, outPath, account, settlement.amount);
          logger.info({ id, ok: shot && shot.ok, msg: shot && shot.message }, 'captureProof done');
        }
        else { logger.warn({ id, msg: urlRes && urlRes.message }, 'captureProof: url gagal'); }
      }
      catch (err) { logger.error({ err, id }, 'captureProof background error'); }
      finally { capturingProofs.delete(id); }
    })();
    res.json({ ok: true, status: 'processing' });
  } catch (err) {
    logger.error({ err }, 'handleCaptureSettlementProofApi error');
    res.status(500).json({ ok: false, message: 'Gagal memulai pengambilan bukti.' });
  }
}

export async function getSettlementProofApi(req: Request, res: Response): Promise<void> {
  try {
    const id = String(req.params.id || '').replace(/[^A-Za-z0-9_-]/g, '');
    const file = path.join(process.cwd(), 'data', 'nobu-proofs', id + '.png');
    if (!id || !fs.existsSync(file)) { res.status(404).send('Bukti belum tersedia.'); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="bukti-nobu-' + id + '.png"');
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    logger.error({ err }, 'getSettlementProofApi error');
    res.status(500).send('Gagal mengunduh bukti.');
  }
}

export async function getSettlementProofsListApi(req: Request, res: Response): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'data', 'nobu-proofs');
    let ids: string[] = [];
    try { ids = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)); } catch (e) {}
    res.json({ ok: true, ids, processing: Array.from(capturingProofs) });
  } catch (err) {
    res.status(500).json({ ok: false, ids: [], processing: [] });
  }
}

export async function getMaderaNobuWebviewApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) {
      res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
      return;
    }
    const result = await (appGateway as any).fetchMaderaHistoryWebviewUrl(account);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'getMaderaNobuWebviewApi error');
    res.status(500).json({ ok: false, message: 'Gagal mengambil link webview.' });
  }
}

export async function getMaderaNobuHistoryApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) {
      res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' });
      return;
    }
    const result = await (appGateway as any).fetchMaderaTransactionHistory(account);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'getMaderaNobuHistoryApi error');
    res.status(500).json({ ok: false, message: 'Gagal mengambil histori Madera.' });
  }
}

export async function getBridgeStatusApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findFirst({
      where: { status: 'active', sessionTokenEncrypted: { not: null } },
      orderBy: { code: 'asc' },
    });
    if (!account) { res.json({ ok: false, reason: 'no_account', message: 'Tidak ada akun aktif bersession.' }); return; }
    const r = await (appGateway as any).pingEgress(account, 6000);
    res.json({ ok: !!(r && r.ok), latencyMs: r && r.latencyMs, message: (r && r.message) || null });
  } catch (err) {
    logger.error({ err }, 'getBridgeStatusApi error');
    res.status(500).json({ ok: false, message: 'Gagal cek status bridge.' });
  }
}

async function buildAllAccountsMaderaFromDb(limit: number) {
  const take = Math.min(Math.max(limit, 500) * 3, 3000);
  const accounts = await db.qrisAccount.findMany({
    where: { status: 'active' },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, merchantName: true, orkutAccountIndex: true, lastMaderaBalance: true },
  });
  if (accounts.length === 0)
    return { mutations: [] as PresentedQrisMutation[], note: null, balances: {} as Record<string, number> };
  const balances: Record<string, number> = {};
  for (const acc of accounts)
    balances[acc.id] = acc.lastMaderaBalance ?? 0;
  const [allMutations, allSettlements] = await Promise.all([
    db.mutation.findMany({
      // Future-proof: ambil HANYA baris topup Madera (langka) di DB, jangan 3000 baris semua kategori.
      // Superset dari isMaderaTopupDescription (JS filter tetap jalan) -> tak ada topup Madera hilang
      // walau mutasi QRIS menumpuk ribuan. Cocokkan penanda di dalam rawDataJson (SQLite LIKE = case-insensitive ASCII).
      where: {
        OR: [
          { rawDataJson: { contains: 'Pindah Saldo ke Madera' } },
          { rawDataJson: { contains: 'Topup Madera' } },
        ],
      },
      orderBy: { transactionTime: 'desc' },
      take,
      select: { qrisAccountId: true, amount: true, rawDataJson: true, transactionTime: true },
    }),
    db.settlementRequest.findMany({
      where: { status: 'done', fromWallet: 'madera', toWallet: 'bank' },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, qrisAccountId: true, fromWallet: true, toWallet: true, amount: true, referenceNo: true, note: true, createdAt: true, processedAt: true },
    }),
  ]);
  const topupsByAccount = new Map<string, MaderaTopupHistoryEntry[]>();
  for (const mutation of allMutations) {
    if (!mutation.qrisAccountId)
      continue;
    const raw = parseRawMutationPayload(mutation.rawDataJson);
    const description = readString(raw.keterangan) || readString(raw.description) || readString(raw.note) || readString(raw.ket);
    if (!isMaderaTopupDescription(description))
      continue;
    const referenceNo = extractMaderaReference(description) || readString(raw.no_referensi) || readString(raw.reference_no) || null;
    const list = topupsByAccount.get(mutation.qrisAccountId) || [];
    list.push({ amount: mutation.amount, description, rawDataJson: mutation.rawDataJson, referenceNo, time: mutation.transactionTime });
    topupsByAccount.set(mutation.qrisAccountId, list);
  }
  const settlementsByAccount = new Map<string, typeof allSettlements[number][]>();
  for (const settlement of allSettlements) {
    if (!settlement.qrisAccountId)
      continue;
    const list = settlementsByAccount.get(settlement.qrisAccountId) || [];
    list.push(settlement);
    settlementsByAccount.set(settlement.qrisAccountId, list);
  }
  let merged: PresentedQrisMutation[] = [];
  for (const account of accounts) {
    const topups = topupsByAccount.get(account.id) || [];
    const settlements = settlementsByAccount.get(account.id) || [];
    if (topups.length === 0 && settlements.length === 0)
      continue;
    const built = buildMaderaPresentedMutations(account, topups, settlements, account.lastMaderaBalance);
    merged = merged.concat(built.mutations);
  }
  merged.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return { mutations: merged, note: null, balances };
}

// System B Madera: baca baris mutasi Madera ASLI dari DB (walletCategory='madera') utk 1 akun.
// Saldo per baris DIHITUNG dari lastMaderaBalance (saldo terkini asli) berjalan mundur:
// baris terbaru saldoAkhir = lastMaderaBalance, lalu tiap baris lebih lama dibalik sesuai debet/kredit.
// TIDAK ada rekonstruksi / Auto Sinkron — deskripsi, nominal, tipe, waktu semua dari feed OrderKuota.
async function buildMaderaRealRowsForAccount(
  account: { id: string; code: string; merchantName: string; orkutAccountIndex: number | null; lastMaderaBalance: number | null },
  source: MutationSource,
  limit: number,
) {
  const rows = await db.mutation.findMany({
    where: { qrisAccountId: account.id, walletCategory: 'madera' },
    orderBy: { transactionTime: 'desc' },
    take: limit,
  });
  let running = typeof account.lastMaderaBalance === 'number' ? account.lastMaderaBalance : 0;
  const __accSiteName = siteNameForAccount(account.id);
  return rows.map((m) => {
    const balanceAfter = running;
    const balanceBefore = m.type === 'credit' ? running - m.amount : running + m.amount;
    running = balanceBefore;
    const parsedRaw = parseRawMutationPayload(m.rawDataJson) as { description?: string; keterangan?: string };
    const description = parsedRaw.description ?? parsedRaw.keterangan ?? '';
    const presentation = parseMutationPresentation(m.rawDataJson, {
      type: m.type,
      issuerName: m.issuerName,
      rrn: m.rrn ?? null,
      description,
      transactionTime: m.transactionTime,
      matched: false,
    });
    return {
      id: m.id,
      source,
      accountCode: account.code,
      merchant: account.merchantName,
      settlementIndex: account.orkutAccountIndex ?? null,
      qrisAccountId: account.id,
      category: 'madera',
      categoryLabel: getCategoryLabel('madera'),
      walletLabel: getCategoryLabel('madera'),
      amount: m.amount,
      type: m.type,
      issuerName: m.issuerName,
      rrn: presentation.rrnDisplay,
      matched: false,
      statusLabel: presentation.reconciliationLabel,
      statusKind: 'unmatched',
      statusCode: presentation.statusCode,
      statusText: presentation.statusText,
      description: presentation.descriptionLine,
      senderName: presentation.senderName,
      bankEwallet: presentation.bankEwallet,
      brandName: presentation.brandName,
      displayTime: presentation.displayTime,
      rawDataJson: m.rawDataJson,
      balanceAfter,
      time: m.transactionTime,
      createdAt: m.createdAt,
      siteName: __accSiteName,
      userIdExt: null,
    };
  });
}

export async function getMutationsJson(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const source = normalizeMutationSource(req.query.source);
    const bucket = normalizeQrisBucket(req.query.bucket);
    if (source === 'qris') {
      const where: Record<string, unknown> = {};
      const targetAccountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
      const targetAccount = targetAccountId
        ? await db.qrisAccount.findUnique({
          where: { id: targetAccountId },
          select: {
            id: true,
            code: true,
            merchantName: true,
            orkutAccountIndex: true,
            lastMainBalance: true,
            lastQrisBalance: true,
            lastMaderaBalance: true,
            sessionTokenEncrypted: true,
            cookiesEncrypted: true,
            webCookiesEncrypted: true,
            webUserAgent: true,
            deviceId: true,
          },
        })
        : null;
      // Fase 6: scope alias-tenant. Akun di luar site -> tolak (kosong).
      const scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
      if (scopeIds && targetAccountId && !scopeIds.includes(targetAccountId)) {
        res.json({ ok: true, source, bucket, total: 0, currentBalance: null, balanceSummary: await getQrisBalanceSummary(), note: null, bucketCounts: { qris: 0, utama: 0, madera: 0 }, mutations: [] });
        return;
      }
      // Web report keblok 469 dari IP VPS. Akun yang punya app-API (session token) sudah dapat mutasi
      // dari worker (app-API via bridge) -> LEWATI web report. Hanya akun tanpa app-API yang coba report.
      if (targetAccountId &&
        targetAccount &&
        (bucket === 'qris' || bucket === 'utama') &&
        !targetAccount.sessionTokenEncrypted &&
        (targetAccount.webCookiesEncrypted || targetAccount.cookiesEncrypted)) {
        await syncMerchantMutationsFromReportIfStale(targetAccount, bucket, 15000).catch((err) => {
          logger.warn({ err, accountCode: targetAccount.code, bucket }, 'getMutationsJson: unable to sync report mutations before reading table');
        });
      }
      if (bucket === 'madera' && !targetAccountId) {
        // Semua Akun: baca baris Madera ASLI per akun dari DB (worker yang menariknya saat saldo berubah),
        // hitung saldo berjalan per akun, lalu gabung & urut waktu. Baca DB murni -> cepat seperti QRIS.
        const maderaAccounts = await db.qrisAccount.findMany({
          where: scopeIds ? { status: 'active', id: { in: scopeIds } } : { status: 'active' },
          orderBy: { code: 'asc' },
          select: { id: true, code: true, merchantName: true, orkutAccountIndex: true, lastMaderaBalance: true },
        });
        const perAccount = await Promise.all(maderaAccounts.map((acc) => buildMaderaRealRowsForAccount(acc, source, limit)));
        const merged = perAccount.flat().sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        const balances: Record<string, number> = {};
        for (const acc of maderaAccounts) {
          balances[acc.id] = typeof acc.lastMaderaBalance === 'number' ? acc.lastMaderaBalance : 0;
        }
        res.json({
          ok: true,
          source,
          bucket,
          total: merged.length,
          currentBalance: null,
          accountBalances: balances,
          balanceSummary: await getQrisBalanceSummary(),
          note: null,
          bucketCounts: { qris: 0, utama: 0, madera: merged.length },
          mutations: merged.slice(0, limit),
        });
        return;
      }
      if (bucket === 'madera' && targetAccountId && targetAccount) {
        // Baris Madera ASLI dari DB (worker menariknya saat saldo Madera berubah via System B).
        // Baca DB murni -> cepat seperti menu QRIS. Saldo berjalan dihitung dari lastMaderaBalance.
        const presentedMutations = await buildMaderaRealRowsForAccount(targetAccount, source, limit);
        const currentBalance = typeof targetAccount.lastMaderaBalance === 'number'
          ? targetAccount.lastMaderaBalance
          : (presentedMutations[0]?.balanceAfter ?? 0);
        res.json({
          ok: true,
          source,
          bucket,
          total: presentedMutations.length,
          currentBalance,
          balanceSummary: await getQrisBalanceSummary(),
          note: null,
          bucketCounts: { qris: 0, utama: 0, madera: presentedMutations.length },
          mutations: presentedMutations.slice(0, limit),
        });
        return;
      }
      // Filter by specific account if provided
      if (targetAccountId) {
        where.qrisAccountId = targetAccountId;
      }
      else if (scopeIds) {
        // Fase 6: "Semua Akun" utk alias-tenant = hanya akun site-nya.
        where.qrisAccountId = { in: scopeIds };
      }
      // Date range filter
      if (req.query.dateFrom || req.query.dateTo) {
        const timeFilter: Record<string, Date> = {};
        if (typeof req.query.dateFrom === 'string' && req.query.dateFrom) {
          timeFilter.gte = new Date(`${req.query.dateFrom}T00:00:00+07:00`);
        }
        if (typeof req.query.dateTo === 'string' && req.query.dateTo) {
          timeFilter.lte = new Date(`${req.query.dateTo}T23:59:59.999+07:00`);
        }
        if (Object.keys(timeFilter).length > 0) {
          where.transactionTime = timeFilter;
        }
      }
      // Bucket UTAMA: filter walletCategory di DB supaya window `take` terisi baris utama,
      // tidak tertimbun mutasi QRIS yang jauh lebih banyak (future-proof saat total mutasi > limit).
      // Bucket qris/madera/all TIDAK disentuh (qris perlu ikut baris 'Pencairan Saldo QRIS' walletCategory=utama).
      if (bucket === 'utama') {
        where.walletCategory = 'utama';
      }
      const mutations = await db.mutation.findMany({
        where,
        orderBy: { transactionTime: 'desc' },
        take: limit,
        include: {
          qrisAccount: { select: { code: true, merchantName: true, orkutAccountIndex: true } },
          matchedTransaction: { select: { rrn: true, userIdExt: true, client: { select: { name: true } } } },
        },
      });
      const balanceSummary = await getQrisBalanceSummary();
      const resolvedMutations = mutations.map((m) => ({
        mutation: m,
        category: readMutationCategory(m.rawDataJson, m.walletCategory),
      }));
      const resolveSite = buildResolver();
      let presentedMutations: PresentedQrisMutation[] = resolvedMutations.map(({ mutation: m, category }) => {
        const parsedRaw = parseRawMutationPayload(m.rawDataJson) as { description?: string; keterangan?: string };
        const description = parsedRaw.description ?? parsedRaw.keterangan ?? '';
        const presentation = parseMutationPresentation(m.rawDataJson, {
          type: m.type,
          issuerName: m.issuerName,
          rrn: m.rrn ?? m.matchedTransaction?.rrn ?? null,
          description,
          transactionTime: m.transactionTime,
          matched: !!m.matchedTransactionId,
        });
        return {
          id: m.id,
          source,
          accountCode: m.qrisAccount.code,
          merchant: m.qrisAccount.merchantName,
          settlementIndex: m.qrisAccount.orkutAccountIndex,
          category,
          categoryLabel: getCategoryLabel(category),
          walletLabel: getCategoryLabel(category),
          amount: m.amount,
          type: m.type,
          issuerName: m.issuerName,
          rrn: presentation.rrnDisplay,
          matched: !!m.matchedTransactionId,
          statusLabel: presentation.reconciliationLabel,
          statusKind: m.matchedTransactionId ? 'matched' : 'unmatched',
          statusCode: presentation.statusCode,
          statusText: presentation.statusText,
          description: presentation.descriptionLine,
          senderName: presentation.senderName,
          bankEwallet: presentation.bankEwallet,
          brandName: presentation.brandName,
          displayTime: presentation.displayTime,
          rawDataJson: m.rawDataJson,
          balanceAfter: m.balanceAfter,
          time: m.transactionTime,
          createdAt: m.createdAt,
          siteName: resolveSite(m.qrisAccountId).siteName,
          userIdExt: m.matchedTransaction?.userIdExt ?? null,
        };
      });
      presentedMutations = presentedMutations.filter((mutation) => {
        if (mutation.category !== 'utama')
          return true;
        return !isUtamaShadowMutation(mutation.rawDataJson);
      });
      if (bucket !== 'all') {
        presentedMutations = presentedMutations.filter((mutation) => mutation.category === bucket);
      }
      let maderaInferenceNote: string | null = null;
      if (bucket === 'madera' && targetAccount && presentedMutations.length === 0) {
        const inferred = await inferMaderaStateFromAppHistory(targetAccount);
        if (inferred.mutations.length > 0) {
          maderaInferenceNote = inferred.note;
          const __infSiteName = siteNameForAccount(targetAccount.id);
          presentedMutations = inferred.mutations.map((mutation) => {
            const presentation = parseMutationPresentation(mutation.rawDataJson, {
              type: mutation.type,
              issuerName: null,
              rrn: null,
              description: mutation.description,
              transactionTime: mutation.time,
              matched: false,
            });
            return {
              id: mutation.id,
              source,
              accountCode: targetAccount.code,
              merchant: targetAccount.merchantName,
              settlementIndex: targetAccount.orkutAccountIndex ?? null,
              category: 'madera',
              categoryLabel: getCategoryLabel('madera'),
              walletLabel: getCategoryLabel('madera'),
              amount: mutation.amount,
              type: mutation.type,
              issuerName: null,
              rrn: presentation.rrnDisplay,
              matched: false,
              statusLabel: presentation.reconciliationLabel,
              statusKind: 'inferred',
              statusCode: presentation.statusCode,
              statusText: presentation.statusText,
              description: presentation.descriptionLine,
              senderName: presentation.senderName,
              bankEwallet: presentation.bankEwallet,
              brandName: presentation.brandName,
              displayTime: presentation.displayTime,
              rawDataJson: mutation.rawDataJson,
              balanceAfter: mutation.balanceAfter,
              time: mutation.time,
              createdAt: mutation.time,
              siteName: __infSiteName,
              userIdExt: null,
            };
          });
        }
      }
      const allowLiveUpstreamEnrichment = req.query.upstream === '1';
      if (allowLiveUpstreamEnrichment && targetAccountId) {
        const activeAccounts = await db.qrisAccount.findMany({
          where: { status: 'active' },
          orderBy: { code: 'asc' },
          select: {
            id: true,
            code: true,
            cookiesEncrypted: true,
            deviceId: true,
            orkutAccountIndex: true,
            sessionTokenEncrypted: true,
          },
        });
        const fallbackIndex = activeAccounts.findIndex((account) => account.id === targetAccountId) + 1;
        const liveAccount = activeAccounts.find((account) => account.id === targetAccountId);
        if (liveAccount && fallbackIndex > 0) {
          const accountIndex = resolveOrkutAccountIndex(liveAccount, fallbackIndex);
          const webReportPayments = await fetchOrkutWebReportPayments(liveAccount, accountIndex);
          if (webReportPayments.length > 0) {
            presentedMutations = enrichPresentedQrisMutationsWithWebReport(presentedMutations, webReportPayments);
          }
        }
        if (liveAccount?.sessionTokenEncrypted) {
          const detailTargets = presentedMutations
            .filter((row) => {
              const rawId = readPresentedMutationRawId(row.rawDataJson);
              if (!rawId)
                return false;
              return ((!row.rrn || !hasDisplayTimeSeconds(row.displayTime) || row.senderName === 'Tidak terbaca') &&
                shouldAttemptQrisDetailEnrichment(targetAccountId, rawId));
            })
            .map((row) => ({
              mutationId: row.id,
              rawDataJson: row.rawDataJson,
              rawId: readPresentedMutationRawId(row.rawDataJson),
            }))
            .filter((row, index, rows) => row.rawId && rows.findIndex((item) => item.rawId === row.rawId) === index)
            .slice(0, 12);
          if (detailTargets.length > 0) {
            detailTargets.forEach((target) => markQrisDetailEnrichmentAttempt(targetAccountId, target.rawId));
            const detailResults = await Promise.all(detailTargets.map(async (target) => {
              try {
                const detail = await appGateway.fetchQrisMutationDetail(liveAccount, target.rawId);
                return detail ? { ...target, detail } : null;
              }
              catch {
                return null;
              }
            }));
            const resolvedDetails = detailResults
              .filter((item): item is { detail: AppQrisMutationDetail; mutationId: string; rawDataJson: string; rawId: string } => item !== null);
            if (resolvedDetails.length > 0) {
              presentedMutations = enrichPresentedQrisMutationsWithAppDetails(presentedMutations, resolvedDetails.map((item) => item.detail));
              await Promise.allSettled(resolvedDetails.map(async ({ detail, mutationId, rawDataJson }) => {
                const nextIssuerName = [detail.brandName, detail.senderName?.split('/')[0]?.trim()]
                  .filter(Boolean)
                  .join(' / ') || undefined;
                const updatedMutation = await db.mutation.update({
                  where: { id: mutationId },
                  data: {
                    issuerName: nextIssuerName,
                    rawDataJson: mergeRawMutationWithAppDetail(rawDataJson, detail),
                    rrn: detail.rrn ?? undefined,
                  },
                });
                await publishMutationUpdated(updatedMutation, 'detail_enriched');
              }));
            }
          }
        }
      }
      presentedMutations = dedupePresentedQrisMutations(presentedMutations);
      const dedupedBucketCounts = presentedMutations.reduce<Record<MutationCategory, number>>((acc, mutation) => {
        const category = mutation.category === 'qris' || mutation.category === 'utama' || mutation.category === 'madera'
          ? mutation.category
          : 'utama';
        acc[category] += 1;
        return acc;
      }, { qris: 0, utama: 0, madera: 0 });
      const currentBalance = bucket === 'madera'
        ? (targetAccount?.lastMaderaBalance
          ?? presentedMutations[0]?.balanceAfter
          ?? 0)
        : bucket === 'utama'
          ? (targetAccount?.lastMainBalance
            ?? presentedMutations[0]?.balanceAfter
            ?? balanceSummary?.mainBalance
            ?? 0)
          : bucket === 'qris'
            ? (targetAccount?.lastQrisBalance
              ?? presentedMutations[0]?.balanceAfter
              ?? balanceSummary?.qrisBalance
              ?? 0)
            : balanceSummary?.qrisBalance ?? presentedMutations[0]?.balanceAfter ?? 0;
      res.json({
        ok: true,
        source,
        bucket,
        total: presentedMutations.length,
        currentBalance,
        balanceSummary,
        note: maderaInferenceNote,
        bucketCounts: dedupedBucketCounts,
        mutations: presentedMutations,
      });
      return;
    }
    const walletEntries = await db.walletLedger.findMany({
      where: { walletCode: source },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const currentBalance = walletEntries[0]?.balanceAfter ?? 0;
    const sourceLabel = getMutationSourceLabel(source);
    res.json({
      ok: true,
      source,
      total: walletEntries.length,
      currentBalance,
      mutations: walletEntries.map((entry) => ({
        id: entry.id,
        source,
        walletCode: entry.walletCode,
        walletLabel: sourceLabel,
        accountCode: source.toUpperCase(),
        category: source,
        categoryLabel: sourceLabel,
        merchant: sourceLabel,
        amount: Math.abs(entry.amount),
        signedAmount: entry.amount,
        type: entry.amount >= 0 ? 'credit' : 'debit',
        issuerName: null,
        rrn: entry.refId,
        matched: false,
        statusLabel: entry.refType,
        statusKind: entry.refType,
        description: entry.description || entry.refType,
        refType: entry.refType,
        refId: entry.refId,
        balanceAfter: entry.balanceAfter,
        time: entry.createdAt,
        createdAt: entry.createdAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'getMutationsJson error');
    res.status(500).json({ ok: false });
  }
}

// ── Rekonsiliasi Saldo QRIS ───────────────────────────────────────────────────
// Cocokkan "saldo akhir menurut catatan OrderKuota" (balanceAfter baris terbaru) dengan
// "saldo fisik" (lastQrisBalance, diintip worker tiap 2 detik). Pakai ANGKA OrderKuota sendiri
// -> nol risiko selisih pembulatan. Dua sinyal:
//  (1) Ekor: balanceAfter baris terbaru == saldo fisik? -> deteksi mutasi TERBARU belum tertarik.
//  (2) Lonjakan NAIK: saldo tiba-tiba naik antar-baris tanpa baris pencatat (uang masuk hilang).
//      Penurunan diabaikan karena itu Pencairan/settlement (OrderKuota catat pencairan sbg baris net-0
//      sehingga saldo turun tanpa mengubah balanceBefore/After baris itu -> WAJAR, bukan data hilang).
async function computeWalletReconcileForAccount(
  account: { id: string; code: string; merchantName: string | null },
  walletCategory: string,
  physicalBalance: number | null,
) {
  const rows = await db.mutation.findMany({
    where: { qrisAccountId: account.id, walletCategory },
    orderBy: { transactionTime: 'asc' },
    take: 3000,
    select: { balanceBefore: true, balanceAfter: true, transactionTime: true, amount: true, type: true, rawDataJson: true },
  });
  const physical = typeof physicalBalance === 'number' ? physicalBalance : 0;
  const base = {
    accountId: account.id,
    code: account.code,
    merchant: account.merchantName ?? null,
    physicalBalance: physical,
    rowsChecked: rows.length,
  };
  if (rows.length === 0) {
    // Tak ada baris: cocok hanya jika saldo fisik juga 0; kalau ada saldo tapi 0 baris -> belum bisa diverifikasi.
    const okEmpty = physical === 0;
    return { ...base, computedBalance: physical, diff: 0, match: okEmpty, status: okEmpty ? 'match' : 'no_data', gap: null };
  }
  const newestAfter = rows[rows.length - 1].balanceAfter ?? 0;
  const tailDiff = physical - newestAfter;
  // Cari lonjakan NAIK pertama (saldo masuk tanpa baris = mutasi masuk hilang).
  let upwardGap: { jump: number; atTime: Date; keterangan: string } | null = null;
  for (let i = 1; i < rows.length; i++) {
    const prevAfter = rows[i - 1].balanceAfter ?? 0;
    const curBefore = rows[i].balanceBefore ?? 0;
    if (curBefore > prevAfter) {
      const raw = parseRawMutationPayload(rows[i].rawDataJson);
      upwardGap = {
        jump: curBefore - prevAfter,
        atTime: rows[i].transactionTime,
        keterangan: readString(raw.keterangan) || readString(raw.description) || '',
      };
      break;
    }
  }
  const match = tailDiff === 0 && !upwardGap;
  return {
    ...base,
    computedBalance: newestAfter,
    diff: tailDiff,
    match,
    status: match ? 'match' : 'mismatch',
    missingRecent: tailDiff !== 0 ? tailDiff : 0,
    gap: upwardGap,
  };
}

// ── Rekonsiliasi Madera (feed-vs-DB) ──────────────────────────────────────────
// Madera TIDAK punya saldo per baris dari provider -> metode rantai/agregat TIDAK dipakai
// (feed cuma window beberapa hari, saldo awal window tak diketahui -> false-alarm).
// Metode JUJUR: tarik feed app Madera live -> tiap baris hitung rawHash (rumus sama dgn persist)
// -> cek apakah sudah ada di DB. Baris feed yg BELUM ada di DB = mutasi ketinggalan tarik.
// Bonus: menangkap kasus topup+BIFAST yg net-saldo-nol dalam 1 window (trigger worker tak nyala).
// Feed Madera (madera_history) SENSITIF -> bisa balas "Feature Not Allowed At This Time" kalau sering.
// Cache 60s + pemanggilan HANYA on-demand (tombol di UI) supaya tidak rebutan endpoint dgn worker.
const maderaReconcileCache = new Map<string, { ts: number; result: Record<string, unknown> }>();
const MADERA_RECONCILE_TTL_MS = 60000;
async function computeMaderaReconcileForAccount(
  account: { id: string; code: string; merchantName: string | null; lastMaderaBalance: number | null; sessionTokenEncrypted: string | null },
) {
  const physical = typeof account.lastMaderaBalance === 'number' ? account.lastMaderaBalance : 0;
  const base = { accountId: account.id, code: account.code, merchant: account.merchantName ?? null, physicalBalance: physical, walletKind: 'madera' };
  if (!account.sessionTokenEncrypted) {
    return { ...base, match: false, status: 'no_data', feedCount: 0, missingCount: 0, missing: [], okText: null, detailText: 'Akun tanpa sesi app-API, tak bisa diverifikasi.' };
  }
  const cached = maderaReconcileCache.get(account.id);
  if (cached && (Date.now() - cached.ts) < MADERA_RECONCILE_TTL_MS) {
    return cached.result;
  }
  let feed: any;
  try {
    feed = await (appGateway as any).fetchMaderaTransactionHistory(
      account,
    );
  }
  catch (err) {
    return { ...base, match: false, status: 'error', feedCount: 0, missingCount: 0, missing: [], okText: null, detailText: 'Gagal ambil feed Madera (bridge/app-API). Coba lagi.' };
  }
  if (!feed || !feed.ok) {
    return { ...base, match: false, status: 'error', feedCount: 0, missingCount: 0, missing: [], okText: null, detailText: (feed && feed.message) || 'Feed Madera tak tersedia.' };
  }
  const items: any[] = Array.isArray(feed.items) ? feed.items : [];
  const mapped = items
    .map((it) => mapMaderaFeedItem(account.id, it))
    .filter((m): m is NonNullable<ReturnType<typeof mapMaderaFeedItem>> => Boolean(m));
  const hashes = mapped.map((m) => m.rawHash);
  let existing = new Set<string>();
  if (hashes.length > 0) {
    const rows = await db.mutation.findMany({ where: { rawHash: { in: hashes } }, select: { rawHash: true } });
    existing = new Set(rows.map((r) => r.rawHash));
  }
  const missing = mapped
    .filter((m) => !existing.has(m.rawHash))
    .map((m) => ({ amount: m.amount, type: m.type, description: m.description, time: m.transactionTime }));
  const match = missing.length === 0;
  const result = {
    ...base,
    match,
    status: match ? 'match' : 'mismatch',
    feedCount: mapped.length,
    missingCount: missing.length,
    missing: missing.slice(0, 5),
    okText: 'Semua ' + mapped.length + ' mutasi Madera dari app sudah tertarik ke sistem.',
    detailText: match ? null : (missing.length + ' mutasi di app Madera belum tertarik ke sistem — worker akan menarik saat saldo berubah.'),
  };
  maderaReconcileCache.set(account.id, { ts: Date.now(), result });
  return result;
}

export async function getQrisReconcileApi(req: Request, res: Response): Promise<void> {
  try {
    // Wallet mana yang dicocokkan: 'qris' (default), 'utama', atau 'madera'.
    // qris/utama pakai rantai balanceAfter provider vs saldo fisik.
    // madera pakai feed-vs-DB (saldo per baris tak ada dari provider).
    const wallet = req.query.wallet === 'utama' ? 'utama' : (req.query.wallet === 'madera' ? 'madera' : 'qris');
    const accountSelect = { id: true, code: true, merchantName: true, lastQrisBalance: true, lastMainBalance: true, lastMaderaBalance: true, sessionTokenEncrypted: true } satisfies Prisma.QrisAccountSelect;
    const computeOne = (acc: ReconcileAccount) => wallet === 'madera'
      ? computeMaderaReconcileForAccount(acc)
      : computeWalletReconcileForAccount(acc, wallet, wallet === 'utama' ? acc.lastMainBalance : acc.lastQrisBalance);
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : null;
    if (accountId) {
      const account = await db.qrisAccount.findUnique({
        where: { id: accountId },
        select: accountSelect,
      });
      if (!account) {
        res.status(404).json({ ok: false, error: 'Akun tidak ditemukan' });
        return;
      }
      const result = await computeOne(account);
      res.json({ ok: true, wallet, account: result });
      return;
    }
    const accounts = await db.qrisAccount.findMany({
      where: { status: 'active' },
      orderBy: { code: 'asc' },
      select: accountSelect,
    });
    const results = await Promise.all(accounts.map((a) => computeOne(a)));
    // 'no_data' & 'error' = tak bisa diverifikasi -> JANGAN dihitung sebagai selisih (bukan bukti data hilang).
    const mismatches = results.filter((r) => !r.match && r.status !== 'no_data' && r.status !== 'error');
    res.json({
      ok: true,
      wallet,
      accounts: results,
      summary: {
        total: results.length,
        match: results.filter((r) => r.match).length,
        mismatch: mismatches.length,
        noData: results.filter((r) => r.status === 'no_data' || r.status === 'error').length,
        allMatch: mismatches.length === 0,
      },
    });
  } catch (err) {
    logger.error({ err }, 'getQrisReconcileApi error');
    res.status(500).json({ ok: false });
  }
}

type ReconcileAccount = {
  id: string;
  code: string;
  merchantName: string | null;
  lastQrisBalance: number | null;
  lastMainBalance: number | null;
  lastMaderaBalance: number | null;
  sessionTokenEncrypted: string | null;
};

// ── Status transaksi Generate QR (untuk polling live PAID/EXPIRED di halaman) ──
export async function getGenerateQrStatusApi(req: Request, res: Response): Promise<void> {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    if (!id) {
      res.status(400).json({ ok: false, error: 'id wajib' });
      return;
    }
    const tx = await db.transaction.findUnique({
      where: { id },
      select: { statusPay: true, paidAt: true, expiresAt: true, finalAmount: true },
    });
    if (!tx) {
      res.status(404).json({ ok: false, error: 'Transaksi tidak ditemukan' });
      return;
    }
    res.json({
      ok: true,
      status: tx.statusPay,
      paidAt: tx.paidAt ? tx.paidAt.toISOString() : null,
      expiresAt: tx.expiresAt.toISOString(),
      finalAmount: tx.finalAmount,
    });
  } catch (err) {
    logger.error({ err }, 'getGenerateQrStatusApi error');
    res.status(500).json({ ok: false });
  }
}

// ── Akun Alias (RBAC per-menu, master-only) ───────────────────────────────────
export async function showAkunAlias(req: Request, res: Response): Promise<void> {
  try {
    const accounts = listAccounts(req.session.user as AccessUser | undefined);
    res.render('settings/akun-alias', {
      title: 'Akun Alias',
      menuDefs: MENU_DEFS,
      accounts,
      sites: listSites(),
    });
  } catch (err) {
    logger.error({ err }, 'showAkunAlias error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function getAliasAccountsApi(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, accounts: listAccounts(req.session.user as AccessUser | undefined), menuDefs: MENU_DEFS });
  } catch (err) {
    logger.error({ err }, 'getAliasAccountsApi error');
    res.status(500).json({ ok: false, error: 'Gagal memuat akun' });
  }
}

export async function createAliasApi(req: Request, res: Response): Promise<void> {
  try {
    const b = req.body || {};
    await createAlias({ username: b.username, name: b.name, password: b.password, perms: b.perms || {}, siteScope: b.siteScope });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal membuat akun' });
  }
}

export async function updateAliasApi(req: Request, res: Response): Promise<void> {
  try {
    const username = String(req.params.username || '');
    if (username.toLowerCase() === 'harywang') {
      res.status(400).json({ ok: false, error: 'Akun master tidak bisa diubah di sini' });
      return;
    }
    const b = req.body || {};
    await updateAlias(username, { name: b.name, password: b.password, perms: b.perms, siteScope: b.siteScope });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal update akun' });
  }
}

export async function deleteAliasApi(req: Request, res: Response): Promise<void> {
  try {
    const username = String(req.params.username || '');
    if (username.toLowerCase() === 'harywang') {
      res.status(400).json({ ok: false, error: 'Akun master tidak bisa dihapus' });
      return;
    }
    deleteAlias(username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Gagal hapus akun' });
  }
}

// ── Settlement ────────────────────────────────────────────────────────────────
export async function showSettlement(req: Request, res: Response): Promise<void> {
  try {
    await reconcileProcessingMaderaTransfers().catch((err) => {
      logger.warn({ err }, 'showSettlement: unable to reconcile processing madera transfers');
    });
    const [{ settlements, total }, utamaBalance, maderaBalance, doneAgg, rawAccounts] = await Promise.all([
      listSettlements({ limit: 100 }),
      getWalletBalance('utama'),
      getWalletBalance('madera'),
      db.settlementRequest.aggregate({
        where: { status: 'done' },
        _sum: { amount: true },
      }),
      db.qrisAccount.findMany({
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          merchantName: true,
          status: true,
          lastQrisBalance: true,
          lastMainBalance: true,
          lastMaderaBalance: true,
          lastBalanceSyncAt: true,
          lastBalanceSyncStatus: true,
          dailyLimit: true,
          usedToday: true,
          sessionTokenEncrypted: true,
          cookiesEncrypted: true,
          deviceId: true,
          transferPinEncrypted: true,
        },
      }),
    ]);
    // Penerimaan QRIS hari ini (WIB) per akun — untuk Limit Harian (basis PAID, bukan generated).
    const _todayWibStart = new Date(Math.floor((Date.now() + 25200000) / 86400000) * 86400000 - 25200000);
    // Limit Harian (Diterima) = SEMUA uang masuk QRIS hari ini (WIB) = paid + pending (mutasi kredit).
    const _paidTodayMap = await qrisReceivedTodayMap();
    let inferredMaderaAggregate = 0;
    // Fase 6: alias-tenant -> hanya akun site-nya. Fase 5: siteName tiap akun.
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const scopedRawAccounts = _scopeIds ? rawAccounts.filter((a) => _scopeIds.includes(a.id)) : rawAccounts;
    const _siteResolve = buildResolver();
    const accounts = await Promise.all(scopedRawAccounts.map(async (account) => {
      let withdrawEnabled: boolean | null = null;
      let withdrawMin = 1000;
      let withdrawMax = 10000000;
      let withdrawMessage: string | null = null;
      let nextMaderaBalance = account.lastMaderaBalance;
      if (account.sessionTokenEncrypted) {
        try {
          const [terms, maderaOverview] = await Promise.all([
            appGateway.fetchQrisWithdrawTerms(account),
            appGateway.fetchMaderaTransferOverview(account).catch(() => null),
          ]);
          if (terms) {
            withdrawEnabled = terms.isEnabled;
            withdrawMin = terms.min > 0 ? terms.min : withdrawMin;
            withdrawMax = terms.max > 0 ? terms.max : withdrawMax;
            withdrawMessage = terms.message ?? null;
          }
          else {
            withdrawMessage = 'Belum bisa membaca info tarik saldo dari akun ini.';
          }
          if (maderaOverview?.accountBalance !== null && maderaOverview?.accountBalance !== undefined) {
            nextMaderaBalance = maderaOverview.accountBalance;
            if (maderaOverview.accountBalance !== account.lastMaderaBalance) {
              await db.qrisAccount.update({
                where: { id: account.id },
                data: {
                  lastMaderaBalance: maderaOverview.accountBalance,
                  lastBalanceSyncAt: new Date(),
                  lastBalanceSyncStatus: 'live',
                  lastBalanceSyncError: null,
                },
              }).catch(() => { });
            }
          }
        }
        catch (err) {
          withdrawMessage = err instanceof Error ? err.message : 'Gagal membaca info tarik saldo.';
        }
      }
      else {
        withdrawMessage = 'Session Token belum tersedia.';
      }
      if (nextMaderaBalance === null || nextMaderaBalance === undefined) {
        try {
          const inferred = await inferMaderaStateFromAppHistory(account);
          if (typeof inferred.balance === 'number') {
            nextMaderaBalance = inferred.balance;
            await db.qrisAccount.update({
              where: { id: account.id },
              data: {
                lastMaderaBalance: inferred.balance,
                lastBalanceSyncAt: new Date(),
                lastBalanceSyncStatus: 'partial',
                lastBalanceSyncError: inferred.note,
              },
            });
          }
        }
        catch (err) {
          logger.warn({ err, accountCode: account.code }, 'showSettlement: unable to infer madera balance');
        }
      }
      inferredMaderaAggregate += nextMaderaBalance ?? 0;
      return {
        id: account.id,
        code: account.code,
        merchantName: account.merchantName,
        siteName: _siteResolve(account.id).siteName,
        lastQrisBalance: account.lastQrisBalance,
        lastMainBalance: account.lastMainBalance,
        lastMaderaBalance: nextMaderaBalance,
        lastBalanceSyncAt: account.lastBalanceSyncAt,
        lastBalanceSyncStatus: account.lastBalanceSyncStatus,
        dailyLimit: account.dailyLimit,
        usedToday: _paidTodayMap[account.id] || 0,
        hasTransferPin: Boolean(account.transferPinEncrypted),
        withdrawEnabled,
        withdrawMin,
        withdrawMax,
        status: account.status,
        withdrawMessage,
      };
    }));
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    // Total saldo gabungan (SUM akun ter-scope; aman utk alias-tenant -> hanya site-nya).
    const walletTotals = accounts.reduce((t, a) => {
      t.qris += Number(a.lastQrisBalance || 0);
      t.utama += Number(a.lastMainBalance || 0);
      t.madera += Number(a.lastMaderaBalance || 0);
      return t;
    }, { qris: 0, utama: 0, madera: 0 } as { qris: number; utama: number; madera: number; grand?: number });
    walletTotals.grand = walletTotals.qris + walletTotals.utama + walletTotals.madera;
    res.render('settlement/index', {
      title: 'Saldo Per Akun',
      sites,
      walletTotals,
      settlements,
      total,
      accounts,
      balances: { utama: utamaBalance, madera: inferredMaderaAggregate || maderaBalance },
      totalSettled: doneAgg._sum.amount ?? 0,
      flash: res.locals.flash,
    });
  } catch (err) {
    logger.error({ err }, 'showSettlement error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── Account Transfer API (JSON) ────────────────────────────────────────────────
const AccountTransferSchema = z.object({
  fromWallet: z.enum(['qris', 'utama', 'madera']),
  toWallet: z.enum(['utama', 'madera', 'bank']),
  amount: z.number().int().min(1000, 'Minimal transfer Rp 1.000'),
  qrisAccountId: z.string().optional(),
  bankCode: z.string().max(50).optional(),
  bankAccount: z.string().max(50).optional(),
  bankName: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
});
const SettlementBankInquirySchema = z.object({
  fromWallet: z.enum(['utama', 'madera']),
  qrisAccountId: z.string().min(1, 'Akun merchant wajib dipilih'),
  bankCode: z.string().trim().min(1, 'Bank wajib dipilih').max(50),
  bankAccount: z.string().trim().min(4, 'Nomor rekening terlalu pendek').max(50),
  amount: z.number().int().min(0).max(100000000).optional(),
});

export async function handleSettlementBankInquiryApi(req: Request, res: Response): Promise<void> {
  try {
    const parsed = SettlementBankInquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.json({ ok: false, error: parsed.error.errors.map((item) => item.message).join(', ') });
      return;
    }
    const result = await inquireSettlementBankAccount(parsed.data);
    res.json({
      ok: true,
      data: result,
    });
  } catch (err) {
    logger.error({ err }, 'handleSettlementBankInquiryApi error');
    const msg = err instanceof Error ? err.message : 'Gagal melakukan inquiry rekening';
    res.json({ ok: false, error: msg });
  }
}

export async function handleAccountTransferApi(req: Request, res: Response): Promise<void> {
  try {
    const parsed = AccountTransferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.errors.map((e) => e.message).join(', ') });
      return;
    }
    const { fromWallet, toWallet, amount, qrisAccountId, bankCode, bankAccount, bankName, note } = parsed.data;
    // Validate bank fields if toWallet is 'bank'
    if (toWallet === 'bank' && (!bankCode || !bankAccount)) {
      res.status(400).json({ ok: false, error: 'Kode bank dan nomor rekening wajib diisi' });
      return;
    }
    const settlementId = await createSettlement({ fromWallet, toWallet, amount, qrisAccountId, bankCode, bankAccount, bankName, note }, req.session.user?.id, req.ip);
    // Process immediately (don't wait for the sweep loop)
    const processResult = await processSettlement(settlementId);
    const settlement = await db.settlementRequest.findUnique({ where: { id: settlementId } });
    if (!settlement || settlement.status === 'failed') {
      res.json({
        ok: false,
        settlementId,
        status: settlement?.status ?? 'failed',
        error: settlement?.note || 'Transfer gagal diproses.',
      });
      return;
    }
    res.json({
      ok: true,
      settlementId,
      status: settlement?.status ?? processResult?.status ?? 'done',
      referenceNo: settlement?.referenceNo ?? processResult?.referenceNo ?? null,
      message: settlement?.note ?? processResult?.message ?? null,
      redirectUrl: processResult?.redirectUrl ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'handleAccountTransferApi error');
    const msg = err instanceof Error ? err.message : 'Gagal memproses transfer';
    res.status(500).json({ ok: false, error: msg });
  }
}

export async function handleRetryAutoPinApi(req: Request, res: Response): Promise<void> {
  try {
    const { settlementId } = req.body as { settlementId?: string };
    if (!settlementId) {
      res.status(400).json({ ok: false, error: 'settlementId wajib diisi.' });
      return;
    }
    const settlement = await db.settlementRequest.findUnique({ where: { id: settlementId } });
    if (!settlement) {
      res.status(404).json({ ok: false, error: 'Settlement tidak ditemukan.' });
      return;
    }
    if (settlement.status !== 'processing') {
      res.json({ ok: false, error: `Settlement sudah berstatus "${settlement.status}", tidak bisa retry.` });
      return;
    }
    // Extract redirect URL from note markers
    const redirectMatch = String(settlement.note || '').match(/\[\[REDIRECT_URL:(.+?)\]\]/);
    const redirectUrl = redirectMatch?.[1];
    if (!redirectUrl) {
      res.json({ ok: false, error: 'Redirect URL tidak ditemukan pada settlement ini.' });
      return;
    }
    if (!settlement.qrisAccountId) {
      res.json({ ok: false, error: 'Akun merchant tidak terkait dengan settlement ini.' });
      return;
    }
    const account = await db.qrisAccount.findUnique({
      where: { id: settlement.qrisAccountId },
      select: {
        id: true,
        code: true,
        transferPinEncrypted: true,
        cookiesEncrypted: true,
        webCookiesEncrypted: true,
        webUserAgent: true,
      },
    });
    if (!account) {
      res.json({ ok: false, error: 'Akun merchant tidak ditemukan.' });
      return;
    }
    if (!account.transferPinEncrypted) {
      res.json({ ok: false, error: 'PIN merchant belum diisi. Tambahkan PIN di menu Merchant QR.' });
      return;
    }
    const transferPin = decrypt(account.transferPinEncrypted);
    const pinResult = await appGateway.finalizeMaderaTransferPin(redirectUrl, transferPin, account);
    if (pinResult.success) {
      // Parse existing note markers to preserve fee/total
      const feeMatch = String(settlement.note || '').match(/\[\[FEE:(\d+)\]\]/);
      const totalMatch = String(settlement.note || '').match(/\[\[TOTAL:(\d+)\]\]/);
      const cleanNote = String(settlement.note || '')
        .replace(/\s*\[\[(?:FEE|TOTAL|REDIRECT_URL):.+?\]\]\s*/g, ' ')
        .replace(/\s+\|\s*$/g, '')
        .trim();
      const noteParts = [cleanNote, pinResult.message].filter(Boolean);
      if (feeMatch)
        noteParts.push(`[[FEE:${feeMatch[1]}]]`);
      if (totalMatch)
        noteParts.push(`[[TOTAL:${totalMatch[1]}]]`);
      await db.settlementRequest.update({
        where: { id: settlementId },
        data: {
          status: 'done',
          processedAt: new Date(),
          note: noteParts.join('\n') || null,
        },
      });
      await writeAuditLog(db, {
        action: 'settlement_processed',
        entityType: 'SettlementRequest',
        entityId: settlementId,
        detail: {
          mode: 'retry_auto_pin',
          accountCode: account.code,
          pinResult: pinResult.raw,
        },
        userId: req.session.user?.id,
        ip: req.ip,
      });
      res.json({
        ok: true,
        status: 'done',
        message: pinResult.message || 'Auto PIN berhasil, transfer selesai.',
      });
    }
    else {
      res.json({
        ok: false,
        status: 'processing',
        error: pinResult.message || 'Auto PIN gagal. Coba lagi atau lanjutkan manual.',
        raw: pinResult.raw,
      });
    }
  } catch (err) {
    logger.error({ err }, 'handleRetryAutoPinApi error');
    const msg = err instanceof Error ? err.message : 'Gagal retry auto PIN';
    res.status(500).json({ ok: false, error: msg });
  }
}

// ── Bank List API (for dynamic Kirim Uang bank picker) ─────────────────────────
export async function handleBankListApi(req: Request, res: Response): Promise<void> {
  try {
    const qrisAccountId = String(req.query.qrisAccountId || '');
    if (!qrisAccountId) {
      res.json({ ok: false, banks: [], error: 'qrisAccountId wajib diisi' });
      return;
    }
    const banks = (await listSettlementTransferBanks(qrisAccountId))
      .filter((bank) => bank.status === 'OPERATIONAL');
    res.json({
      ok: true,
      banks,
      balance: null,
      min: null,
      max: null,
      fee: null,
    });
  } catch (err) {
    logger.error({ err }, 'handleBankListApi error');
    res.json({ ok: true, banks: [] });
  }
}

const CreateSettlementFormSchema = z.object({
  fromWallet: z.enum(['qris', 'utama', 'madera']),
  toWallet: z.enum(['utama', 'madera', 'bank']),
  amount: z.string().transform((v) => parseInt(v.replace(/\D/g, ''), 10)),
  qrisAccountId: z.string().optional(),
  bankCode: z.string().max(50).optional(),
  bankAccount: z.string().max(50).optional(),
  bankName: z.string().max(100).optional(),
  note: z.string().max(500).optional(),
});

export async function handleCreateSettlement(req: Request, res: Response): Promise<void> {
  try {
    const parsed = CreateSettlementFormSchema.safeParse(req.body);
    if (!parsed.success) {
      req.session.flash = {
        type: 'error',
        message: 'Data tidak valid: ' + parsed.error.errors.map((e) => e.message).join(', '),
      };
      res.redirect(withBasePath('/dashboard/settlement', config.APP_BASE_PATH));
      return;
    }
    const { fromWallet, toWallet, amount, qrisAccountId, bankCode, bankAccount, bankName, note } = parsed.data;
    if (isNaN(amount) || amount < 1) {
      req.session.flash = { type: 'error', message: 'Jumlah harus berupa angka positif' };
      res.redirect(withBasePath('/dashboard/settlement', config.APP_BASE_PATH));
      return;
    }
    await createSettlement({ fromWallet, toWallet, amount, qrisAccountId, bankCode, bankAccount, bankName, note }, req.session.user?.id, req.ip);
    req.session.flash = {
      type: 'success',
      message: `Permintaan settlement Rp ${amount.toLocaleString('id-ID')} dibuat. Worker akan memprosesnya.`,
    };
    res.redirect(withBasePath('/dashboard/settlement', config.APP_BASE_PATH));
  } catch (err) {
    logger.error({ err }, 'handleCreateSettlement error');
    const msg = err instanceof Error ? err.message : 'Gagal membuat settlement';
    req.session.flash = { type: 'error', message: msg };
    res.redirect(withBasePath('/dashboard/settlement', config.APP_BASE_PATH));
  }
}

// ── Login Logs ────────────────────────────────────────────────────────────────
export async function showLoginLogs(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 100;
    const offset = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      db.loginLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { user: { select: { username: true, fullName: true } } },
      }),
      db.loginLog.count(),
    ]);
    res.render('settings/login-logs', {
      title: 'Log Login',
      logs,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error({ err }, 'showLoginLogs error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

// ── Aliases (stub) ────────────────────────────────────────────────────────────
export async function showAliases(req: Request, res: Response): Promise<void> {
  res.render('settings/aliases', { title: 'Alias Pengguna' });
}

// ── Account Settings (Webhook / Web Game / Akun QRIS) ────────────────────────
export async function checkWebGamePanelApi(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body || {};
    const platform = String(body.platform || '').trim().toLowerCase();
    const okPlatforms = ['idn', 'default', 'idntoto', 'pay4d', 'sulebet'];
    if (!okPlatforms.includes(platform)) {
      res.status(400).json({ ok: false, online: false, message: 'Tipe panel tidak valid (idn/pay4d).' });
      return;
    }
    const siteId = typeof body.siteId === 'string' ? body.siteId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) : '';
    const creds = (body.creds && typeof body.creds === 'object') ? body.creds : {};
    const projectRoot = process.cwd();
    const pyBin = (process.env.GAME_PYTHON_BIN || '/opt/ayuchenbot/venv/bin/python3');
    const script = path.join(projectRoot, 'python', 'game_panel.py');
    const sessDir = path.join(projectRoot, 'data', 'webgame-sessions');
    try { fs.mkdirSync(sessDir, { recursive: true }); } catch (e) {}
    const sessFile = siteId ? path.join(sessDir, siteId + '.json') : null;
    let cookies: Record<string, unknown> = {};
    if (sessFile) { try { cookies = (JSON.parse(fs.readFileSync(sessFile, 'utf8')).cookies) || {}; } catch (e) {} }
    const input = JSON.stringify({ platform, creds, cookies });
    const proc = spawnSync(pyBin, [script], { input, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const out = String(proc.stdout || '');
    const m = out.match(/GAMECHK_JSON_BEGIN\s*([\s\S]*?)\s*GAMECHK_JSON_END/);
    if (!m) {
      logger.warn({ stderr: String(proc.stderr || '').slice(-300), siteId }, 'checkWebGamePanelApi: no marker');
      res.json({ ok: false, online: false, message: 'Gagal menjalankan cek panel.' });
      return;
    }
    let parsed: any;
    try { parsed = JSON.parse(m[1].trim()); } catch (e) { res.json({ ok: false, online: false, message: 'Output cek tidak valid.' }); return; }
    if (sessFile && parsed.cookies && Object.keys(parsed.cookies).length) {
      try { fs.writeFileSync(sessFile, JSON.stringify({ cookies: parsed.cookies, updatedAt: new Date().toISOString() }), 'utf8'); } catch (e) {}
    }
    res.json({ ok: true, online: !!parsed.online, platform: parsed.platform || platform, message: parsed.message || '' });
  } catch (err) {
    logger.error({ err }, 'checkWebGamePanelApi error');
    res.status(500).json({ ok: false, online: false, message: 'Error internal saat cek panel.' });
  }
}

export async function showAccountSettings(req: Request, res: Response): Promise<void> {
  try {
    const qrisAccounts = await db.qrisAccount.findMany({
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true, status: true },
    });
    res.render('settings/account', { title: 'Pengaturan Akun', qrisAccounts });
  } catch (err) {
    logger.error({ err }, 'showAccountSettings error');
    res.render('settings/account', { title: 'Pengaturan Akun', qrisAccounts: [] });
  }
}

// ── QRIS Accounts JSON (for per-account mutation tabs) ────────────────────────
export async function getQrisAccountsJson(req: Request, res: Response): Promise<void> {
  try {
    const accounts = await db.qrisAccount.findMany({
      where: { status: 'active' },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        merchantName: true,
        orkutAccountIndex: true,
        lastMainBalance: true,
        lastQrisBalance: true,
        lastMaderaBalance: true,
        lastBalanceSyncAt: true,
        lastBalanceSyncStatus: true,
        healthStatus: true,
        dailyLimit: true,
        usedToday: true,
      },
    });
    const countRows = await db.mutation.findMany({
      select: {
        qrisAccountId: true,
        amount: true,
        balanceAfter: true,
        rrn: true,
        rawDataJson: true,
        transactionTime: true,
        createdAt: true,
        type: true,
        walletCategory: true,
      },
      orderBy: { transactionTime: 'desc' },
    });
    const dedupedCountRows = dedupePresentedQrisMutations(countRows.map((row) => ({
      accountCode: row.qrisAccountId,
      amount: row.amount,
      balanceAfter: row.balanceAfter,
      bankEwallet: '',
      brandName: null,
      category: readMutationCategory(row.rawDataJson, row.walletCategory),
      createdAt: row.createdAt,
      description: '',
      displayTime: formatMutationTimestamp(row.transactionTime),
      id: row.qrisAccountId,
      issuerName: null,
      matched: false,
      merchant: '',
      rawDataJson: row.rawDataJson,
      rrn: row.rrn,
      senderName: '',
      source: 'qris',
      statusCode: row.type === 'credit' ? 'IN' : 'OUT',
      statusKind: 'count',
      statusLabel: 'count',
      statusText: row.type === 'credit' ? 'Dana Masuk' : 'Dana Keluar',
      time: row.transactionTime,
      type: row.type,
    })));
    const countMap = dedupedCountRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.accountCode] = (acc[row.accountCode] ?? 0) + 1;
      return acc;
    }, {});
    res.json({
      ok: true,
      accounts: accounts.map((a, idx) => ({
        id: a.id,
        code: a.code,
        label: `Akun ${idx + 1}`,
        merchantName: a.merchantName,
        orkutAccountIndex: a.orkutAccountIndex,
        lastMainBalance: a.lastMainBalance,
        lastQrisBalance: a.lastQrisBalance,
        lastMaderaBalance: a.lastMaderaBalance,
        lastBalanceSyncAt: a.lastBalanceSyncAt,
        lastBalanceSyncStatus: a.lastBalanceSyncStatus,
        healthStatus: a.healthStatus,
        dailyLimit: a.dailyLimit,
        usedToday: a.usedToday,
        mutationCount: countMap[a.id] ?? 0,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'getQrisAccountsJson error');
    res.status(500).json({ ok: false });
  }
}

// ── Generate QR Page ──────────────────────────────────────────────────────────
const RefreshWalletSchema = z.object({
  wallet: z.enum(['qris', 'utama', 'madera']),
});

export async function handleRefreshAccountBalanceApi(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.params.id === 'string' ? req.params.id : '';
    const parsed = RefreshWalletSchema.safeParse(req.body ?? {});
    if (!accountId || !parsed.success) {
      res.status(400).json({ ok: false, error: 'Permintaan refresh saldo tidak valid.' });
      return;
    }
    const account = await db.qrisAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      res.status(404).json({ ok: false, error: 'Merchant tidak ditemukan.' });
      return;
    }
    const wallet = parsed.data.wallet;
    let nextMainBalance = account.lastMainBalance;
    let nextQrisBalance = account.lastQrisBalance;
    let nextMaderaBalance = account.lastMaderaBalance;
    let nextStatus = account.lastBalanceSyncStatus ?? 'synced';
    let nextError: string | null = null;
    if (wallet === 'qris' || wallet === 'utama') {
      // App-API DULU (fetchAccountSummary bebas-limit via bridge). Web report keblok 469 dari IP VPS,
      // jadi hanya dipakai kalau app-API tak tersedia (tak ada session token).
      if (account.sessionTokenEncrypted) {
        const summary = await appGateway.fetchAccountSummary(account);
        if (wallet === 'qris') {
          nextQrisBalance = summary.qrisBalance ?? nextQrisBalance;
          nextStatus = summary.qrisBalance !== null ? 'synced' : 'partial';
          nextError = summary.qrisBalance !== null ? null : 'Provider belum mengirim saldo QRIS terbaru.';
        }
        else {
          nextMainBalance = summary.mainBalance ?? nextMainBalance;
          nextStatus = summary.mainBalance !== null ? 'synced' : 'partial';
          nextError = summary.mainBalance !== null ? null : 'Provider belum mengirim saldo utama terbaru.';
        }
        await db.qrisAccount.update({
          where: { id: account.id },
          data: {
            lastMainBalance: nextMainBalance,
            lastQrisBalance: nextQrisBalance,
            lastBalanceSyncAt: new Date(),
            lastBalanceSyncStatus: nextStatus,
            lastBalanceSyncError: nextError,
          },
        });
      }
      else if (account.webCookiesEncrypted || account.cookiesEncrypted) {
        const reportStats = await syncMerchantMutationsFromReport(account, wallet);
        nextMainBalance = reportStats.mainBalance ?? nextMainBalance;
        nextQrisBalance = reportStats.qrisBalance ?? nextQrisBalance;
        nextStatus = 'synced';
        nextError = null;
      }
      else {
        res.status(400).json({ ok: false, error: 'Session token atau Web Session Cookie merchant belum diisi.' });
        return;
      }
    }
    else {
      await reconcileProcessingMaderaTransfers(account.id).catch((err) => {
        logger.warn({ err, accountCode: account.code }, 'handleRefreshAccountBalanceApi: unable to reconcile madera transfers');
      });
      let snapshot: Awaited<ReturnType<typeof syncOrkutBalanceSnapshot>> | null = null;
      if (account.sessionTokenEncrypted) {
        const [overview, history] = await Promise.all([
          appGateway.fetchMaderaTransferOverview(account).catch(() => null),
          appGateway.fetchBalanceHistory(account).catch(() => null),
        ]);
        if (overview?.accountBalance !== null && overview?.accountBalance !== undefined) {
          nextMaderaBalance = overview.accountBalance;
          nextStatus = 'synced';
          nextError = null;
        }
        if (history) {
          nextMainBalance = history.mainBalance ?? nextMainBalance;
          for (const mutation of history.mutations) {
            await storeMutationIfNew({
              qrisAccountId: account.id,
              amount: mutation.amount,
              type: mutation.type,
              balanceBefore: mutation.balanceBefore,
              balanceAfter: mutation.balanceAfter,
              issuerName: mutation.issuerName ?? null,
              rrn: mutation.rrn ?? null,
              walletCategory: mutation.walletCategory ?? null,
              transactionTime: mutation.transactionTime,
              rawHash: mutation.rawHash,
              rawDataJson: mutation.rawDataJson,
            }).catch(() => null);
          }
        }
      }
      if (nextMaderaBalance === null || nextMaderaBalance === undefined) {
        const activeAccounts = await db.qrisAccount.findMany({
          where: { status: 'active' },
          orderBy: { code: 'asc' },
          select: { id: true },
        });
        const fallbackIndex = activeAccounts.findIndex((row) => row.id === account.id) + 1;
        const resolvedIndex = resolveOrkutAccountIndex(account, fallbackIndex > 0 ? fallbackIndex : 1);
        snapshot = await syncOrkutBalanceSnapshot(account, resolvedIndex);
        if (snapshot) {
          nextMainBalance = snapshot.mainBalance ?? nextMainBalance;
          nextQrisBalance = snapshot.qrisBalance ?? nextQrisBalance;
          nextMaderaBalance = snapshot.maderaBalance ?? nextMaderaBalance;
          nextStatus = snapshot.status;
          nextError = snapshot.errorMessage ?? null;
        }
      }
      if (nextMaderaBalance === null || nextMaderaBalance === undefined) {
        const inferred = await inferMaderaStateFromAppHistory(account);
        if (typeof inferred.balance === 'number') {
          nextMaderaBalance = inferred.balance;
          nextStatus = snapshot?.status ?? 'partial';
          nextError = inferred.note;
        }
      }
      await db.qrisAccount.update({
        where: { id: account.id },
        data: {
          lastMainBalance: nextMainBalance,
          lastQrisBalance: nextQrisBalance,
          lastMaderaBalance: nextMaderaBalance,
          lastBalanceSyncAt: new Date(),
          lastBalanceSyncStatus: nextStatus,
          lastBalanceSyncError: nextError,
        },
      });
    }
    res.json({
      ok: true,
      wallet,
      account: {
        id: account.id,
        code: account.code,
        merchantName: account.merchantName,
        lastMainBalance: nextMainBalance,
        lastQrisBalance: nextQrisBalance,
        lastMaderaBalance: nextMaderaBalance,
        lastBalanceSyncAt: new Date().toISOString(),
        lastBalanceSyncStatus: nextStatus,
        lastBalanceSyncError: nextError,
      },
    });
  } catch (err) {
    logger.error({ err, accountId: req.params.id }, 'handleRefreshAccountBalanceApi error');
    res.status(500).json({ ok: false, error: 'Gagal me-refresh saldo akun.' });
  }
}

export async function showGenerateQr(req: Request, res: Response): Promise<void> {
  try {
    const accountsRaw = await db.qrisAccount.findMany({
      where: {
        status: 'active',
        OR: [
          { sessionTokenEncrypted: { not: null } },
          { qrisPayload: { not: null } },
        ],
      },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true },
    });
    // Fase 4: sematkan site tiap akun + daftar site utk selektor "wajib pilih Site".
    let accounts = attachSiteInfo(accountsRaw);
    let sites = listSites();
    // Fase 6: alias-tenant -> hanya site & akun miliknya.
    const _scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    if (_scope) {
      accounts = accounts.filter((a) => a.siteId === _scope);
      sites = sites.filter((s) => s.id === _scope);
    }
    const hasUnassigned = _scope ? false : accounts.some((a) => !a.siteId);
    res.render('generate-qr/index', { title: 'Generate QR', accounts, sites, hasUnassigned });
  } catch (err) {
    logger.error({ err }, 'showGenerateQr error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

const DashboardGenerateQrSchema = z.object({
  accountId: z.string().min(1, 'Akun QRIS wajib dipilih'),
  amount: z.number().int().min(1, 'Nominal minimal Rp 1').max(10000000, 'Nominal terlalu besar'),
  username: z.string().trim().min(1, 'Username wajib diisi').max(100, 'Username terlalu panjang'),
});

export async function handleDashboardGenerateQr(req: Request, res: Response): Promise<void> {
  try {
    const parsed = DashboardGenerateQrSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: parsed.error.errors.map((item) => item.message).join(', '),
      });
      return;
    }
    // Fase 6: alias-tenant tak boleh generate di akun luar site-nya.
    if (!accountInScope(req.session.user as AccessUser | undefined, parsed.data.accountId)) {
      res.status(403).json({ ok: false, error: 'Akun di luar site Anda.' });
      return;
    }
    const result = await generateDashboardQrTransaction({
      ...parsed.data,
      createdBy: req.session.user?.username || 'dashboard',
    });
    res.status(201).json({
      ok: true,
      data: result,
    });
  } catch (err) {
    logger.error({ err }, 'handleDashboardGenerateQr error');
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Gagal membuat transaksi QR',
    });
  }
}

export async function getQrisTemplate(req: Request, res: Response): Promise<void> {
  try {
    const accountId = req.query.accountId as string;
    if (!accountId) {
      res.status(400).json({ ok: false, error: 'accountId required' });
      return;
    }
    // Fase 6: alias-tenant hanya boleh akun site-nya.
    if (!accountInScope(req.session.user as AccessUser | undefined, accountId)) {
      res.status(403).json({ ok: false, error: 'Akun di luar site Anda' });
      return;
    }
    const account = await db.qrisAccount.findUnique({ where: { id: accountId } });
    if (!account || account.status !== 'active') {
      res.status(404).json({ ok: false, error: 'Akun tidak ditemukan atau tidak aktif' });
      return;
    }
    // Try live API first, fall back to stored qrisPayload
    let qrisData: string | null = null;
    let min = 1, max = 10000000, expired = 300;
    if (account.sessionTokenEncrypted) {
      const result = await appGateway.fetchQrisMerchantTerms(account);
      if (result) {
        qrisData = result.qrisData;
        min = result.min;
        max = result.max;
        expired = result.expired;
        // Keep stored payload fresh
        if (account.qrisPayload !== qrisData) {
          db.qrisAccount.update({ where: { id: account.id }, data: { qrisPayload: qrisData } }).catch(() => { });
        }
      }
    }
    // Fallback to stored payload
    if (!qrisData && account.qrisPayload) {
      qrisData = account.qrisPayload;
      logger.info({ accountCode: account.code }, 'getQrisTemplate: using stored qrisPayload as fallback');
    }
    if (!qrisData) {
      res.status(502).json({ ok: false, error: 'QRIS template tidak tersedia. Pastikan akun memiliki token atau QRIS payload tersimpan.' });
      return;
    }
    res.json({
      ok: true,
      qrisData,
      min,
      max,
      expired,
      merchantName: account.merchantName,
      code: account.code,
    });
  } catch (err) {
    logger.error({ err }, 'getQrisTemplate error');
    res.status(500).json({ ok: false });
  }
}
