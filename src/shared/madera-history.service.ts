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
import { db } from '../config/database';

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
    const _normType = String(item.type ?? '').trim().toLowerCase(); // MADERA_AUDIT_C #21: normalisasi case/spasi
    const type: 'credit' | 'debit' = (_normType === 'credit' || _normType === 'kredit') ? 'credit' : 'debit';
    if (_normType && !['credit', 'kredit', 'debit', 'debet'].includes(_normType)) {
        logger.warn({ accountId, maderaType: item.type }, 'mapMaderaFeedItem: tipe Madera tak dikenal -> dianggap debit');
    }
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
    // MADERA_AUDIT_C #17: baris Madera identik (akun+tanggal+tipe+nominal+desc sama) dlm 1 pull diberi
    // ORDINAL per grup supaya N transfer kembar tersimpan N (bukan 1). Ordinal 0 pakai rumus LAMA
    // (rawHash+dedup asli) -> baris existing TAK ter-insert ulang. Ordinal>=1 dapat kunci unik.
    // Order-independent: baris identik fungible -> himpunan kunci hanya bergantung JUMLAH.
    const _grpOrd = new Map<string, number>();
    // Simpan 1 baris (ORDINAL #17 tetap: N baris identik dlm 1 pull tersimpan N, bukan 1).
    const _storeRow = async (mapped: NonNullable<ReturnType<typeof mapMaderaFeedItem>>) => {
        const _ord = _grpOrd.get(mapped.rawHash) ?? 0;
        _grpOrd.set(mapped.rawHash, _ord + 1);
        const _rowHash = _ord === 0 ? mapped.rawHash : mapped.rawHash + ':' + _ord;
        const _dedupOverride = _ord === 0 ? undefined : 'mutv2-madera|' + mapped.rawHash + '|' + _ord;
        try {
            const stored = await storeMutationIfNew({
                qrisAccountId: String(account.id),
                amount: mapped.amount,
                type: mapped.type,
                // Saldo per baris tak tersedia dari API -> dihitung saat tampil dari lastMaderaBalance.
                balanceBefore: 0,
                balanceAfter: 0,
                issuerName: null,
                rrn: null,
                walletCategory: 'madera',
                transactionTime: mapped.transactionTime,
                rawHash: _rowHash,
                rawDataJson: mapped.rawDataJson,
                dedupKeyOverride: _dedupOverride,
            });
            if (stored.created)
                newCount += 1;
        }
        catch (err) {
            logger.warn({ err, accountCode: account.code }, 'pullAndPersistMaderaHistory: store failed');
        }
    };

    // MADERA_DUP_FIX (Opsi 1, 13 Jul): feed OrderKuota kadang beri transaksi DINI HARI dgn TANGGAL
    // SALAH (kemarin) di satu tarikan, lalu tanggal BENAR di tarikan berikutnya -> dedup lama (kunci
    // tanggal) lolos -> DOBEL (fee3/pencairan/topup). DEDUP TOLERAN-TANGGAL: baris DISTINCTIVE (nominal
    // unik) yg punya kembaran identik (akun+nominal+tujuan+jam-menit) beda ~24 jam -> PERTAHANKAN tanggal
    // BENAR (belakangan/stabil), buang yg AWAL (salah "kemarin"). Nominal unik -> mustahil salah-hapus
    // data asli. Fee (2500, generik) TIDAK di-dedup langsung (nominal tak unik=rawan); fee palsu dibuang
    // BARENG transfer palsunya (pasangan waktu sama).
    const _H = 3600000;
    const _clockMin = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes(); // beda kelipatan 24 jam -> menit sama UTC/WIB
    const _ketOf = (raw: string | null | undefined): string => { try { return String(JSON.parse(raw || '{}').keterangan || ''); } catch { return ''; } };
    const _isFee = (desc: string) => /biaya transfer/i.test(desc);
    const _mapped = items.map((it) => mapMaderaFeedItem(account.id, it)).filter((m): m is NonNullable<ReturnType<typeof mapMaderaFeedItem>> => Boolean(m));
    const _rejectedTs = new Set<number>(); // ms waktu baris SALAH (transfer di-skip) -> fee-nya ikut di-skip

    // PASS 1: baris DISTINCTIVE (bukan fee) -> dedup toleran-tanggal
    for (const mapped of _mapped) {
        if (_isFee(mapped.description)) continue;
        const _Tms = mapped.transactionTime.getTime();
        const _cands = await db.mutation.findMany({
            where: {
                qrisAccountId: String(account.id),
                walletCategory: 'madera',
                amount: mapped.amount,
                transactionTime: { gte: new Date(_Tms - 28 * _H), lte: new Date(_Tms + 28 * _H) },
            },
            select: { id: true, transactionTime: true, rawDataJson: true },
        });
        const _twin = _cands.find((c) => {
            const dh = Math.abs(c.transactionTime.getTime() - _Tms) / _H;
            return dh >= 20 && dh <= 28
                && _clockMin(c.transactionTime) === _clockMin(mapped.transactionTime)
                && _ketOf(c.rawDataJson) === mapped.description;
        });
        if (_twin) {
            if (_twin.transactionTime.getTime() < _Tms) {
                // twin = copy tanggal-AWAL (salah "kemarin") -> hapus twin + 1 fee pasangannya, simpan yg BENAR
                try {
                    await db.mutation.delete({ where: { id: _twin.id } });
                    const _wrongFee = await db.mutation.findFirst({
                        where: { qrisAccountId: String(account.id), walletCategory: 'madera', transactionTime: _twin.transactionTime, rawDataJson: { contains: 'BIAYA TRANSFER' } },
                        select: { id: true },
                    });
                    if (_wrongFee) await db.mutation.delete({ where: { id: _wrongFee.id } });
                    logger.warn({ accountCode: account.code, amount: mapped.amount, dari: _twin.transactionTime, ke: mapped.transactionTime }, 'Madera dedup: koreksi tanggal palsu (kemarin) -> benar');
                }
                catch (err) { logger.warn({ err, accountCode: account.code }, 'Madera dedup: gagal hapus twin palsu'); }
            } else {
                // baris ini = copy tanggal-AWAL (salah); twin di DB sudah BENAR (belakangan) -> skip + skip fee-nya
                _rejectedTs.add(_Tms);
                continue;
            }
        }
        await _storeRow(mapped);
    }

    // PASS 2: baris FEE -> lewati yg waktunya milik transfer palsu (di-skip di atas), sisanya simpan
    for (const mapped of _mapped) {
        if (!_isFee(mapped.description)) continue;
        if (_rejectedTs.has(mapped.transactionTime.getTime())) continue;
        await _storeRow(mapped);
    }
    if (newCount > 0) {
        logger.info({ accountCode: account.code, newCount, total: items.length }, 'System B Madera: baris mutasi Madera baru tersimpan');
    }
    return { ok: true, newCount, total: items.length };
}
