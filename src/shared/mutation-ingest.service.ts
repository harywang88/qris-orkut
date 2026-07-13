import type { Mutation, Prisma } from '@prisma/client';
import { db } from '../config/database';
import { publishOutboxEvent } from './outbox.service';
import { createHash } from 'crypto';

type PrismaLike = typeof db | Prisma.TransactionClient;

// ONBOARDING CUTOFF: cache createdAt per akun (tak berubah seumur proses) utk saring transaksi LAMA akun baru.
const _acctCreatedAtMs = new Map<string, number>();
async function _accountCreatedAtMs(client: PrismaLike, accountId: string): Promise<number | null> {
  const cached = _acctCreatedAtMs.get(accountId);
  if (cached !== undefined) return cached;
  try {
    const a = await (client as typeof db).qrisAccount.findUnique({ where: { id: accountId }, select: { createdAt: true } });
    const ms = a && a.createdAt ? a.createdAt.getTime() : null;
    if (ms !== null) _acctCreatedAtMs.set(accountId, ms);
    return ms;
  } catch { return null; }
}

export interface MutationIngestInput {
  qrisAccountId: string;
  amount: number;
  type: string;
  balanceBefore: number;
  balanceAfter: number;
  issuerName?: string | null;
  rrn?: string | null;
  walletCategory?: string | null;
  transactionTime: Date;
  rawHash: string;
  rawDataJson: string;
  matchedTransactionId?: string | null;
  dedupKeyOverride?: string | null; // MADERA_AUDIT_C #17: kunci dedup khusus (baris Madera kembar); QRIS/Utama TIDAK memakainya
}

function buildMutationPayload(mutation: Mutation) {
  return {
    mutationId: mutation.id,
    qrisAccountId: mutation.qrisAccountId,
    amount: mutation.amount,
    type: mutation.type,
    balanceAfter: mutation.balanceAfter,
    rrn: mutation.rrn,
    issuerName: mutation.issuerName,
    walletCategory: mutation.walletCategory,
    matchedTransactionId: mutation.matchedTransactionId,
    transactionTime: mutation.transactionTime.toISOString(),
    createdAt: mutation.createdAt.toISOString(),
  };
}

/**
 * Hash kanonik "KTP transaksi" utk dedup lintas-sumber (app-api & web report).
 * Waktu dinormalkan: toISOString().slice(0,16) => UTC + tanpa detik (samakan HH:MM:SS app-api vs HH:MM report + zona waktu).
 * Ada RRN => RRN jangkar; tanpa RRN => fallback nominal+saldo+menit+type (saldo berjalan unik per transaksi).
 */
export function canonicalMutationHash(input: {
  rrn?: string | null;
  amount: number;
  balanceAfter: number;
  transactionTime: Date | string;
  type?: string | null;
}): string {
  let minute = '';
  try { minute = new Date(input.transactionTime).toISOString().slice(0, 16); } catch { minute = ''; }
  const amt = Math.round(Number(input.amount) || 0);
  const bal = Math.round(Number(input.balanceAfter) || 0);
  const type = (input.type || '').trim().toLowerCase();
  // NORRN-only (mutv2): rrn DIBUANG dari hash. Bukti empiris PSAMUDRA: app-api sering pakai RRN
  // (kadang rawId internal) sedangkan report ambil RRN berbeda => split rrn bikin 2 baris utk 1 uang.
  // saldoAkhir (saldo berjalan) unik per transaksi => type|amount|saldoAkhir|menitUTC cukup jadi
  // KTP lintas-sumber sekaligus anti-dobel. input.rrn tetap diterima tapi diabaikan di hash.
  const base = 'NORRN|' + type + '|' + amt + '|' + bal + '|' + minute;
  return createHash('sha256').update('mutv2|' + base).digest('hex');
}

export async function storeMutationIfNew(
  input: MutationIngestInput,
  client: PrismaLike = db,
): Promise<{ created: boolean; mutation: Mutation }> {
  // ONBOARDING CUTOFF: skip transaksi sebelum akun ditambah (createdAt). Melindungi data lampau akun baru.
  if (input.transactionTime instanceof Date && !isNaN(input.transactionTime.getTime())) {
    const _cutMs = await _accountCreatedAtMs(client, input.qrisAccountId);
    if (_cutMs !== null && input.transactionTime.getTime() < _cutMs) {
      return { created: false, mutation: null as unknown as Mutation };
    }
  }
  const dedupKey = input.dedupKeyOverride ?? canonicalMutationHash(input); // MADERA_AUDIT_C #17: override khusus Madera; default (QRIS/Utama) TAK berubah
  // Dedup di-SCOPE per-akun. dedupKey kanonik = type|amount|saldoAkhir|menitUTC TANPA accountId; utk Madera
  // balanceAfter selalu 0 -> fee tetap (mis. BIAYA TRANSFER BI FAST 2500) di menit sama BENTROK LINTAS-AKUN
  // sehingga baris akun lain ke-skip sbg "duplikat" palsu (mis. NGGICEL vs GDGCELL, 09:46 UTC 9 Jul).
  // Mutasi selalu milik 1 akun -> scope by qrisAccountId benar & TETAP dedup cross-source (app vs report) utk akun sama.
  const existing = await client.mutation.findFirst({ where: { dedupKey, qrisAccountId: input.qrisAccountId } });
  if (existing) {
    return { created: false, mutation: existing };
  }

  let mutation: Mutation;
  try {
    mutation = await client.mutation.create({
    data: {
      qrisAccountId: input.qrisAccountId,
      amount: input.amount,
      type: input.type,
      balanceBefore: input.balanceBefore,
      balanceAfter: input.balanceAfter,
      issuerName: input.issuerName ?? null,
      rrn: input.rrn ?? null,
      walletCategory: input.walletCategory ?? null,
      transactionTime: input.transactionTime,
      rawHash: input.rawHash,
      dedupKey,
      rawDataJson: input.rawDataJson,
      matchedTransactionId: input.matchedTransactionId ?? null,
    },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const byHash = await client.mutation.findUnique({ where: { rawHash: input.rawHash } });
      if (byHash) return { created: false, mutation: byHash };
    }
    throw err;
  }

  await publishOutboxEvent(
    {
      topic: 'mutation.created',
      aggregateType: 'mutation',
      aggregateId: mutation.id,
      qrisAccountId: mutation.qrisAccountId,
      payload: buildMutationPayload(mutation),
    },
    client,
  );

  return { created: true, mutation };
}

export async function publishMutationUpdated(
  mutation: Mutation,
  reason: 'detail_enriched' | 'matched' | 'manual_update',
  client: PrismaLike = db,
): Promise<void> {
  await publishOutboxEvent(
    {
      topic: 'mutation.updated',
      aggregateType: 'mutation',
      aggregateId: mutation.id,
      qrisAccountId: mutation.qrisAccountId,
      payload: {
        ...buildMutationPayload(mutation),
        reason,
      },
    },
    client,
  );
}
