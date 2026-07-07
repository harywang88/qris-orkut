/**
 * Site (Website) registry + pemetaan Akun QRIS -> Site.
 *
 * Tujuan: memisahkan mutasi/laporan per "site" (mis. Pempek Samudra, Sulebet).
 * Disimpan sebagai JSON sidecar (tanpa migrasi DB):
 *   - data/sites.json         -> [{ id, name, color?, createdAt }]
 *   - data/account-sites.json -> { "<qrisAccountId>": "<siteId>" }
 *
 * Dipakai oleh: modul qris-accounts (kelola site + assign akun), dashboard controller
 * (enrich mutasi dgn siteName), reports controller (grup per site).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../config/logger';

export interface Site {
  id: string;
  name: string;
  color?: string;
  createdAt?: number;
}

export type SiteColored = Site & { color: string };
type AccountSiteMap = Record<string, string>;

const DATA_DIR = path.join(process.cwd(), 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const MAP_FILE = path.join(DATA_DIR, 'account-sites.json');

function ensureDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw == null ? fallback : (raw as T);
  } catch (err) {
    logger.error({ err, file }, 'site.service: gagal baca ' + file);
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadSites(): Site[] {
  const raw = readJson<Site[]>(SITES_FILE, []);
  return Array.isArray(raw) ? raw : [];
}
function saveSites(list: Site[]): void {
  writeJson(SITES_FILE, list);
}
function loadMap(): AccountSiteMap {
  const raw = readJson<AccountSiteMap>(MAP_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}
function saveMap(map: AccountSiteMap): void {
  writeJson(MAP_FILE, map);
}

// ── Warna site (custom) ───────────────────────────────────────────────────────
const SITE_PALETTE = ['#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6', '#f97316', '#a855f7', '#06b6d4'];
function normalizeColor(c: unknown): string | null {
  const s = String(c || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
}
// Default warna STABIL per id (hash) — biar site lama (belum ada color) tetap konsisten.
function defaultColorFor(id: string): string {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return SITE_PALETTE[h % SITE_PALETTE.length];
}
function withColor(s: Site): SiteColored {
  return { ...s, color: normalizeColor(s.color) || defaultColorFor(s.id) };
}

// ── Site CRUD ────────────────────────────────────────────────────────────────
export function listSites(): SiteColored[] {
  return loadSites()
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id'))
    .map((s) => withColor(s));
}

export function getSiteById(id: string | null | undefined): SiteColored | null {
  if (!id) return null;
  const s = loadSites().find((x) => x.id === id);
  return s ? withColor(s) : null;
}

export function createSite(name: string, color?: string): SiteColored {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama site wajib diisi');
  if (clean.length > 60) throw new Error('Nama site maksimal 60 karakter');
  const list = loadSites();
  if (list.some((s) => String(s.name || '').toLowerCase() === clean.toLowerCase()))
    throw new Error('Nama site sudah dipakai');
  const id = 'site_' + crypto.randomBytes(6).toString('hex');
  const site: Site = {
    id,
    name: clean,
    color: normalizeColor(color) || defaultColorFor(id),
    createdAt: Math.floor(Date.now() / 1000),
  };
  list.push(site);
  saveSites(list);
  return withColor(site);
}

// patch = string (nama, backward-compat) ATAU { name?, color? }
export function updateSite(id: string, patch: string | { name?: string; color?: string }): SiteColored {
  const opts: { name?: string; color?: string } = typeof patch === 'string' ? { name: patch } : patch || {};
  const list = loadSites();
  const s = list.find((x) => x.id === id);
  if (!s) throw new Error('Site tidak ditemukan');
  if (opts.name !== undefined) {
    const clean = String(opts.name || '').trim();
    if (!clean) throw new Error('Nama site wajib diisi');
    if (clean.length > 60) throw new Error('Nama site maksimal 60 karakter');
    if (list.some((x) => x.id !== id && String(x.name || '').toLowerCase() === clean.toLowerCase()))
      throw new Error('Nama site sudah dipakai');
    s.name = clean;
  }
  if (opts.color !== undefined) {
    const col = normalizeColor(opts.color);
    if (col) s.color = col;
  }
  saveSites(list);
  return withColor(s);
}

export function deleteSite(id: string): void {
  const before = loadSites();
  const after = before.filter((s) => s.id !== id);
  if (after.length === before.length) throw new Error('Site tidak ditemukan');
  saveSites(after);
  // lepaskan akun yang tertaut ke site ini
  const map = loadMap();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (map[key] === id) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) saveMap(map);
}

// ── Pemetaan Akun -> Site ────────────────────────────────────────────────────
export function getAccountSiteMap(): AccountSiteMap {
  return loadMap();
}
export function siteIdForAccount(accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  const map = loadMap();
  return map[accountId] || null;
}
export function siteNameForAccount(accountId: string | null | undefined): string | null {
  const sid = siteIdForAccount(accountId);
  if (!sid) return null;
  const s = getSiteById(sid);
  return s ? s.name : null;
}
/**
 * Daftar accountId yang ditugaskan ke sebuah site (dipakai scope alias-tenant).
 * siteId nyata saja (bukan 'none'); akun tak ter-assign tak ada di map.
 */
export function accountIdsForSite(siteId: string | null | undefined): string[] {
  const sid = String(siteId || '').trim();
  if (!sid) return [];
  const map = loadMap();
  return Object.keys(map).filter((accId) => map[accId] === sid);
}
export function setAccountSite(accountId: string, siteId: string | null | undefined): void {
  if (!accountId) throw new Error('accountId wajib diisi');
  const map = loadMap();
  const sid = String(siteId || '').trim();
  if (!sid) {
    delete map[accountId];
  } else {
    if (!getSiteById(sid)) throw new Error('Site tidak ditemukan');
    map[accountId] = sid;
  }
  saveMap(map);
}

/**
 * Bangun resolver sekali (baca file 1x) -> fungsi(accountId) => { siteId, siteName }.
 * Dipakai saat memetakan BANYAK mutasi/transaksi dalam satu request (hemat I/O).
 */
export function buildResolver(): (
  accountId: string | null | undefined,
) => { siteId: string | null; siteName: string | null } {
  const map = loadMap();
  const byId: Record<string, Site> = {};
  for (const s of loadSites()) byId[s.id] = s;
  return function (accountId) {
    const sid = (accountId && map[accountId]) || null;
    const s = sid ? byId[sid] : null;
    return { siteId: sid, siteName: s ? s.name : null };
  };
}

/**
 * Kembalikan salinan array akun dengan tambahan { siteId, siteName }.
 * Aman untuk objek Prisma (shallow copy).
 */
export function attachSiteInfo<T extends { id?: string }>(
  accounts: T[],
): Array<T & { siteId: string | null; siteName: string | null }> {
  if (!Array.isArray(accounts)) return accounts;
  const map = loadMap();
  const byId: Record<string, Site> = {};
  for (const s of loadSites()) byId[s.id] = s;
  return accounts.map((a) => {
    const sid = (a && a.id && map[a.id]) || null;
    const s = sid ? byId[sid] : null;
    return { ...a, siteId: sid, siteName: s ? s.name : null };
  });
}
