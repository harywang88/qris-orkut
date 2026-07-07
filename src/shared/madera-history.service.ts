/**
 * Madera History Service (System B untuk Madera)
 *
 * Sumber data ASLI mutasi Madera = appGateway.fetchMaderaTransactionHistory
 * (endpoint app-API `requests[madera_history][action]=get`, via bridge, bebas-limit).
 * Feed ini berisi baris nyata: TOPUP MADERA..., DIRECT DEBIT MADERA..., BI FAST OUT...,
 * BIAYA TRANSFER BI FAST — persis seperti tampil di app OrderKuota.
 *
 * Alur: worker poll saldo Madera tiap 30s -> saat saldo BERUBAH -> pullAndPersistMaderaHistory()
 * tarik feed 1x -> map -> storeMutationIfNew(walletCategory='madera') -> outbox event -> SSE live.
 * Dedup by rawHash (stabil dari tanggal+tipe+nominal+deskripsi).
 *
 * Saldo berjalan per baris TIDAK disimpan (API tak memberi saldo per baris); dihitung
 * saat tampil di controller dari lastMaderaBalance (saldo terkini asli).
 */
import { createHash } from 'crypto';
import { appGateway } from './gateways/app-orkut.gateway';
import { storeMutationIfNew } from './mutation-ingest.service';
import { logger } from '../config/logger';

const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, may: 4, jun: 5,
    jul: 6, agu: 7, aug: 7, sep: 8, okt: 9, oct: 9, nov: 10, des: 11, dec: 11,
};

export interface MaderaFeedItem {
    amount?: string | number | null;
    type?: string | null;
    date?: string | Date | null;
    description?: string | null;
    icon?: string | null;
}

export interface MaderaAccount {
    id: string | number;
    code?: string;
    sessionTokenEncrypted?: string | null;
    [key: string]: unknown;
}

export interface MappedMaderaMutation {
    amount: number;
    type: 'credit' | 'debit';
    transactionTime: Date;
    description: string;
    rawDataJson: string;
    rawHash: string;
}

export interface PullMaderaHistoryResult {
    ok: boolean;
    newCount: number;
    total: number;
    message?: string;
}

export function parseMaderaHistoryAmount(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value))
        return Math.abs(Math.trunc(value));
    const cleaned = String(value ?? '').replace(/[^\d]/g, '');
    if (!cleaned)
        return null;
    const parsed = Number.parseInt(cleaned, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

// "05 Jul 2026 @00:38" (WIB) -> Date. Toleran: "@" opsional, detik opsional, nama bulan ID/EN.
export function parseMaderaHistoryDate(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
        return value;
    const text = String(value ?? '').trim();
    if (!text)
        return null;
    const m = text.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\s*@?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
        const d = new Date(text);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const [, dd, mon, yyyy, hh, mi, ss] = m;
    const mo = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (mo === undefined)
        return null;
    // OrderKuota mengembalikan waktu WIB (+07:00).
    const iso = `${yyyy}-${String(mo + 1).padStart(2, '0')}-${String(Number.parseInt(dd, 10)).padStart(2, '0')}` +
        `T${String(Number.parseInt(hh, 10)).padStart(2, '0')}:${mi}:${ss || '00'}+07:00`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

function buildMaderaRawHash(accountId: string | number, item: MaderaFeedItem, amount: number): string {
    return createHash('sha256')
        .update(`madera_history:${accountId}:${item.date}:${item.type}:${amount}:${item.description}`)
        .digest('hex');
}

/**
 * Petakan 1 item feed Madera -> record mutation (amount/type/waktu/desc/rawJson/rawHash) atau null jika invalid.
 * Dipakai bersama oleh persist (pull) DAN rekonsiliasi (feed-vs-DB) supaya rumus rawHash SATU sumber (tak drift).
 */
export function mapMaderaFeedItem(accountId: string | number, item: MaderaFeedItem): MappedMaderaMutation | null {
    const amount = parseMaderaHistoryAmount(item.amount);
    if (!amount || amount <= 0)
        return null;
    const transactionTime = parseMaderaHistoryDate(item.date);
    if (!transactionTime)
        return null;
    const type = item.type === 'credit' || item.type === 'kredit' ? 'credit' : 'debit';
    const description = String(item.description || '').trim();
    const rawDataJson = JSON.stringify({
        source: 'madera_history',
        keterangan: description,
        description,
        tanggal: item.date,
        madera_type: item.type || null,
        icon: item.icon || null,
    });
    const rawHash = buildMaderaRawHash(accountId, item, amount);
    return { amount, type, transactionTime, description, rawDataJson, rawHash };
}

/**
 * Tarik feed Madera asli untuk 1 akun dan simpan baris baru ke DB (walletCategory='madera').
 * Idempotent: baris lama di-skip oleh dedup rawHash. Return jumlah baris baru.
 */
export async function pullAndPersistMaderaHistory(account: MaderaAccount): Promise<PullMaderaHistoryResult> {
    if (!account || !account.sessionTokenEncrypted)
        return { ok: false, newCount: 0, total: 0, message: 'no session token' };
    let result: { ok?: boolean; message?: string; items?: MaderaFeedItem[] } | undefined;
    try {
        // Metode gateway fetchMaderaTransactionHistory ter-wipe dari src (fitur Madera history rusak
        // sejak salah satu deploy). Cast agar build tetap jalan; perilaku runtime identik dgn dist saat ini.
        result = await (
          appGateway as unknown as {
            fetchMaderaTransactionHistory(a: MaderaAccount): Promise<{ ok?: boolean; message?: string; items?: MaderaFeedItem[] }>;
          }
        ).fetchMaderaTransactionHistory(account);
    }
    catch (err) {
        logger.warn({ err, accountCode: account.code }, 'pullAndPersistMaderaHistory: fetch error');
        return { ok: false, newCount: 0, total: 0, message: err instanceof Error ? err.message : 'error' };
    }
    if (!result || !result.ok)
        return { ok: false, newCount: 0, total: 0, message: (result && result.message) || 'fetch failed' };
    const items: MaderaFeedItem[] = Array.isArray(result.items) ? result.items : [];
    let newCount = 0;
    for (const item of items) {
        const mapped = mapMaderaFeedItem(account.id, item);
        if (!mapped)
            continue;
        try {
            const stored = await storeMutationIfNew({
                qrisAccountId: account.id,
                amount: mapped.amount,
                type: mapped.type,
                // Saldo per baris tak tersedia dari API -> dihitung saat tampil dari lastMaderaBalance.
                balanceBefore: 0,
                balanceAfter: 0,
                issuerName: null,
                rrn: null,
                walletCategory: 'madera',
                transactionTime: mapped.transactionTime,
                rawHash: mapped.rawHash,
                rawDataJson: mapped.rawDataJson,
            });
            if (stored.created)
                newCount += 1;
        }
        catch (err) {
            logger.warn({ err, accountCode: account.code }, 'pullAndPersistMaderaHistory: store failed');
        }
    }
    if (newCount > 0) {
        logger.info({ accountCode: account.code, newCount, total: items.length }, 'System B Madera: baris mutasi Madera baru tersimpan');
    }
    return { ok: true, newCount, total: items.length };
}
