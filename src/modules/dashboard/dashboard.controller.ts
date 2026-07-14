import { Request, Response } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import type { OutboxEvent, QrisAccount, Prisma } from '@prisma/client';
import { config } from '../../config';
import { db, dbRead } from '../../config/database';
import { qrisReceivedTodayMap } from '../../shared/daily-usage.service';
import { selectQrisAccountForSite, NoEligibleAccountError } from '../../shared/qris-account-selector';
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
import { writeAuditLog, logAction } from '../../shared/audit-log.service';
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
  fetchReportWalletLive,
} from '../../shared/orderkuota-report-python.service';
import { appGateway, type AppQrisMutationDetail } from '../../shared/gateways/app-orkut.gateway';
import {
  enrichPresentedQrisMutationsWithAppDetails,
  mergeRawMutationWithAppDetail,
  readPresentedMutationRawId,
} from '../../shared/orkut-app-detail.service';
import { publishMutationUpdated, storeMutationIfNew, canonicalMutationHash } from '../../shared/mutation-ingest.service';
import { crossDayPendingBooking } from '../../shared/pending-money.service';
import { listOutboxEventsSince, parseOutboxPayload } from '../../shared/outbox.service';
import { generateDashboardQrTransaction } from '../../shared/dashboard-generate-qr.service';
import { attemptDeposit, manualCreditDeposit } from '../../shared/deposit.service';
import { readWebgameSites, writeWebgameSites } from '../../shared/webgame-sites.service';
import { listBanks, listBanksForScope, getBankById, createBank, updateBank, deleteBank } from '../../shared/site-bank.service';
import { readNagoxTransfers, getNagoxTransfer, setNagoxTransfer, callNagoxTransfer } from '../../shared/nagox-transfer.service';
import type { NagoxTfStatus } from '../../shared/nagox-transfer.service';
import { resolveListCutoffDate, isShowAll } from '../../shared/operational-cutoff.service';
import { mapMaderaFeedItem } from '../../shared/madera-history.service';
import {
  getSiteScopeForUser,
  listAccounts,
  createAlias,
  updateAlias,
  deleteAlias,
  isMasterUser,
  canDo,
  getMenuPermsForUser,
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
  if (value === 'today' || value === 'yesterday' || value === '7d' || value === '30d' || value === 'custom' || value === 'all') {
    return value;
  }
  return 'today';
}

function getTransactionDateRange(query: Request['query']) {
  let period = normalizeTransactionPeriod(query.period);
  // Safety: kalau tanggal custom (from/to) diisi tapi 'period' tak dikirim (mis. via tombol Filter),
  // perlakukan sebagai custom -> tanggal tak diabaikan (cegah bug filter tanggal custom).
  if (!query.period && (query.from || query.to)) period = 'custom';
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

const _WIB_DATE_FMT = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Bangkok' });
const _WIB_TIME_FMT = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });
function formatMutationTimestamp(value: Date): string {
  // OPTIMASI: formatter Intl di-cache (dibuat 1x), bukan toLocale* yg bikin formatter baru tiap panggil
  // (bergantian date/time = cache-thrash V8 → ~5 detik utk 5000 baris). Output IDENTIK dgn versi lama.
  return _WIB_DATE_FMT.format(value) + ' ' + _WIB_TIME_FMT.format(value);
}
// Nama pengirim dari mutasi bayar: keterangan 'NOBU / NAMA' -> ambil ekor sesudah '/'.
function extractSenderName(rawDataJson: string | null | undefined): string | null {
  if (!rawDataJson) return null;
  try {
    const raw = JSON.parse(rawDataJson) as Record<string, unknown>;
    const direct = (raw.sender_name ?? raw.senderName) as string | undefined;
    if (direct && String(direct).trim()) return String(direct).trim();
    const ket = String((raw.keterangan ?? raw.description ?? raw.buyer_ref ?? '') as string);
    const parts = ket.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts.slice(1).join(' / ');
    return null;
  } catch { return null; }
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

// Cache ringkasan saldo: dipanggil tiap response /api/mutations (poll 10 dtk), padahal
// hanya berubah saat worker sync. TTL pendek -> hemat 1 query per poll tanpa terasa basi.
const QRIS_BALANCE_SUMMARY_TTL_MS = 5000;
let qrisBalanceSummaryCache: { at: number; value: Awaited<ReturnType<typeof computeQrisBalanceSummary>> } | null = null;

async function computeQrisBalanceSummary() {
  const db = dbRead; // pintu-baca: hindari antre di belakang tulisan
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

async function getQrisBalanceSummary() {
  const now = Date.now();
  if (qrisBalanceSummaryCache && now - qrisBalanceSummaryCache.at < QRIS_BALANCE_SUMMARY_TTL_MS) {
    return qrisBalanceSummaryCache.value;
  }
  const value = await computeQrisBalanceSummary();
  qrisBalanceSummaryCache = { at: now, value };
  return value;
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

    // RBAC SITE SCOPE (fix bug isolasi 12 Jul): alias-tenant HANYA lihat datanya sendiri.
    // master / alias "semua site" -> _scopeIds null -> tanpa filter (lihat semua).
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _txScope: Prisma.TransactionWhereInput = _scopeIds ? { qrisAccountId: { in: _scopeIds } } : {};
    const _accScope: Prisma.QrisAccountWhereInput = _scopeIds ? { id: { in: _scopeIds } } : {};

    const [
      totalToday,
      paidToday,
      activeAccounts,
      totalClients,
      failedDeposits,
      manualReview,
      queueLag,
    ] = await Promise.all([
      db.transaction.count({ where: { createdAt: { gte: todayStart, lte: todayEnd }, ..._txScope } }),
      db.transaction.count({
        where: { statusPay: 'paid', paidAt: { gte: todayStart, lte: todayEnd }, ..._txScope },
      }),
      db.qrisAccount.count({ where: { status: 'active', ..._accScope } }),
      db.client.count({ where: { status: 'active' } }),
      db.transaction.count({ where: { statusBot: 'deposit_failed', ..._txScope } }),
      db.transaction.count({ where: { statusBot: 'manual_review', ..._txScope } }),
      db.transaction.count({ where: { statusPay: 'paid', statusBot: 'deposit_queued', ..._txScope } }),
    ]);

    const paidAggregate = await db.transaction.aggregate({
      where: { statusPay: 'paid', paidAt: { gte: todayStart, lte: todayEnd }, ..._txScope },
      _sum: { finalAmount: true },
    });
    const paidAmountToday = paidAggregate._sum.finalAmount ?? 0;

    // 7-day chart data
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const recentTx = await db.transaction.findMany({
      where: { createdAt: { gte: sevenDaysAgo }, ..._txScope },
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
      where: _scopeIds ? { qrisAccountId: { in: _scopeIds } } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { name: true, panelCode: true } },
        qrisAccount: { select: { id: true, code: true, merchantName: true } },
      },
    });
    const _resolveSite = buildResolver();
    const recentTransactions = recentTransactionsRaw.map((tx) => Object.assign({}, tx, { siteName: _resolveSite(tx.qrisAccountId).siteName }));

    const qrisAccountsRaw = await db.qrisAccount.findMany({ where: _accScope, orderBy: { code: 'asc' } });
    // Limit Harian = total PAID hari ini (WIB) per akun (bukan reserve saat generate); auto-reset ganti hari.
    // Kesehatan = LIVE (computeLiveHealth), bukan snapshot basi -> normal jadi "healthy", bukan "degraded".
    const WIB_MS = 7 * 60 * 60 * 1000;
    const todayWibStart = new Date(Math.floor((Date.now() + WIB_MS) / 86400000) * 86400000 - WIB_MS);
    // Status Akun QRIS = SEMUA uang masuk QRIS hari ini (WIB) = paid + pending (mutasi kredit).
    const paidTodayMap = await qrisReceivedTodayMap();
    const _dashResolve = buildResolver();
    const qrisAccounts = qrisAccountsRaw.map((a) => { const _si = _dashResolve(a.id); return Object.assign({}, a, { usedToday: paidTodayMap[a.id] || 0, healthStatus: computeLiveHealth(a), siteName: _si.siteName, siteId: _si.siteId }); });
    // URUT KARTU: aktif & belum limit (atas) -> nonaktif belum limit -> sudah limit >=29,6jt (bawah).
    const _LIMIT_CAP = 29600000;
    const _rankLimit = (a: { usedToday?: number | null; status?: string | null }) => ((Number(a.usedToday) || 0) >= _LIMIT_CAP ? 2 : (a.status === 'active' ? 0 : 1));
    qrisAccounts.sort((x, y) => _rankLimit(x) - _rankLimit(y));
    const _dashScopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const dashSites = _dashScopeSite ? listSites().filter((s) => s.id === _dashScopeSite) : listSites();
    const dashSiteFilter = !_dashScopeSite; // filter site hanya utk master / alias-semua-site

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
      dashSites,
      dashSiteFilter,
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
  const _allowedPS = [50, 100, 200, 500];
  const _reqPS = parseInt(req.query.pageSize as string, 10);
  const limit = _allowedPS.includes(_reqPS) ? _reqPS : 50;
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
    if (statusBot === 'proses') where.statusBot = { in: ['pending', 'deposit_queued'] };
    else if (statusBot) where.statusBot = statusBot;
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
      const _kwOr: Record<string, unknown>[] = [
        { qrId: { contains: keyword, mode: 'insensitive' } },
        { userIdExt: { contains: keyword, mode: 'insensitive' } },
        { externalReference: { contains: keyword, mode: 'insensitive' } },
        { note: { contains: keyword, mode: 'insensitive' } },
        { issuerName: { contains: keyword, mode: 'insensitive' } },
        { rrn: { contains: keyword, mode: 'insensitive' } },
        { qrisAccount: { merchantName: { contains: keyword, mode: 'insensitive' } } },
        { qrisAccount: { code: { contains: keyword, mode: 'insensitive' } } },
        { client: { name: { contains: keyword, mode: 'insensitive' } } },
        { client: { panelCode: { contains: keyword, mode: 'insensitive' } } },
      ];
      const _kwDigits = keyword.replace(/[^0-9]/g, '');
      if (_kwDigits.length >= 3 && Number(_kwDigits) > 0) _kwOr.push({ finalAmount: Number(_kwDigits) });
      where.OR = _kwOr;
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
    // History Generate QR (bukan paidOnly) = mesin QR yang di-generate. Booking Uang Pending
    // TIDAK punya QR generate → sembunyikan di sini (tetap muncul di menu Transaction).
    if (!paidOnly && !statusBot) where.statusBot = { not: 'manual_booked' };
    // Sembunyikan transaksi bertanda hidden (uang nyasar site yg sudah dibereskan) kecuali Tampilkan Semua (?all=1).
    if (!isShowAll(req)) where.NOT = { metadataJson: { contains: '"hidden":true' } };

    // Mulai Operasional: sembunyikan transaksi SEBELUM cutoff (kecuali Tampilkan Semua / date-from lebih tua).
    {
      const _cut = resolveListCutoffDate(isShowAll(req));
      if (_cut) {
        const _tf = (where.createdAt as Record<string, Date>) || {};
        if (!_tf.gte || _tf.gte < _cut) _tf.gte = _cut;
        where.createdAt = _tf;
      }
    }

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
              rawDataJson: true,
            },
            orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
            take: 3,
          },
          // Waktu bot benar-benar memproses deposit (beda dari paidAt). Ambil
          // attempt sukses terakhir supaya kolom Bot bisa tampilkan jam proses.
          depositAttempts: {
            where: { status: 'success' },
            select: { createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
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
      db.qrisAccount.findMany({ where: scopeIds ? { id: { in: scopeIds } } : undefined, select: { id: true, code: true, merchantName: true }, orderBy: { code: 'asc' } }),
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
    const _pbRowsTx = await db.transaction.findMany({ where: { ...where, metadataJson: { contains: 'pending_booking' } }, select: { finalAmount: true, paidAt: true, metadataJson: true } });
    const _crossDayTx = crossDayPendingBooking(_pbRowsTx).total; // PENDING_CARRY: keluarkan pending lintas-hari dari omset
    const totalPaid = (paidAgg._sum.finalAmount ?? 0) - _crossDayTx;
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
      pageSize: limit,
      clients,
      qrisAccounts: qrisAccountsWithSite,
      sites,
      totalPaid,
      pendingCarryProcessed: _crossDayTx,
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
    // snapshot scope: alias-tenant tak boleh baca tx akun site lain via qrId (IDOR).
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const transactions = await db.transaction.findMany({
      where: _scopeIds ? { qrId: { in: qrIds }, qrisAccountId: { in: _scopeIds } } : { qrId: { in: qrIds } },
      select: {
        qrId: true,
        qrisAccountId: true,
        statusPay: true,
        statusBot: true,
        rrn: true,
        issuerName: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        depositAttempts: {
          where: { status: 'success' },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        mutations: {
          select: {
            rrn: true,
            issuerName: true,
            transactionTime: true,
            createdAt: true,
            rawDataJson: true,
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
        senderName: extractSenderName(fallbackMutation?.rawDataJson),
        paidAt: nextPaidAt,
        botProcessedAt: tx.depositAttempts?.[0]?.createdAt || (tx.statusBot === 'deposit_success' ? tx.updatedAt : null),
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
          select: { rrn: true, issuerName: true, transactionTime: true, createdAt: true, rawDataJson: true },
          orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }],
          take: 3,
        },
        depositAttempts: {
          where: { status: 'success' },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
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
        botProcessedAt: tx.depositAttempts?.[0]?.createdAt || (tx.statusBot === 'deposit_success' ? tx.updatedAt : null),
        createdAt: tx.createdAt,
        note: tx.note,
        issuerName: tx.issuerName || fb?.issuerName || null,
        senderName: extractSenderName(fb?.rawDataJson),
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
      where: {},
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        merchantName: true,
        status: true,
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
  const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined); // RBAC: alias hanya terima event live site-nya
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
      const rawEvents = await listOutboxEventsSince(cursor, lastEventId, accountId);
      if (rawEvents.length === 0) return;
      cursor = rawEvents[rawEvents.length - 1].createdAt;
      lastEventId = rawEvents[rawEvents.length - 1].id;
      const events = _scopeIds ? rawEvents.filter((e) => e.qrisAccountId != null && _scopeIds.includes(e.qrisAccountId)) : rawEvents;
      if (events.length === 0) return;
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
      where: { sessionTokenEncrypted: { not: null } },
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, merchantName: true, status: true, orkutAccountIndex: true,
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
      // SSE push: tabel di-refresh HANYA saat worker menandai mutasi baru (via OutboxEvent) -> buang poll boros.
      streamUrl: withBasePath('/dashboard/api/mutations/stream', config.APP_BASE_PATH),
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
      where: {},
      orderBy: { code: 'asc' },
      select: {
        id: true, code: true, merchantName: true, status: true, orkutAccountIndex: true,
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
      // History Transaksi Nobu: tampilkan SEMUA akun (termasuk NONAKTIF) agar kartunya tetap
      // muncul & transaksinya bisa dicek (samakan dgn menu Saldo Madera yang where:{}).
      where: {},
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true, status: true, lastMaderaBalance: true, healthStatus: true },
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
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; } // RBAC di luar scope (mutasi2)
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
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; } // RBAC di luar scope (mutasi2)
    const result = await (appGateway as any).fetchMaderaTransactionHistory(account);
    // FEED TRUNCATION FIX (14 Jul): feed app Madera hanya balikin ~halaman pertama (baris terbaru).
    // Utk akun sangat aktif (mis. DISKY CELL: 31 tx/2 hari), transaksi lebih lama tapi masih hari
    // ini/kemarin JATUH DI LUAR jendela feed -> seolah "hilang" di History Nobu walau NYATA (tertarik
    // ke DB saat masih di feed, verified Nagox). Lengkapi dgn baris DB (walletCategory='madera') yg
    // LEBIH LAMA dari baris feed tertua (tanpa overlap -> tak perlu dedup), ditandai status 'arsip'.
    // TIDAK mengubah data uang; hanya melengkapi tampilan agar konsisten dgn Mutasi Madera/DB.
    if (result && result.ok && Array.isArray(result.items)) {
      try {
        const feedMapped = (result.items as unknown[])
          .map((it) => mapMaderaFeedItem(account.id, it as Parameters<typeof mapMaderaFeedItem>[1]))
          .filter((m): m is NonNullable<ReturnType<typeof mapMaderaFeedItem>> => Boolean(m));
        const feedOldestMs = feedMapped.length ? Math.min(...feedMapped.map((m) => m.transactionTime.getTime())) : Date.now();
        const olderRows = await db.mutation.findMany({
          where: { qrisAccountId: account.id, walletCategory: 'madera', transactionTime: { lt: new Date(feedOldestMs) } },
          orderBy: { transactionTime: 'desc' },
          take: 100,
        });
        if (olderRows.length > 0) {
          const _fmtRp = (n: number) => Math.abs(Math.round(n)).toLocaleString('id-ID');
          const extras = olderRows.map((r) => {
            let raw: Record<string, unknown> = {};
            try { raw = JSON.parse(r.rawDataJson || '{}') as Record<string, unknown>; } catch { /* ignore */ }
            const dir = r.type === 'debit' ? 'out' : 'in';
            const dateStr = (typeof raw.tanggal === 'string' && raw.tanggal) || r.transactionTime.toISOString();
            return {
              type: r.type, direction: dir, amount: _fmtRp(r.amount), status: 'arsip',
              description: String(raw.keterangan || raw.description || ''),
              date: dateStr, icon: (raw.icon as string) || null, fromArchive: true,
            };
          });
          result.items = result.items.concat(extras);
          const _oldestDate = String(extras[extras.length - 1].date || '').split('@')[0].trim();
          if (_oldestDate) result.fromDate = _oldestDate;
        }
      } catch (mergeErr) {
        logger.warn({ err: mergeErr, accountId: account.id }, 'getMaderaNobuHistoryApi: gagal lengkapi baris DB (feed truncation)');
      }
    }
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
  gte?: Date | null, // MADERA_AUDIT_B #11/#15/#28: batas bawah (cutoff/dateFrom WIB); batas atas difilter di client
) {
  const db = dbRead; // pintu-baca
  const rows = await db.mutation.findMany({
    where: { qrisAccountId: account.id, walletCategory: 'madera', ...(gte ? { transactionTime: { gte } } : {}) },
    orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return presentMaderaRows(account, rows, source);
}

// Sama seperti buildMaderaRealRowsForAccount tapi baris madera sudah di-fetch (dipakai jalur
// "Semua Akun" yang mengambil semua baris dalam 1 query lalu dikelompokkan per akun -> hindari N+1).
function presentMaderaRows(
  account: { id: string; code: string; merchantName: string; orkutAccountIndex: number | null; lastMaderaBalance: number | null },
  rows: Awaited<ReturnType<typeof dbRead.mutation.findMany>>,
  source: MutationSource,
) {
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

// Ringkasan periode Mutasi (Masuk/Keluar/Biaya Layanan) atas SELURUH baris periode.
// Kartu di view dulu dihitung dari baris ter-fetch (dibatasi `limit`) -> undercount parah saat
// hari ramai (mis. 3.157 mutasi -> hanya ~500 terbaru terhitung -> Biaya Layanan salah kecil).
// Di sini dihitung server-side atas semua baris periode (where sama), di-CACHE 30s supaya tak
// berat tiap poll (10s). fee = Biaya Layanan QRIS (0,3%) hanya utk baris kategori qris.
const _mutSummaryCache = new Map<string, { ts: number; data: { masuk: number; keluar: number; fee: number; count: number } }>();
const MUT_SUMMARY_TTL_MS = 30_000;
function _svcFeeQrisRow(rawDataJson: string, amount: number): number {
  const raw = parseRawMutationPayload(rawDataJson) as Record<string, unknown>;
  const pick = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(Math.round(v));
    let t = String(v).trim().replace(/rp/gi, '').replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
    if (!t) return 0;
    t = t.replace(/\./g, '').replace(/,/g, '.');
    const n = Number(t);
    return Number.isFinite(n) ? Math.abs(Math.round(n)) : 0;
  };
  const direct = pick(raw.fee_user ?? raw.feeUser ?? raw.fee ?? raw.admin ?? raw.biaya_layanan ?? raw.biayaLayanan);
  if (direct > 0) return direct;
  const nett = pick(raw.amount_nett ?? raw.amountNett);
  if (nett > 0 && amount > nett) return Math.max(0, Math.round(amount - nett));
  return 0;
}
async function computeMutationPeriodSummary(where: Record<string, unknown>, bucket: string): Promise<{ masuk: number; keluar: number; fee: number; count: number }> {
  const key = bucket + '|' + JSON.stringify(where);
  const cached = _mutSummaryCache.get(key);
  if (cached && Date.now() - cached.ts < MUT_SUMMARY_TTL_MS) return cached.data;
  const rows = await dbRead.mutation.findMany({
    where,
    select: { amount: true, type: true, rawDataJson: true, walletCategory: true, issuerName: true, rrn: true, transactionTime: true },
  });
  let masuk = 0, keluar = 0, fee = 0, count = 0;
  for (const m of rows) {
    const category = readMutationCategory(m.rawDataJson, m.walletCategory);
    if (bucket !== 'all' && category !== bucket) continue;
    if (category === 'utama' && isUtamaShadowMutation(m.rawDataJson)) continue;
    const parsedRaw = parseRawMutationPayload(m.rawDataJson) as { description?: string; keterangan?: string };
    const description = parsedRaw.description ?? parsedRaw.keterangan ?? '';
    const presentation = parseMutationPresentation(m.rawDataJson, {
      type: m.type, issuerName: m.issuerName, rrn: m.rrn, description, transactionTime: m.transactionTime, matched: false,
    });
    const sc = String(presentation.statusCode || (m.type === 'credit' ? 'IN' : 'OUT')).toUpperCase();
    if (sc === 'IN') masuk += m.amount; else keluar += m.amount;
    if (category === 'qris') fee += _svcFeeQrisRow(m.rawDataJson, m.amount);
    count += 1;
  }
  const data = { masuk, keluar, fee, count };
  _mutSummaryCache.set(key, { ts: Date.now(), data });
  return data;
}

export async function getMutationsJson(req: Request, res: Response): Promise<void> {
  const db = dbRead; // pintu-baca: menu mutasi murni baca -> tak antre di belakang tulisan
  // Timing sementara: ukur durasi server-side per response supaya penyebab lambat menu Mutasi terlihat.
  const __t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - __t0;
    if (ms >= 150) {
      logger.info({ ms, source: req.query.source ?? null, bucket: req.query.bucket ?? null, accountId: req.query.accountId ?? null, msg: 'getMutationsJson timing' });
    }
  });
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 5000);
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
            webCookiesEncrypted: true, webReportUrlEncrypted: true,
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
          where: scopeIds ? { id: { in: scopeIds } } : {}, // MADERA_AUDIT_B2: sertakan akun OFF (tetap transaksi) supaya total tak kehilangan uang; RBAC via scopeIds
          orderBy: { code: 'asc' },
          select: { id: true, code: true, merchantName: true, orkutAccountIndex: true, lastMaderaBalance: true },
        });
        // Hindari N+1: ambil semua baris madera (untuk akun yang di-scope) dalam 1 query,
        // lalu kelompokkan per akun. Pakai index (walletCategory, transactionTime).
        const _cutMad = resolveListCutoffDate(isShowAll(req));
        // MADERA_AUDIT_B #5/#11/#12: tegakkan batas BAWAH tanggal (WIB +07:00) di server, di-floor ke cutoff.
        // Batas ATAS (dateTo) tetap difilter di client supaya baris TERBARU tetap jadi anchor lastMaderaBalance.
        // Saat search: jangan clamp (biar cari lintas-waktu).
        const _sMad = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const _dfMad = (!_sMad && typeof req.query.dateFrom === 'string' && req.query.dateFrom) ? new Date(`${req.query.dateFrom}T00:00:00.000+07:00`) : null;
        let _gteMad: Date | null = _sMad ? null : _cutMad;
        if (_dfMad && !Number.isNaN(_dfMad.getTime()) && (!_gteMad || _dfMad > _gteMad)) _gteMad = _dfMad;
        const allMaderaRows = maderaAccounts.length === 0 ? [] : await db.mutation.findMany({
          where: { walletCategory: 'madera', qrisAccountId: { in: maderaAccounts.map((a) => a.id) }, ...(_gteMad ? { transactionTime: { gte: _gteMad } } : {}) },
          orderBy: [{ transactionTime: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        });
        const rowsByAccount = new Map<string, typeof allMaderaRows>();
        for (const row of allMaderaRows) {
          const list = rowsByAccount.get(row.qrisAccountId);
          if (list) { if (list.length < limit) list.push(row); }
          else rowsByAccount.set(row.qrisAccountId, [row]);
        }
        const perAccount = maderaAccounts.map((acc) => presentMaderaRows(acc, rowsByAccount.get(acc.id) ?? [], source));
        const merged = perAccount.flat().sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
        const balances: Record<string, number> = {};
        for (const acc of maderaAccounts) {
          balances[acc.id] = typeof acc.lastMaderaBalance === 'number' ? acc.lastMaderaBalance : 0;
        }
        const __bs = await getQrisBalanceSummary();
        res.json({
          ok: true,
          source,
          bucket,
          total: merged.length,
          currentBalance: null,
          accountBalances: balances,
          balanceSummary: __bs,
          note: null,
          bucketCounts: { qris: 0, utama: 0, madera: merged.length },
          mutations: merged.slice(0, limit),
        });
        return;
      }
      if (bucket === 'madera' && targetAccountId && targetAccount) {
        // Baris Madera ASLI dari DB (worker menariknya saat saldo Madera berubah via System B).
        // Baca DB murni -> cepat seperti menu QRIS. Saldo berjalan dihitung dari lastMaderaBalance.
        // MADERA_AUDIT_B #11/#15/#28: batas bawah = max(cutoff, dateFrom WIB), kecuali saat search.
        const _sMad1 = typeof req.query.search === 'string' ? req.query.search.trim() : '';
        const _cutMad1 = _sMad1 ? null : resolveListCutoffDate(isShowAll(req));
        const _dfMad1 = (!_sMad1 && typeof req.query.dateFrom === 'string' && req.query.dateFrom) ? new Date(`${req.query.dateFrom}T00:00:00.000+07:00`) : null;
        let _gteMad1: Date | null = _cutMad1;
        if (_dfMad1 && !Number.isNaN(_dfMad1.getTime()) && (!_gteMad1 || _dfMad1 > _gteMad1)) _gteMad1 = _dfMad1;
        const presentedMutations = await buildMaderaRealRowsForAccount(targetAccount, source, limit, _gteMad1);
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
      // Mulai Operasional: sembunyikan mutasi SEBELUM cutoff (kecuali Tampilkan Semua / date-from lebih tua).
      {
        const _cut = resolveListCutoffDate(isShowAll(req));
        if (_cut) {
          const _tf = (where.transactionTime as Record<string, Date>) || {};
          if (!_tf.gte || _tf.gte < _cut) _tf.gte = _cut;
          where.transactionTime = _tf;
        }
      }
      // Pencarian lintas-waktu (koko): jika ada `search`, cari 30 HARI terakhir, ABAIKAN cutoff & window harian,
      // filter teks server-side (case-insensitive) termasuk username = matchedTransaction.userIdExt.
      const _searchTerm = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      if (_searchTerm) {
        where.transactionTime = { gte: new Date(Date.now() - 30 * 86400000) };
        const _digits = _searchTerm.replace(/[^0-9]/g, '');
        const _or: Record<string, unknown>[] = [
          { rrn: { contains: _searchTerm, mode: 'insensitive' } },
          { rawDataJson: { contains: _searchTerm, mode: 'insensitive' } },
          { matchedTransaction: { is: { userIdExt: { contains: _searchTerm, mode: 'insensitive' } } } },
          { matchedTransaction: { is: { rrn: { contains: _searchTerm, mode: 'insensitive' } } } },
        ];
        if (_digits.length >= 3 && Number(_digits) > 0) _or.push({ amount: Number(_digits) });
        where.OR = _or;
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
          matchedTransaction: { select: { rrn: true, userIdExt: true, statusBot: true, paidAt: true, metadataJson: true, client: { select: { name: true } } } },
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
          bookedPending: m.matchedTransaction?.statusBot === 'manual_booked',
          processedAt: m.matchedTransaction?.paidAt ?? null,
          bookedBy: (() => { try { return (JSON.parse(m.matchedTransaction?.metadataJson || '{}') as { processedBy?: string }).processedBy || null; } catch { return null; } })(),
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
      const _periodSummary = await computeMutationPeriodSummary(where, bucket).catch(() => null);
      res.json({
        ok: true,
        source,
        bucket,
        total: presentedMutations.length,
        currentBalance,
        balanceSummary,
        note: maderaInferenceNote,
        bucketCounts: dedupedBucketCounts,
        summary: _periodSummary,
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
// Urutkan ulang baris yang WAKTU-nya sama (provider report presisi MENIT) mengikuti rantai
// saldo balanceBefore->balanceAfter. Tanpa ini, 2+ mutasi dalam 1 menit bisa keurut kebalik
// -> rantai seolah putus -> FALSE-ALARM "mutasi masuk hilang" padahal datanya lengkap.
function reorderReconcileChain<T extends { balanceBefore: number | null; balanceAfter: number | null; transactionTime: Date }>(rows: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i;
    // Grup per-MENIT (bukan per-detik): report pakai :00, app pakai detik asli. Dalam 1
    // menit sama, urut ikut rantai saldo → cegah false-alarm selisih (mis. PSAMUDRA 47rb).
    const t = Math.floor(rows[i].transactionTime.getTime() / 60000);
    while (j < rows.length && Math.floor(rows[j].transactionTime.getTime() / 60000) === t) j++;
    const group = rows.slice(i, j);
    if (group.length <= 1) {
      out.push(group[0]);
    } else {
      const remaining = group.slice();
      const groupAfters = new Set(group.map((r) => r.balanceAfter ?? 0));
      let cur: number | null = out.length ? (out[out.length - 1].balanceAfter ?? 0) : null;
      while (remaining.length) {
        let idx = cur != null
          ? remaining.findIndex((r) => (r.balanceBefore ?? 0) === cur)
          : remaining.findIndex((r) => !groupAfters.has(r.balanceBefore ?? 0)); // baris AWAL rantai (grup pertama, tak ada entry)
        if (idx < 0 && cur != null) {
          // FALLBACK (fix 10 Jul): rantai tak nyambung persis (mis. ada debit kecil tak tercatat
          // seperti potongan fee, atau credit sesama-menit keurut kebalik) -> pilih baris yang
          // balanceBefore PALING DEKAT ke saldo berjalan, BUKAN urutan array. Cegah false-alarm
          // 'gap naik' saat baris besar keambil duluan (mis. WRNASI: 450035 -> harus 447034 dulu,
          // bukan 1439837 -> lompatan palsu 989802). Saldo akhir tetap sama, deteksi gap NYATA tetap
          // jalan (kalau semua baris di atas saldo berjalan, yang terkecil-di-atas tetap ketahuan).
          let bestK = 0, bestD = Infinity;
          for (let k = 0; k < remaining.length; k++) {
            const d = Math.abs((remaining[k].balanceBefore ?? 0) - cur);
            if (d < bestD) { bestD = d; bestK = k; }
          }
          idx = bestK;
        }
        if (idx < 0) idx = 0; // grup pertama / tak nyambung -> pertahankan urutan asli
        out.push(remaining[idx]);
        cur = remaining[idx].balanceAfter ?? 0;
        remaining.splice(idx, 1);
      }
    }
    i = j;
  }
  return out;
}

async function computeWalletReconcileForAccount(
  account: { id: string; code: string; merchantName: string | null },
  walletCategory: string,
  physicalBalance: number | null,
) {
  const db = dbRead; // pintu-baca
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
  // Rapikan urutan baris ber-waktu-sama mengikuti rantai saldo (hindari false-alarm same-minute).
  const chain = reorderReconcileChain(rows);
  // Semua nilai balanceAfter yg pernah ada. Kalau curBefore suatu baris = balanceAfter baris LAIN,
  // berarti baris "penaik saldo" itu ADA (cuma keurut kebalik, mis. beda-detik) -> BUKAN gap nyata.
  const afterSet = new Set(chain.map((r) => r.balanceAfter ?? 0));
  const newestAfter = chain[chain.length - 1].balanceAfter ?? 0;
  const tailDiff = physical - newestAfter;
  // Cari lonjakan NAIK pertama (saldo masuk tanpa baris = mutasi masuk hilang).
  let upwardGap: { jump: number; atTime: Date; sinceTime: Date; keterangan: string } | null = null;
  for (let i = 1; i < chain.length; i++) {
    const prevAfter = chain[i - 1].balanceAfter ?? 0;
    const curBefore = chain[i].balanceBefore ?? 0;
    if (curBefore > prevAfter && !afterSet.has(curBefore)) {
      const _jump = curBefore - prevAfter;
      // NGAPAKCELL: 2 pembayaran nyaris-bersamaan bisa punya saldo-antara SALING-SILANG dari provider
      // (balanceAfter kembar). Jump yg PERSIS = amount baris credit waktu-sama (±90s) = artefak rantai,
      // BUKAN uang hilang -> skip (uang total & saldo akhir tetap benar).
      const _tI = chain[i].transactionTime.getTime();
      const _explained = chain.some((r, k) => k !== i && r.type === 'credit' && Math.abs(Number(r.amount || 0)) === _jump && Math.abs(r.transactionTime.getTime() - _tI) <= 90000);
      if (_explained) continue;
      // FIX GDGCELL 02:03: skip gap yg MUNDUR-WAKTU = artefak reorder same-minute (balanceAfter
      // kembar + Pencairan dalam 1 menit -> baris credit terlempar SESUDAH Pencairan -> lompatan
      // naik semu). Gap NYATA (mutasi masuk hilang) selalu maju-waktu. Dikonfirmasi Web Report
      // missingCount=0 & saldo akhir benar -> gap semu (reorder same-minute), bukan uang hilang.
      if (chain[i].transactionTime.getTime() < chain[i - 1].transactionTime.getTime()) continue;
      const raw = parseRawMutationPayload(chain[i].rawDataJson);
      upwardGap = {
        jump: _jump,
        atTime: chain[i].transactionTime,
        sinceTime: chain[i - 1].transactionTime,
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
  const db = dbRead; // pintu-baca
  const __t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - __t0;
    if (ms >= 150) {
      logger.info({ ms, wallet: req.query.wallet ?? null, accountId: req.query.accountId ?? null, msg: 'getQrisReconcileApi timing' });
    }
  });
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
      const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined); // RBAC: alias tak boleh reconcile akun site lain (findUnique lolos interceptor)
      if (_scopeIds && !_scopeIds.includes(accountId)) { res.status(404).json({ ok: false, error: 'Akun tidak ditemukan' }); return; }
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
    // RECONCILE_ALL (11 Jul): cocokkan SEMUA akun ber-kredensial (aktif+nonaktif) -> akun nonaktif kini
    // tetap dipoll (dormant 5mnt) jadi saldonya fresh & bisa direkonsiliasi. koko: biar semua sinkron.
    const accounts = await db.qrisAccount.findMany({
      where: { OR: [ { sessionTokenEncrypted: { not: null } }, { cookiesEncrypted: { not: null } }, { webCookiesEncrypted: { not: null } } ] },
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

// ── Detail selisih (bandingkan Web Report vs DB) + tarik 1-klik ──────────────
// ── Detail selisih GAP-ANCHORED: hanya mutasi biang selisih yg terdeteksi rantai saldo ──
// (bukan diff riwayat penuh). Window = (gap.sinceTime, gap.atTime]. CREDIT-only (uang MASUK hilang).
async function findGapMissingCredits(account: any, wallet: 'qris' | 'utama', gap: { atTime: Date; sinceTime: Date }) {
  const payload = await fetchReportWalletLive(account, wallet, 8);
  if (!payload) return null;
  const since = new Date(gap.sinceTime).getTime() - 60000;
  const until = new Date(gap.atTime).getTime() + 60000;
  const inWindow = (payload.mutations || []).filter((m) => {
    if (m.type !== 'credit' || !(Number(m.balanceAfter) > 0)) return false;
    const t = new Date(m.transactionTime).getTime();
    return t >= since && t <= until;
  });
  const keys = inWindow.map((m) => canonicalMutationHash({ rrn: m.rrn, amount: m.amount, balanceAfter: m.balanceAfter, transactionTime: m.transactionTime, type: m.type }));
  const existRows = keys.length ? await db.mutation.findMany({ where: { dedupKey: { in: keys } }, select: { dedupKey: true } }) : [];
  const existing = new Set(existRows.map((r) => r.dedupKey));
  return inWindow.filter((_m, i) => !existing.has(keys[i]));
}

export async function getReconcileDetailApi(req: Request, res: Response): Promise<void> {
  try {
    const wallet = req.query.wallet === 'utama' ? 'utama' : 'qris';
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
    const account = await db.qrisAccount.findUnique({ where: { id: accountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; } // RBAC di luar scope (mutasi2)
    const physical = wallet === 'utama' ? account.lastMainBalance : account.lastQrisBalance;
    const recon = (await computeWalletReconcileForAccount(account, wallet, physical)) as { match?: boolean; gap?: { jump: number; atTime: Date; sinceTime: Date } | null };
    if (recon.match) { res.json({ ok: true, match: true, missing: [], message: 'Sudah cocok — tidak ada selisih.' }); return; }
    if (!recon.gap || !recon.gap.sinceTime) {
      res.json({ ok: true, match: false, missing: [], message: 'Selisih pada saldo TERKINI (mutasi terbaru belum tertarik). Tekan Tarik untuk sinkron dari Web Report.' });
      return;
    }
    const missing = await findGapMissingCredits(account, wallet, recon.gap);
    if (missing === null) { res.json({ ok: false, message: 'Gagal menarik Web Report akun ini (cek Link Web Report).' }); return; }
    res.json({
      ok: true, match: false,
      gap: { jump: recon.gap.jump, sinceTime: recon.gap.sinceTime, atTime: recon.gap.atTime },
      missingCount: missing.length,
      missing: missing.map((m) => {
        const raw = parseRawMutationPayload(m.rawDataJson);
        return { amount: m.amount, rrn: m.rrn, user: m.issuerName || readString(raw.keterangan) || readString(raw.description) || '-', time: m.transactionTime };
      }),
    });
  } catch (err) {
    logger.error({ err }, 'getReconcileDetailApi error');
    res.status(500).json({ ok: false, message: 'Gagal mengambil detail selisih.' });
  }
}

export async function postReconcileBackfillApi(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as { accountId?: string; wallet?: string };
    const wallet = body.wallet === 'utama' ? 'utama' : 'qris';
    const account = await db.qrisAccount.findUnique({ where: { id: String(body.accountId || '') } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; } // RBAC di luar scope (mutasi2)
    const physical = wallet === 'utama' ? account.lastMainBalance : account.lastQrisBalance;
    const recon = (await computeWalletReconcileForAccount(account, wallet, physical)) as { match?: boolean; gap?: { jump: number; atTime: Date; sinceTime: Date } | null };
    if (recon.match || !recon.gap || !recon.gap.sinceTime) { res.json({ ok: true, wallet, newCount: 0, message: 'Tidak ada selisih terdeteksi untuk ditarik.' }); return; }
    const missing = await findGapMissingCredits(account, wallet, recon.gap);
    if (missing === null) { res.json({ ok: false, message: 'Gagal menarik Web Report akun ini.' }); return; }
    let newCount = 0;
    for (const m of missing) {
      const r = await storeMutationIfNew({
        qrisAccountId: account.id, amount: m.amount, type: m.type,
        balanceBefore: m.balanceBefore, balanceAfter: m.balanceAfter,
        issuerName: m.issuerName ?? null, rrn: m.rrn ?? null, walletCategory: wallet,
        transactionTime: new Date(m.transactionTime), rawHash: m.rawHash, rawDataJson: m.rawDataJson,
      });
      if (r.created) newCount++;
    }
    res.json({ ok: true, wallet, newCount });
  } catch (err) {
    logger.error({ err }, 'postReconcileBackfillApi error');
    res.status(500).json({ ok: false, message: 'Gagal menarik mutasi hilang.' });
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
      select: { statusPay: true, paidAt: true, expiresAt: true, finalAmount: true, qrisAccountId: true },
    });
    if (!tx || !accountInScope(req.session.user as AccessUser | undefined, tx.qrisAccountId)) {
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
    void logAction(req, { category: 'rbac', action: 'alias_create', severity: 'critical', summary: 'Membuat akun operator "' + String(b.username || '') + '"', targetType: 'AliasAccount', targetId: String(b.username || ''), targetName: String(b.name || b.username || ''), detail: { username: b.username, name: b.name, siteScope: b.siteScope, perms: b.perms || {} } });
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
    void logAction(req, { category: 'rbac', action: 'alias_update', severity: 'critical', summary: 'Mengubah akun operator "' + username + '"', targetType: 'AliasAccount', targetId: username, targetName: String(b.name || username), detail: { name: b.name, siteScope: b.siteScope, perms: b.perms, passwordChanged: !!b.password } });
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
    void logAction(req, { category: 'rbac', action: 'alias_delete', severity: 'critical', summary: 'Menghapus akun operator "' + username + '"', targetType: 'AliasAccount', targetId: username });
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
      listSettlements({ limit: 5000 }), // HIST_PAGER: kirim semua riwayat ke DOM supaya filter Hari ini/Kemarin/Custom lihat SEMUA (dulu 100 -> potong)
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
    // URUT KARTU: aktif & belum limit (atas) -> nonaktif belum limit -> sudah limit >=29,6jt (bawah).
    const _LIMIT_CAP = 29600000;
    const _rankLimit = (a: { usedToday?: number | null; status?: string | null }) => ((Number(a.usedToday) || 0) >= _LIMIT_CAP ? 2 : (a.status === 'active' ? 0 : 1));
    accounts.sort((x, y) => _rankLimit(x) - _rankLimit(y));
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
    const _nagoxMap = readNagoxTransfers();
    const _cutSetl = resolveListCutoffDate(isShowAll(req));
    const _acctNameMap: Record<string, string> = {}; // AKUNQRIS_COL: id -> nama merchant
    for (const _a of rawAccounts) _acctNameMap[_a.id] = _a.merchantName || _a.code || '-';
    const settlementsView = settlements.filter((s) => !_cutSetl || new Date(s.createdAt).getTime() >= _cutSetl.getTime()).map((s) => ({
      ...s,
      merchantName: s.qrisAccountId ? (_acctNameMap[s.qrisAccountId] || null) : null, // AKUNQRIS_COL
      nagoxStatus: _nagoxMap[s.id] ? _nagoxMap[s.id].status : null,
      nagoxMessage: _nagoxMap[s.id] ? (_nagoxMap[s.id].message || null) : null,
    }));
    res.render('settlement/index', {
      title: 'Saldo Per Akun',
      sites,
      walletTotals,
      settlements: settlementsView,
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
    if (!accountInScope(req.session.user as AccessUser | undefined, (parsed.data as { qrisAccountId?: string }).qrisAccountId)) { res.json({ ok: false, error: 'Akun di luar akses Anda.' }); return; } // RBAC: alias tak inquiry pakai akun site lain
    const result = await inquireSettlementBankAccount(parsed.data);
    void logAction(req, { category: 'settlement', action: 'bank_inquiry', summary: 'Inquiry rekening tujuan transfer' });
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
    void logAction(req, { category: 'settlement', action: 'account_transfer', severity: 'critical', status: (settlement && settlement.status !== 'failed') ? 'success' : 'failed', summary: 'Transfer ' + fromWallet + '\u2192' + toWallet + ' Rp ' + Number(amount).toLocaleString('id-ID') + (toWallet === 'bank' ? (' ke ' + (bankName || bankCode || '') + ' ' + (bankAccount || '')) : ''), targetType: 'SettlementRequest', targetId: settlementId, detail: { fromWallet, toWallet, amount, bankCode, bankName, bankAccount, status: settlement?.status } });
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
        webCookiesEncrypted: true, webReportUrlEncrypted: true,
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
    void logAction(req, { category: 'settlement', action: 'retry_auto_pin', severity: 'critical', status: pinResult.success ? 'success' : 'failed', summary: 'Retry Auto-PIN transfer Madera akun ' + (account.code || '') + (pinResult.success ? ' \u2014 BERHASIL' : ' \u2014 GAGAL'), targetType: 'SettlementRequest', targetId: settlementId, detail: { accountCode: account.code } });
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
    if (!accountInScope(req.session.user as AccessUser | undefined, qrisAccountId)) { res.json({ ok: true, banks: [] }); return; } // RBAC: alias tak boleh intip bank akun site lain
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
    void logAction(req, { category: 'settlement', action: 'settlement_create', severity: 'important', summary: 'Membuat settlement ' + fromWallet + '\u2192' + toWallet + ' Rp ' + Number(amount).toLocaleString('id-ID'), targetType: 'SettlementRequest', detail: { fromWallet, toWallet, amount, bankCode, bankName, bankAccount } });
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
    void logAction(req, { category: 'client', action: 'webgame_check', summary: 'Cek panel webgame ' + platform + (siteId ? (' (site ' + siteId + ')') : ''), detail: { platform, siteId, online: !!parsed.online } });
    res.json({ ok: true, online: !!parsed.online, platform: parsed.platform || platform, message: parsed.message || '' });
  } catch (err) {
    logger.error({ err }, 'checkWebGamePanelApi error');
    res.status(500).json({ ok: false, online: false, message: 'Error internal saat cek panel.' });
  }
}

// ── Web Game sites (SERVER-shared; dibagi semua akun ber-menu Pengaturan) ──
export async function getWebgameSitesApi(req: Request, res: Response): Promise<void> {
  try {
    res.json({ ok: true, sites: readWebgameSites() });
  } catch (err) {
    logger.error({ err }, 'getWebgameSitesApi error');
    res.status(500).json({ ok: false, sites: [] });
  }
}

export async function saveWebgameSitesApi(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body || {}) as { sites?: unknown };
    const sites = Array.isArray(body.sites) ? body.sites.slice(0, 100) : [];
    writeWebgameSites(sites);
    void logAction(req, { category: 'client', action: 'webgame_sites_save', summary: 'Simpan daftar Web Game (' + sites.length + ' site)', detail: { count: sites.length } });
    res.json({ ok: true, count: sites.length });
  } catch (err) {
    logger.error({ err }, 'saveWebgameSitesApi error');
    res.status(500).json({ ok: false });
  }
}

// ── Daftar Bank per-site (CRUD + integrasi Kirim Uang) ───────────────────────
function _bankSiteName(siteId: string): string {
  const s = listSites().find((x) => x.id === siteId);
  return s ? s.name : siteId;
}
// Nagox: baca saldo bank tersinkron (ditulis service Python tiap ~10s ke data/nagox-balances.json).
function _readNagox(): { syncedAt: number; loggedIn: boolean; connected: boolean; banks: Array<Record<string, unknown>> } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'nagox-balances.json'), 'utf8'));
    const syncedAt = Number(raw.syncedAt) || 0;
    const connected = !!raw.loggedIn && (Date.now() - syncedAt < 40000);
    return { syncedAt, loggedIn: !!raw.loggedIn, connected, banks: Array.isArray(raw.banks) ? raw.banks : [] };
  } catch { return { syncedAt: 0, loggedIn: false, connected: false, banks: [] }; }
}
function _nagoxSaldoOf(ng: { banks: Array<Record<string, unknown>> }, noRek: string): { nagoxSaldo: number | null; nagoxSaldoText: string | null } {
  const nr = String(noRek || '').replace(/[^0-9]/g, '');
  if (!nr) return { nagoxSaldo: null, nagoxSaldoText: null };
  const h = ng.banks.find((b) => String((b as { noRekening?: string }).noRekening || '').replace(/[^0-9]/g, '') === nr) as { saldo?: number; saldoText?: string } | undefined;
  return h ? { nagoxSaldo: typeof h.saldo === 'number' ? h.saldo : null, nagoxSaldoText: h.saldoText || null } : { nagoxSaldo: null, nagoxSaldoText: null };
}
export async function showDaftarBank(req: Request, res: Response): Promise<void> {
  try {
    const user = req.session.user as AccessUser | undefined;
    const scope = getSiteScopeForUser(user);
    const _rawSites = scope ? listSites().filter((s) => s.id === scope) : listSites();
    const sites = _rawSites.map((s) => ({ ...s, firstAccountId: accountIdsForSite(s.id)[0] || null }));
    const canManage = isMasterUser(user) || canDo(getMenuPermsForUser(user), 'daftar-bank', 'manage');
    res.render('daftar-bank/index', { title: 'Daftar Bank', sites, siteScope: scope, canManage });
  } catch (err) {
    logger.error({ err }, 'showDaftarBank error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}
export async function getDaftarBankApi(req: Request, res: Response): Promise<void> {
  try {
    const scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const _ng = _readNagox();
    const banks = listBanksForScope(scope).map((b) => ({ ...b, siteName: _bankSiteName(b.siteId), ..._nagoxSaldoOf(_ng, b.noRekening) }));
    res.json({ ok: true, banks, nagoxConnected: _ng.connected });
  } catch (err) { logger.error({ err }, 'getDaftarBankApi error'); res.status(500).json({ ok: false }); }
}
export async function createDaftarBankApi(req: Request, res: Response): Promise<void> {
  try {
    const scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const body = (req.body || {}) as Record<string, unknown>;
    let siteId = String(body.siteId || '').trim();
    if (scope) siteId = scope;
    if (!siteId) { res.status(400).json({ ok: false, error: 'Site wajib dipilih' }); return; }
    const rec = createBank({
      siteId,
      bankCode: String(body.bankCode || '').trim(),
      bankName: String(body.bankName || '').trim(),
      namaRekening: String(body.namaRekening || '').trim(),
      noRekening: String(body.noRekening || '').trim(),
    }, (req.session.user as AccessUser | undefined)?.username);
    const siteName = _bankSiteName(rec.siteId);
    void logAction(req, { category: 'bank', action: 'bank_create', severity: 'important', summary: 'Tambah rekening ' + rec.bankName + ' a.n. ' + rec.namaRekening + ' ' + rec.noRekening + ' (site ' + siteName + ')', targetType: 'BankAccount', targetId: rec.id, targetName: rec.bankName + ' ' + rec.noRekening, detail: { siteId: rec.siteId, siteName, bankCode: rec.bankCode, bankName: rec.bankName, namaRekening: rec.namaRekening, noRekening: rec.noRekening } });
    res.json({ ok: true, bank: { ...rec, siteName } });
  } catch (err) { res.status(400).json({ ok: false, error: (err as Error).message || 'Gagal menyimpan' }); }
}
export async function updateDaftarBankApi(req: Request, res: Response): Promise<void> {
  try {
    const scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const id = String(req.params.id || '');
    const before = getBankById(id);
    if (!before) { res.status(404).json({ ok: false, error: 'Rekening tidak ditemukan' }); return; }
    if (scope && before.siteId !== scope) { res.status(403).json({ ok: false, error: 'Tidak boleh mengubah rekening site lain' }); return; }
    const body = (req.body || {}) as Record<string, unknown>;
    const after = updateBank(id, {
      bankCode: body.bankCode !== undefined ? String(body.bankCode).trim() : undefined,
      bankName: body.bankName !== undefined ? String(body.bankName).trim() : undefined,
      namaRekening: body.namaRekening !== undefined ? String(body.namaRekening).trim() : undefined,
      noRekening: body.noRekening !== undefined ? String(body.noRekening).trim() : undefined,
    });
    if (!after) { res.status(404).json({ ok: false, error: 'Rekening tidak ditemukan' }); return; }
    const siteName = _bankSiteName(after.siteId);
    void logAction(req, { category: 'bank', action: 'bank_update', summary: 'Ubah rekening ' + after.bankName + ' ' + after.noRekening + ' (site ' + siteName + ')', targetType: 'BankAccount', targetId: id, targetName: after.bankName + ' ' + after.noRekening, before: { bankCode: before.bankCode, bankName: before.bankName, namaRekening: before.namaRekening, noRekening: before.noRekening }, after: { bankCode: after.bankCode, bankName: after.bankName, namaRekening: after.namaRekening, noRekening: after.noRekening }, detail: { siteId: after.siteId, siteName } });
    res.json({ ok: true, bank: { ...after, siteName } });
  } catch (err) { res.status(400).json({ ok: false, error: (err as Error).message || 'Gagal mengubah' }); }
}
export async function deleteDaftarBankApi(req: Request, res: Response): Promise<void> {
  try {
    const scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const id = String(req.params.id || '');
    const rec = getBankById(id);
    if (!rec) { res.status(404).json({ ok: false, error: 'Rekening tidak ditemukan' }); return; }
    if (scope && rec.siteId !== scope) { res.status(403).json({ ok: false, error: 'Tidak boleh menghapus rekening site lain' }); return; }
    deleteBank(id);
    const siteName = _bankSiteName(rec.siteId);
    void logAction(req, { category: 'bank', action: 'bank_delete', severity: 'critical', summary: 'Hapus rekening ' + rec.bankName + ' ' + rec.noRekening + ' (site ' + siteName + ')', targetType: 'BankAccount', targetId: id, targetName: rec.bankName + ' ' + rec.noRekening, detail: { siteId: rec.siteId, siteName, bankCode: rec.bankCode, namaRekening: rec.namaRekening, noRekening: rec.noRekening } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: (err as Error).message || 'Gagal menghapus' }); }
}
export async function getSettlementSavedBanksApi(req: Request, res: Response): Promise<void> {
  try {
    const qrisAccountId = String(req.query.qrisAccountId || '');
    const map = getAccountSiteMap();
    const siteId = qrisAccountId ? map[qrisAccountId] : null;
    if (!siteId) { res.json({ ok: true, banks: [] }); return; }
    const scope = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    if (scope && siteId !== scope) { res.json({ ok: true, banks: [] }); return; }
    const _ng2 = _readNagox();
    res.json({ ok: true, siteId, nagoxConnected: _ng2.connected, banks: listBanks(siteId).map((b) => ({ ...b, ..._nagoxSaldoOf(_ng2, b.noRekening) })) });
  } catch (err) { logger.error({ err }, 'getSettlementSavedBanksApi error'); res.status(500).json({ ok: false }); }
}
export async function getNagoxStatusApi(req: Request, res: Response): Promise<void> {
  try {
    const n = _readNagox();
    res.json({ ok: true, connected: n.connected, loggedIn: n.loggedIn, syncedAt: n.syncedAt, count: n.banks.length });
  } catch { res.status(500).json({ ok: false }); }
}
const _nagoxInflight = new Set<string>();
export async function nagoxApproveApi(req: Request, res: Response): Promise<void> {
  const id = String((req.body || {}).id || '').trim();
  if (!id) { res.status(400).json({ ok: false, message: 'ID transaksi kosong.' }); return; }
  // Guard SINKRON (sebelum await apa pun) anti-dobel konkuren + status ok/pending.
  if (_nagoxInflight.has(id)) { res.status(409).json({ ok: false, message: 'Transaksi ini sedang diproses, tunggu sebentar.' }); return; }
  const existing = getNagoxTransfer(id);
  if (existing && existing.status === 'ok') { res.json({ ok: true, already: true, status: 'ok', message: 'Sudah tercatat di Nagox.' }); return; }
  if (existing && existing.status === 'pending' && (Date.now() - new Date(existing.at).getTime() < 120000)) {
    res.status(409).json({ ok: false, message: 'Transaksi sedang diproses (pending), tunggu ~2 menit atau cek manual.' }); return;
  }
  _nagoxInflight.add(id);
  try {
    const s = await db.settlementRequest.findUnique({ where: { id } });
    if (!s) { res.status(404).json({ ok: false, message: 'Transaksi tidak ditemukan.' }); return; }
    if (!(s.fromWallet === 'madera' && s.toWallet === 'bank')) { res.status(400).json({ ok: false, message: 'Approve hanya untuk transfer Madera to Bank.' }); return; }
    if (s.status !== 'done') { res.status(400).json({ ok: false, message: 'Transaksi belum berstatus DONE.' }); return; }
    if (!s.bankAccount) { res.status(400).json({ ok: false, message: 'Nomor rekening tujuan kosong.' }); return; }
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    if (_scopeIds && s.qrisAccountId && !_scopeIds.includes(s.qrisAccountId)) { res.status(403).json({ ok: false, message: 'Transaksi di luar site Anda.' }); return; }
    const fee = 2500;
    let namaAkun = '';
    let siteName = '';
    try {
      const acc = s.qrisAccountId ? await db.qrisAccount.findUnique({ where: { id: s.qrisAccountId }, select: { merchantName: true } }) : null;
      namaAkun = (acc && acc.merchantName ? acc.merchantName : '').trim();
    } catch { /* ignore */ }
    try { if (s.qrisAccountId) siteName = (buildResolver()(s.qrisAccountId).siteName || '').trim(); } catch { /* ignore */ }
    const wib = new Date(Date.now() + 25200000).toISOString().replace('T', ' ').slice(0, 16);
    const catatan = ((namaAkun || 'QRIS') + ' ' + s.amount + ' dan biaya ' + fee + ' ' + wib + ' #' + id).trim();
    // Klaim 'pending' SEBELUM POST: kalau tulis hasil gagal / crash, retry tetap terhalang (lalu python pre-check dedup by ref).
    try { setNagoxTransfer(id, { status: 'pending', at: new Date().toISOString(), message: 'diproses' }); } catch { /* ignore */ }
    const r = callNagoxTransfer({ settlementId: id, norekPenerima: s.bankAccount, bankPenerima: s.bankName || '', panel: siteName, nominal: s.amount, nilaiBiaya: fee, catatan });
    const status: NagoxTfStatus = r.ok ? 'ok' : (r.unknown ? 'unknown' : 'fail');
    setNagoxTransfer(id, { status, at: new Date().toISOString(), message: r.message, pengirim: r.pengirim, penerima: r.penerima });
    void logAction(req, { category: 'settlement', action: 'nagox_approve', summary: 'Approve catat Nagox ' + (r.ok ? 'SUKSES' : (r.unknown ? 'TIDAK PASTI' : 'GAGAL')) + ': ' + (namaAkun || '-') + ' Rp' + s.amount + ' -> ' + (s.bankName || '') + ' ' + s.bankAccount, severity: r.ok ? 'important' : 'critical', targetType: 'SettlementRequest', targetId: id, detail: { ok: r.ok, status, message: r.message, penerima: r.penerima, already: r.already } });
    res.json({ ok: r.ok, status, message: r.message, pengirim: r.pengirim, penerima: r.penerima });
  } catch (err) {
    logger.error({ err }, 'nagoxApproveApi error');
    res.status(500).json({ ok: false, message: 'Error internal saat catat Nagox.' });
  } finally {
    _nagoxInflight.delete(id);
  }
}

export async function nagoxRejectApi(req: Request, res: Response): Promise<void> {
  try {
    const id = String((req.body || {}).id || '').trim();
    if (!id) { res.status(400).json({ ok: false, message: 'ID kosong.' }); return; }
    const cur = getNagoxTransfer(id);
    if (cur && cur.status === 'ok') { res.status(400).json({ ok: false, message: 'Sudah tercatat di Nagox, tidak bisa direject.' }); return; }
    setNagoxTransfer(id, { status: 'rejected', at: new Date().toISOString() });
    void logAction(req, { category: 'settlement', action: 'nagox_reject', summary: 'Reject (lokal) pencatatan Nagox transaksi ' + id, targetType: 'SettlementRequest', targetId: id, detail: {} });
    res.json({ ok: true, status: 'rejected' });
  } catch (err) { logger.error({ err }, 'nagoxRejectApi error'); res.status(500).json({ ok: false, message: 'Error internal.' }); }
}

export async function showAccountSettings(req: Request, res: Response): Promise<void> {
  const _u = req.session.user as AccessUser | undefined;
  const canManageWebgame = !!_u && (isMasterUser(_u) || canDo(getMenuPermsForUser(_u), 'settings', 'manage'));
  try {
    const _scopeIds = getScopeAccountIds(_u); // RBAC: alias-tenant hanya lihat akun site-nya
    const qrisAccounts = await db.qrisAccount.findMany({
      where: _scopeIds ? { id: { in: _scopeIds } } : undefined,
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true, status: true },
    });
    res.render('settings/account', { title: 'Pengaturan Akun', qrisAccounts, canManageWebgame });
  } catch (err) {
    logger.error({ err }, 'showAccountSettings error');
    res.render('settings/account', { title: 'Pengaturan Akun', qrisAccounts: [], canManageWebgame });
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
    void logAction(req, { category: 'sync', action: 'refresh_balance', summary: 'Refresh saldo ' + parsed.data.wallet + ' akun', targetType: 'QrisAccount', targetId: accountId, detail: { wallet: parsed.data.wallet } });
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
  accountId: z.string().optional(),
  siteId: z.string().optional(),
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
    // Auto round-robin per site: kalau akun tak dipilih, sistem pilih akun paling merata (limit terbagi).
    let chosenAccountId = parsed.data.accountId || '';
    if (!chosenAccountId) {
      const siteAcctIds = accountIdsForSite(parsed.data.siteId || null);
      try {
        const sel = await selectQrisAccountForSite(siteAcctIds);
        chosenAccountId = sel.id;
      } catch (e) {
        if (e instanceof NoEligibleAccountError) {
          res.status(409).json({ ok: false, error: 'HUBUNGI CS DI LIVE CHAT & LAMPIRKAN SCREENSHOT' });
          return;
        }
        throw e;
      }
    }
    // Fase 6: alias-tenant tak boleh generate di akun luar site-nya.
    if (!accountInScope(req.session.user as AccessUser | undefined, chosenAccountId)) {
      res.status(403).json({ ok: false, error: 'Akun di luar site Anda.' });
      return;
    }
    const result = await generateDashboardQrTransaction({
      ...parsed.data,
      accountId: chosenAccountId,
      createdBy: req.session.user?.username || 'dashboard',
    });
    void logAction(req, { category: 'generate-qr', action: 'generate_qr', summary: 'Generate QR Rp ' + Number(parsed.data.amount || 0).toLocaleString('id-ID') + (parsed.data.username ? (' \u00b7 ' + parsed.data.username) : ''), targetType: 'QrisAccount', targetId: chosenAccountId, detail: { amount: parsed.data.amount, username: parsed.data.username, siteId: parsed.data.siteId } });
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

// ══════════ Send Money Manual (BI-Fast Madera, PIN dientri sendiri di tab Nobu) ══════════
export async function getMaderaManualBanksApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).json({ ok: false, message: 'Akun di luar site Anda.' }); return; }
    const ov = await (appGateway as any).fetchMaderaTransferOverview(account);
    const banksObj = (ov && ov.banks) || {};
    const banks = Object.keys(banksObj)
      .map((code) => ({ code, name: banksObj[code].name, status: banksObj[code].status, fee: banksObj[code].fee }))
      .filter((b) => !b.status || b.status === 'OPERATIONAL')
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({
      ok: true,
      banks,
      min: (ov && ov.min) || 10000,
      max: (ov && ov.max) || 0,
      balance: (ov && typeof ov.accountBalance === 'number') ? ov.accountBalance : (account.lastMaderaBalance || 0),
    });
  } catch (err) {
    logger.error({ err }, 'getMaderaManualBanksApi error');
    res.status(500).json({ ok: false, message: 'Gagal memuat daftar bank.' });
  }
}

export async function postMaderaManualInquiryApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).json({ ok: false, message: 'Akun di luar site Anda.' }); return; }
    const bankCode = String((req.body && req.body.bankCode) || '').trim();
    const accountNumber = String((req.body && req.body.accountNumber) || '').trim();
    const amount = Number((req.body && req.body.amount) || 0);
    if (!bankCode || !accountNumber) { res.status(400).json({ ok: false, message: 'Bank & nomor rekening wajib diisi.' }); return; }
    if (!Number.isFinite(amount) || amount < 10000) { res.status(400).json({ ok: false, message: 'Nominal minimal Rp 10.000.' }); return; }
    const inquiry = await (appGateway as any).inquireBankAccount(account, { sourceWallet: 'madera', bankCode, accountNumber, amount });
    void logAction(req, { category: 'settlement', action: 'madera_manual_inquiry', summary: 'Inquiry rekening (Kirim Uang Manual Madera) akun ' + (account.code || account.id), targetType: 'QrisAccount', targetId: account.id, detail: { bankCode, accountNumber, amount } });
    if (!inquiry || !inquiry.success || !inquiry.accountName) {
      res.json({ ok: false, message: (inquiry && inquiry.message) || 'Nama pemilik rekening belum bisa dibaca. Periksa bank & nomor rekening.' });
      return;
    }
    res.json({ ok: true, accountName: inquiry.accountName, bankName: inquiry.bankName, bankCode: inquiry.bankCode || bankCode, fee: inquiry.fee || 0 });
  } catch (err) {
    logger.error({ err }, 'postMaderaManualInquiryApi error');
    res.status(500).json({ ok: false, message: 'Gagal cek rekening.' });
  }
}

export async function postMaderaManualInitiateApi(req: Request, res: Response): Promise<void> {
  let settlementId: string | null = null;
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).json({ ok: false, message: 'Akun di luar site Anda.' }); return; }
    const bankCode = String((req.body && req.body.bankCode) || '').trim();
    const accountNumber = String((req.body && req.body.accountNumber) || '').trim();
    const accountName = String((req.body && req.body.accountName) || '').trim();
    const bankName = String((req.body && req.body.bankName) || '').trim();
    const amount = Number((req.body && req.body.amount) || 0);
    if (!bankCode || !accountNumber) { res.status(400).json({ ok: false, message: 'Bank & nomor rekening wajib diisi.' }); return; }
    if (!Number.isFinite(amount) || amount < 10000) { res.status(400).json({ ok: false, message: 'Nominal minimal Rp 10.000.' }); return; }
    if (account.lastMaderaBalance === null || account.lastMaderaBalance === undefined) { res.status(400).json({ ok: false, message: 'Saldo Madera akun ini belum tersedia.' }); return; }
    let bal = account.lastMaderaBalance || 0;
    try { const ov = await (appGateway as any).fetchMaderaTransferOverview(account); if (ov && typeof ov.accountBalance === 'number') bal = ov.accountBalance; } catch (_e) { /* pakai cache DB */ }
    if (bal < amount) { res.status(400).json({ ok: false, message: 'Saldo Madera tidak cukup (saldo: ' + bal + ', diminta: ' + amount + ').' }); return; }

    // Catat sebagai settlement, langsung 'processing' agar worker-sweep TIDAK memprosesnya via PIN otomatis.
    settlementId = await createSettlement(
      { fromWallet: 'madera', toWallet: 'bank', amount, qrisAccountId: account.id, bankCode, bankAccount: accountNumber, bankName: bankName || undefined, note: '[MANUAL] PIN dientri di tab Nobu' },
      req.session.user?.id, req.ip,
    );
    await db.settlementRequest.update({ where: { id: settlementId }, data: { status: 'processing' } });

    // Inisiasi transfer TANPA PIN -> OrderKuota balas redirect_url untuk PIN manual di webview Nobu.
    const transfer = await appGateway.transferBankFromMadera(account, { bankCode, accountNumber, accountName, bankName: bankName || undefined, amount });
    if (!transfer || !transfer.redirectUrl) {
      await db.settlementRequest.update({ where: { id: settlementId }, data: { status: 'failed', note: '[MANUAL] gagal inisiasi: ' + ((transfer && transfer.message) || 'tanpa redirect_url') } }).catch(() => {});
      res.json({ ok: false, message: (transfer && transfer.message) || 'Gagal memulai transfer manual. Coba lagi sebentar.' });
      return;
    }
    const referenceNo = transfer.referenceNo || ('MBK-' + Date.now() + '-' + settlementId.slice(0, 6).toUpperCase());
    await db.settlementRequest.update({ where: { id: settlementId }, data: { referenceNo, note: '[MANUAL] menunggu PIN di tab Nobu' } }).catch(() => {});
    void logAction(req, { category: 'settlement', action: 'madera_manual_initiate', severity: 'critical', summary: 'Kirim Uang Manual Madera Rp ' + Number(amount).toLocaleString('id-ID') + ' ke ' + (bankName || bankCode) + ' ' + accountNumber + ' (' + (accountName || '-') + ')', targetType: 'SettlementRequest', targetId: settlementId, detail: { amount, bankCode, bankName, accountNumber, accountName, accountCode: account.code } });
    res.json({ ok: true, redirectUrl: transfer.redirectUrl, settlementId });
  } catch (err) {
    logger.error({ err, settlementId }, 'postMaderaManualInitiateApi error');
    if (settlementId) { await db.settlementRequest.update({ where: { id: settlementId }, data: { status: 'failed', note: '[MANUAL] error inisiasi' } }).catch(() => {}); }
    res.status(500).json({ ok: false, message: 'Gagal memulai transfer manual.' });
  }
}

// ── Halaman Send Money Manual (form gaya Nobu, dibuka di tab baru dari card) ──
export async function showManualSendPage(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) { res.status(404).send('Akun tidak ditemukan.'); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).send('Akun di luar akses Anda.'); return; }
    res.render('manual-send/index', {
      layout: false,
      title: 'Send Money Manual',
      accountId: account.id,
      accountCode: account.code,
      merchantName: (account as any).merchantName || account.code,
    });
  } catch (err) {
    logger.error({ err }, 'showManualSendPage error');
    res.status(500).send('Gagal memuat halaman Send Money Manual.');
  }
}


// ── History Order Kuota (mutasi report resmi: QRIS / Utama) ──
export async function showHistoryOrkut(req: Request, res: Response): Promise<void> {
  try {
    const wallet = req.params.wallet === 'utama' ? 'utama' : 'qris';
    const accountsRaw = await db.qrisAccount.findMany({
      where: {},
      orderBy: { code: 'asc' },
      select: { id: true, code: true, merchantName: true, status: true, lastQrisBalance: true, lastMainBalance: true, webReportUrlEncrypted: true, healthStatus: true },
    });
    const _scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const _scoped = _scopeIds ? accountsRaw.filter((a) => _scopeIds.includes(a.id)) : accountsRaw;
    const _resolveSite = buildResolver();
    const accounts = _scoped.map((a) => Object.assign({}, a, { siteName: _resolveSite(a.id).siteName || '', hasLink: !!(a as any).webReportUrlEncrypted }));
    const _scopeSite = getSiteScopeForUser(req.session.user as AccessUser | undefined);
    const sites = _scopeSite ? listSites().filter((s) => s.id === _scopeSite) : listSites();
    res.render('history-orkut/index', { title: 'History Order Kuota', wallet, accounts, sites });
  } catch (err) {
    logger.error({ err }, 'showHistoryOrkut error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

export async function getHistoryOrkutMutationsApi(req: Request, res: Response): Promise<void> {
  try {
    const wallet = req.query.wallet === 'utama' ? 'utama' : 'qris';
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId } });
    if (!account) { res.status(404).json({ ok: false, message: 'Akun tidak ditemukan.' }); return; }
    if (!accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).json({ ok: false, message: 'Akun di luar akses Anda.' }); return; }
    if (!(account as any).webReportUrlEncrypted) { res.json({ ok: false, message: 'Akun ini belum punya Link Web Report. Pasang dulu di menu Merchant QR.' }); return; }
    const payload = await fetchReportWalletLive(account, wallet, 5);
    if (!payload) { res.json({ ok: false, message: 'Gagal ambil mutasi (login report gagal / kadaluarsa). Cek Link Web Report.' }); return; }
    const items = (payload.mutations || []).slice(0, 50).map((m) => {
      let desc: string = m.issuerName || '';
      try { const r = JSON.parse(m.rawDataJson); desc = r.description || r.keterangan || desc; } catch { /* ignore */ }
      return { time: m.transactionTime, desc, amount: m.amount, type: m.type, balanceAfter: m.balanceAfter, rrn: m.rrn };
    });
    res.json({ ok: true, wallet, count: payload.count, balance: payload.balance, accountName: payload.meta?.accountName || null, items });
  } catch (err) {
    logger.error({ err }, 'getHistoryOrkutMutationsApi error');
    res.status(500).json({ ok: false, message: 'Gagal mengambil mutasi report.' });
  }
}

export async function getHistoryOrkutOpenApi(req: Request, res: Response): Promise<void> {
  try {
    const account = await db.qrisAccount.findUnique({ where: { id: req.params.accountId }, select: { id: true, webReportUrlEncrypted: true } });
    if (!account || !accountInScope(req.session.user as AccessUser | undefined, account.id)) { res.status(403).send('Akses ditolak.'); return; }
    if (!(account as any).webReportUrlEncrypted) { res.status(400).send('Akun ini belum punya Link Web Report.'); return; }
    const target = decrypt((account as any).webReportUrlEncrypted);
    res.redirect(target);
  } catch (err) {
    logger.error({ err }, 'getHistoryOrkutOpenApi error');
    res.status(500).send('Gagal membuka Web Report.');
  }
}


// ── Live saldo (baca DB, tanpa app-api) + feed paid utk animasi card Kirim Uang ──
export async function handleAccountBalancesApi(req: Request, res: Response): Promise<void> {
  try {
    const scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const rows = await db.qrisAccount.findMany({
      where: {
        status: 'active',
        ...(scopeIds !== null ? { id: { in: scopeIds } } : {}),
      },
      select: { id: true, lastQrisBalance: true, lastMainBalance: true, lastMaderaBalance: true, lastBalanceSyncAt: true },
    });
    res.json({
      ok: true,
      accounts: rows.map((a) => ({
        id: a.id,
        lastQrisBalance: a.lastQrisBalance,
        lastMainBalance: a.lastMainBalance,
        lastMaderaBalance: a.lastMaderaBalance,
        lastBalanceSyncAt: a.lastBalanceSyncAt ? a.lastBalanceSyncAt.toISOString() : null,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'handleAccountBalancesApi error');
    res.status(500).json({ ok: false, error: 'Gagal ambil saldo.' });
  }
}

export async function handleRecentPaidApi(req: Request, res: Response): Promise<void> {
  try {
    const scopeIds = getScopeAccountIds(req.session.user as AccessUser | undefined);
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : '';
    const parsed = sinceRaw ? new Date(sinceRaw) : null;
    const since = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() - 15000);
    const rows = await db.transaction.findMany({
      where: {
        statusPay: 'paid',
        paidAt: { gt: since },
        ...(scopeIds !== null ? { qrisAccountId: { in: scopeIds } } : {}),
      },
      select: { qrId: true, qrisAccountId: true, userIdExt: true, finalAmount: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
      take: 30,
    });
    res.json({
      ok: true,
      serverNow: new Date().toISOString(),
      paid: rows.map((t) => ({
        qrId: t.qrId,
        accountId: t.qrisAccountId,
        user: t.userIdExt,
        amount: t.finalAmount,
        paidAt: t.paidAt ? t.paidAt.toISOString() : null,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'handleRecentPaidApi error');
    res.status(500).json({ ok: false, error: 'Gagal ambil paid terbaru.' });
  }
}


// ── Retry deposit (force kirim SEKARANG) & Kredit Manual (tandai BERHASIL + kunci) ──
export async function postDashRetryDeposit(req: Request, res: Response): Promise<void> {
  const { qrId } = req.params;
  try {
    const tx = await db.transaction.findUnique({
      where: { qrId },
      select: { id: true, statusPay: true, statusBot: true, userIdExt: true },
    });
    if (!tx) { res.status(404).json({ ok: false, message: 'Transaksi tidak ditemukan' }); return; }
    if (tx.statusPay !== 'paid') { res.status(400).json({ ok: false, message: 'Hanya transaksi PAID yang bisa di-retry' }); return; }
    if (!['deposit_failed', 'manual_review'].includes(tx.statusBot)) {
      res.status(400).json({ ok: false, message: `Retry hanya untuk status GAGAL/REVIEW (kini: ${tx.statusBot})` }); return;
    }
    await attemptDeposit(tx.id, { force: true });
    const after = await db.transaction.findUnique({ where: { id: tx.id }, select: { statusBot: true } });
    const ok = after?.statusBot === 'deposit_success';
    void logAction(req, { category: 'generate-qr', action: 'deposit_retry_force', severity: 'important', status: ok ? 'success' : 'failed', summary: `Retry deposit ${ok ? 'BERHASIL' : 'masih gagal'} — user ${tx.userIdExt}`, targetType: 'Transaction', targetId: qrId, targetName: tx.userIdExt });
    res.json({ ok, statusBot: after?.statusBot, message: ok ? 'Deposit BERHASIL dikirim ke panel.' : 'Bot mencoba lagi tapi masih gagal — status tetap REVIEW.' });
  } catch (err) {
    logger.error({ err, qrId }, 'postDashRetryDeposit error');
    res.status(500).json({ ok: false, message: err instanceof Error ? err.message : 'Gagal retry deposit' });
  }
}

export async function postDashManualCredit(req: Request, res: Response): Promise<void> {
  const { qrId } = req.params;
  try {
    const u = req.session.user as { username?: string; name?: string; id?: string } | undefined;
    const actor = String(u?.username || u?.name || u?.id || 'operator');
    await manualCreditDeposit(qrId, actor);
    void logAction(req, { category: 'generate-qr', action: 'deposit_manual_credit', severity: 'critical', status: 'success', summary: `Kredit MANUAL (tandai BERHASIL) oleh ${actor}`, targetType: 'Transaction', targetId: qrId });
    res.json({ ok: true, message: 'Ditandai BERHASIL (kredit manual). Bot tidak akan mengkredit lagi.' });
  } catch (err) {
    logger.error({ err, qrId }, 'postDashManualCredit error');
    res.status(400).json({ ok: false, message: err instanceof Error ? err.message : 'Gagal kredit manual' });
  }
}
