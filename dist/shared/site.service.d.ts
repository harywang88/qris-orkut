export interface Site {
    id: string;
    name: string;
    color?: string;
    createdAt?: number;
}
export type SiteColored = Site & {
    color: string;
};
type AccountSiteMap = Record<string, string>;
export declare function listSites(): SiteColored[];
export declare function getSiteById(id: string | null | undefined): SiteColored | null;
export declare function createSite(name: string, color?: string): SiteColored;
export declare function updateSite(id: string, patch: string | {
    name?: string;
    color?: string;
}): SiteColored;
export declare function deleteSite(id: string): void;
export declare function getAccountSiteMap(): AccountSiteMap;
export declare function siteIdForAccount(accountId: string | null | undefined): string | null;
export declare function siteNameForAccount(accountId: string | null | undefined): string | null;
/**
 * Daftar accountId yang ditugaskan ke sebuah site (dipakai scope alias-tenant).
 * siteId nyata saja (bukan 'none'); akun tak ter-assign tak ada di map.
 */
export declare function accountIdsForSite(siteId: string | null | undefined): string[];
export declare function setAccountSite(accountId: string, siteId: string | null | undefined): void;
/**
 * Bangun resolver sekali (baca file 1x) -> fungsi(accountId) => { siteId, siteName }.
 * Dipakai saat memetakan BANYAK mutasi/transaksi dalam satu request (hemat I/O).
 */
export declare function buildResolver(): (accountId: string | null | undefined) => {
    siteId: string | null;
    siteName: string | null;
};
/**
 * Kembalikan salinan array akun dengan tambahan { siteId, siteName }.
 * Aman untuk objek Prisma (shallow copy).
 */
export declare function attachSiteInfo<T extends {
    id?: string;
}>(accounts: T[]): Array<T & {
    siteId: string | null;
    siteName: string | null;
}>;
export {};
