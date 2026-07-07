export interface MenuSub {
    key: string;
    label: string;
}
export interface MenuDef {
    key: string;
    label: string;
    icon: string;
    path: string;
    subs: MenuSub[];
    masterOnly?: boolean;
}
export type PermMap = Record<string, boolean>;
/**
 * Bentuk user yang dipakai untuk menghitung hak akses. Sengaja permisif agar
 * kompatibel dengan session user Prisma (subset) maupun user alias.
 */
export interface AccessUser {
    id?: string;
    username?: string;
    fullName?: string;
    name?: string;
    permissions?: string[];
    isAlias?: boolean;
    [key: string]: unknown;
}
/** Record alias mentah seperti tersimpan di alias-accounts.json. */
export interface AliasRecord {
    username: string;
    name?: string;
    passwordHash?: string;
    role?: string;
    perms?: PermMap;
    siteScope?: string;
    createdAt?: number | null;
}
export interface AliasLoginResult {
    username: string;
    name: string;
    perms: PermMap;
}
export interface AccountRow {
    username: string;
    name: string;
    role: 'master' | 'alias';
    isMaster: boolean;
    perms: PermMap;
    siteScope: string;
    createdAt: number | null;
}
export interface AliasCreateInput {
    username?: string;
    name?: string;
    password?: string;
    perms?: PermMap;
    siteScope?: string;
}
export interface AliasUpdateInput {
    name?: string;
    password?: string;
    perms?: PermMap;
    siteScope?: string;
}
export declare const MENU_DEFS: MenuDef[];
export declare function allPermKeys(includeMasterOnly: boolean): string[];
export declare function getSiteScopeForUser(user: AccessUser | null | undefined): string | null;
export declare function isMasterUser(user: AccessUser | null | undefined): boolean;
export declare function getMenuPermsForUser(user: AccessUser | null | undefined): PermMap;
export declare function canViewMenu(perms: PermMap | null | undefined, menuKey: string): boolean;
export declare function canDo(perms: PermMap | null | undefined, menuKey: string, subKey: string): boolean;
export declare function verifyAliasLogin(username: string, password: string): Promise<AliasLoginResult | null>;
export declare function listAccounts(masterUser: AccessUser | null | undefined): AccountRow[];
export declare function createAlias(input: AliasCreateInput): Promise<void>;
export declare function updateAlias(username: string, input: AliasUpdateInput): Promise<void>;
export declare function deleteAlias(username: string): void;
