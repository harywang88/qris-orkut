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
export declare function parseMaderaHistoryAmount(value: unknown): number | null;
export declare function parseMaderaHistoryDate(value: unknown): Date | null;
/**
 * Petakan 1 item feed Madera -> record mutation (amount/type/waktu/desc/rawJson/rawHash) atau null jika invalid.
 * Dipakai bersama oleh persist (pull) DAN rekonsiliasi (feed-vs-DB) supaya rumus rawHash SATU sumber (tak drift).
 */
export declare function mapMaderaFeedItem(accountId: string | number, item: MaderaFeedItem): MappedMaderaMutation | null;
/**
 * Tarik feed Madera asli untuk 1 akun dan simpan baris baru ke DB (walletCategory='madera').
 * Idempotent: baris lama di-skip oleh dedup rawHash. Return jumlah baris baru.
 */
export declare function pullAndPersistMaderaHistory(account: MaderaAccount): Promise<PullMaderaHistoryResult>;
