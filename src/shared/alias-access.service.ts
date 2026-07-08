/**
 * Akun Alias + Hak Akses per-menu (RBAC ringan, meniru Ayu Chen Bot).
 *
 * - Master = akun Prisma yang punya izin 'setting:manage' ATAU username 'harywang'.
 *   Master TIDAK disimpan di sini (login lewat Prisma) dan otomatis punya SEMUA akses.
 * - Alias = akun ringan disimpan di data/alias-accounts.json (password bcrypt) dengan
 *   perms per-menu + sub-aksi. Login alias lewat fallback di auth.service (verifyAliasLogin).
 *
 * perms = objek datar { "menu.sub": true, ... }. Menu terlihat bila "<menu>.view" true.
 * Menu 'akun-alias' MASTER-ONLY -> tak pernah bisa diberikan ke alias.
 */
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';

const ALIAS_FILE = path.join(process.cwd(), 'data', 'alias-accounts.json');

// ── Tipe ──────────────────────────────────────────────────────────────────────
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
  sensitive?: boolean;
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

// Definisi menu + sub-hak-akses (dipakai backend & frontend). Sub 'view' = izin buka menu.
export const MENU_DEFS: MenuDef[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: '/dashboard', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'generate-qr', label: 'Generate QR', icon: '🧾', path: '/dashboard/generate-qr', subs: [{ key: 'view', label: 'Lihat' }, { key: 'create', label: 'Buat QR' }] },
  { key: 'transactions', label: 'Transaction', icon: '💳', path: '/dashboard/transactions', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'mutasi-qris', label: 'Mutasi QRIS', icon: '🔁', path: '/dashboard/mutations/qris', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'mutasi-utama', label: 'Mutasi Utama', icon: '💰', path: '/dashboard/mutations/utama', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'mutasi-madera', label: 'Mutasi Madera', icon: '🏦', path: '/dashboard/mutations/madera', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'settlement', label: 'Settlement', icon: '💸', path: '/dashboard/settlement', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }, { key: 'transfer', label: 'Kirim Uang' }] },
  { key: 'merchant-qr', label: 'Merchant QR', icon: '🏪', path: '/merchant-qr', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Kelola' }] },
  { key: 'clients', label: 'API Client', icon: '🔑', path: '/clients', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Kelola' }] },
  { key: 'reports', label: 'Laporan', icon: '📈', path: '/reports', subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'login-logs', label: 'Login Logs', icon: '📜', path: '/dashboard/login-logs', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'admin-log', label: 'Admin Log', icon: '🛡️', path: '/admin-log', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'postgres', label: 'PostgreSQL', icon: '🗄️', path: '/dashboard/postgres-monitor', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }] },
  { key: 'settings', label: 'Pengaturan', icon: '⚙️', path: '/dashboard/account-settings', sensitive: true, subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Ubah' }] },
  { key: 'akun-alias', label: 'Akun Alias', icon: '👤', path: '/dashboard/akun-alias', masterOnly: true, subs: [{ key: 'view', label: 'Lihat' }] },
];

export function allPermKeys(includeMasterOnly: boolean): string[] {
  const out: string[] = [];
  for (const m of MENU_DEFS) {
    if (m.masterOnly && !includeMasterOnly) continue;
    for (const s of m.subs) out.push(`${m.key}.${s.key}`);
  }
  return out;
}

function loadAliases(): AliasRecord[] {
  try {
    if (!fs.existsSync(ALIAS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8'));
    return Array.isArray(raw) ? (raw as AliasRecord[]) : [];
  } catch (err) {
    logger.error({ err, file: ALIAS_FILE }, 'alias-access: gagal baca alias-accounts.json');
    return [];
  }
}

function saveAliases(list: AliasRecord[]): void {
  const dir = path.dirname(ALIAS_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* abaikan: direktori mungkin sudah ada */
  }
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function findAlias(username: unknown): AliasRecord | null {
  const needle = String(username || '').trim().toLowerCase();
  if (!needle) return null;
  return loadAliases().find((a) => String(a.username || '').toLowerCase() === needle) || null;
}

// Scope site untuk alias-tenant: '' / null = SEMUA site (alias di bawah master).
// siteId = terkunci ke 1 site. Dibaca LIVE dari JSON (seperti perms) -> tak perlu ubah sesi.
export function getSiteScopeForUser(user: AccessUser | null | undefined): string | null {
  if (!user || isMasterUser(user) || !user.isAlias) return null;
  const a = findAlias(user.username);
  const scope = a && typeof a.siteScope === 'string' ? a.siteScope.trim() : '';
  return scope || null;
}

// Master = user Prisma (bukan alias) dgn izin setting:manage ATAU username harywang.
export function isMasterUser(user: AccessUser | null | undefined): boolean {
  if (!user || user.isAlias) return false;
  const uname = String(user.username || '').trim().toLowerCase();
  if (uname === 'harywang') return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes('setting:manage');
}

// Normalisasi perms alias: semua key default false; 'akun-alias.*' selalu false.
function normalizeAliasPerms(saved: PermMap | null | undefined): PermMap {
  const out: PermMap = {};
  for (const key of allPermKeys(false)) {
    out[key] = !!(saved && saved[key]);
  }
  return out;
}

// Perms efektif utk user pada request ini. Master = semua true (termasuk akun-alias).
export function getMenuPermsForUser(user: AccessUser | null | undefined): PermMap {
  if (isMasterUser(user)) {
    const out: PermMap = {};
    for (const key of allPermKeys(true)) out[key] = true;
    return out;
  }
  if (user && user.isAlias) {
    const a = findAlias(user.username);
    return normalizeAliasPerms(a ? a.perms : {});
  }
  // User Prisma non-master (mis. operator lama): boleh LIHAT semua menu, tapi sub-AKSI (non-view)
  // default FALSE -> mencegah eskalasi hak (mis. Kirim Uang) tanpa sengaja. akun-alias tetap master-only.
  const out: PermMap = {};
  for (const m of MENU_DEFS) {
    if (m.masterOnly) continue;
    for (const s of m.subs) out[`${m.key}.${s.key}`] = s.key === 'view';
  }
  return out;
}

export function canViewMenu(perms: PermMap | null | undefined, menuKey: string): boolean {
  return !!(perms && perms[`${menuKey}.view`]);
}

export function canDo(perms: PermMap | null | undefined, menuKey: string, subKey: string): boolean {
  return !!(perms && perms[`${menuKey}.${subKey}`]);
}

// ── Login alias (dipanggil fallback di auth.service) ──────────────────────────
export async function verifyAliasLogin(
  username: string,
  password: string,
): Promise<AliasLoginResult | null> {
  const a = findAlias(username);
  if (!a || !password) return null;
  const hash = String(a.passwordHash || '').trim();
  if (!hash) return null;
  const ok = await bcrypt.compare(password, hash);
  if (!ok) return null;
  return { username: a.username, name: a.name || a.username, perms: normalizeAliasPerms(a.perms) };
}

// ── Daftar untuk tabel Akun Alias (master synthetic + alias) ──────────────────
export function listAccounts(masterUser: AccessUser | null | undefined): AccountRow[] {
  const masterPerms: PermMap = {};
  for (const key of allPermKeys(true)) masterPerms[key] = true;
  const master: AccountRow = {
    username: (masterUser && masterUser.username) || 'harywang',
    name: (masterUser && masterUser.fullName) || 'Harywang',
    role: 'master',
    isMaster: true,
    perms: masterPerms,
    siteScope: '',
    createdAt: null,
  };
  const aliases: AccountRow[] = loadAliases().map((a) => ({
    username: a.username,
    name: a.name || a.username,
    role: 'alias' as const,
    isMaster: false,
    perms: normalizeAliasPerms(a.perms),
    siteScope: a.siteScope || '',
    createdAt: a.createdAt || null,
  }));
  return [master, ...aliases];
}

// ── CRUD (master-only, dipanggil controller) ──────────────────────────────────
export async function createAlias(input: AliasCreateInput): Promise<void> {
  const username = String(input.username || '').trim();
  const name = String(input.name || '').trim() || username;
  const password = String(input.password || '');
  if (!username || !password) throw new Error('Username & password wajib diisi');
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw new Error('Username 3-32 karakter (huruf/angka/._-)');
  if (username.toLowerCase() === 'harywang') throw new Error('Username "harywang" khusus master');
  if (findAlias(username)) throw new Error('Username sudah dipakai');
  const list = loadAliases();
  list.push({
    username,
    name,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'alias',
    perms: normalizeAliasPerms(input.perms),
    siteScope: String(input.siteScope || '').trim(),
    createdAt: Math.floor(Date.now() / 1000),
  });
  saveAliases(list);
}

export async function updateAlias(username: string, input: AliasUpdateInput): Promise<void> {
  const list = loadAliases();
  const a = list.find(
    (x) => String(x.username || '').toLowerCase() === String(username || '').toLowerCase(),
  );
  if (!a) throw new Error('Akun alias tidak ditemukan');
  if (input.name != null && String(input.name).trim()) a.name = String(input.name).trim();
  if (input.password) a.passwordHash = await bcrypt.hash(String(input.password), 12);
  if (input.perms != null) a.perms = normalizeAliasPerms(input.perms);
  if (input.siteScope !== undefined) a.siteScope = String(input.siteScope || '').trim();
  saveAliases(list);
}

export function deleteAlias(username: string): void {
  const needle = String(username || '').toLowerCase();
  const list = loadAliases().filter((x) => String(x.username || '').toLowerCase() !== needle);
  saveAliases(list);
}
