"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MENU_DEFS = void 0;
exports.allPermKeys = allPermKeys;
exports.getSiteScopeForUser = getSiteScopeForUser;
exports.isMasterUser = isMasterUser;
exports.getMenuPermsForUser = getMenuPermsForUser;
exports.canViewMenu = canViewMenu;
exports.canDo = canDo;
exports.verifyAliasLogin = verifyAliasLogin;
exports.listAccounts = listAccounts;
exports.createAlias = createAlias;
exports.updateAlias = updateAlias;
exports.deleteAlias = deleteAlias;
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
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("../config/logger");
const ALIAS_FILE = path_1.default.join(process.cwd(), 'data', 'alias-accounts.json');
// Definisi menu + sub-hak-akses (dipakai backend & frontend). Sub 'view' = izin buka menu.
exports.MENU_DEFS = [
    { key: 'dashboard', label: 'Dashboard', icon: '🏠', path: '/dashboard', subs: [{ key: 'view', label: 'Lihat' }] },
    { key: 'generate-qr', label: 'Generate QR', icon: '🧾', path: '/dashboard/generate-qr', subs: [{ key: 'view', label: 'Lihat' }, { key: 'create', label: 'Buat QR' }] },
    { key: 'transactions', label: 'Transaction', icon: '💳', path: '/dashboard/transactions', subs: [{ key: 'view', label: 'Lihat' }, { key: 'sync', label: 'Sinkron' }, { key: 'export', label: 'Export' }] },
    { key: 'mutasi-qris', label: 'Mutasi QRIS', icon: '🔁', path: '/dashboard/mutations/qris', subs: [{ key: 'view', label: 'Lihat' }, { key: 'sync', label: 'Sinkron' }, { key: 'reconcile', label: 'Cek Cocok' }] },
    { key: 'mutasi-utama', label: 'Mutasi Utama', icon: '💰', path: '/dashboard/mutations/utama', subs: [{ key: 'view', label: 'Lihat' }, { key: 'sync', label: 'Sinkron' }, { key: 'reconcile', label: 'Cek Cocok' }] },
    { key: 'mutasi-madera', label: 'Mutasi Madera', icon: '🏦', path: '/dashboard/mutations/madera', subs: [{ key: 'view', label: 'Lihat' }, { key: 'reconcile', label: 'Cek Sinkron' }] },
    { key: 'settlement', label: 'Settlement', icon: '💸', path: '/dashboard/settlement', subs: [{ key: 'view', label: 'Lihat' }, { key: 'transfer', label: 'Kirim Uang' }] },
    { key: 'merchant-qr', label: 'Merchant QR', icon: '🏪', path: '/merchant-qr', subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Kelola' }, { key: 'sync', label: 'Sinkron' }] },
    { key: 'clients', label: 'API Client', icon: '🔑', path: '/clients', subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Kelola' }] },
    { key: 'reports', label: 'Laporan', icon: '📈', path: '/reports', subs: [{ key: 'view', label: 'Lihat' }] },
    { key: 'login-logs', label: 'Login Logs', icon: '📜', path: '/dashboard/login-logs', subs: [{ key: 'view', label: 'Lihat' }] },
    { key: 'postgres', label: 'PostgreSQL', icon: '🗄️', path: '/dashboard/postgres-monitor', subs: [{ key: 'view', label: 'Lihat' }] },
    { key: 'settings', label: 'Pengaturan', icon: '⚙️', path: '/dashboard/account-settings', subs: [{ key: 'view', label: 'Lihat' }, { key: 'manage', label: 'Ubah' }] },
    { key: 'akun-alias', label: 'Akun Alias', icon: '👤', path: '/dashboard/akun-alias', masterOnly: true, subs: [{ key: 'view', label: 'Lihat' }] },
];
function allPermKeys(includeMasterOnly) {
    const out = [];
    for (const m of exports.MENU_DEFS) {
        if (m.masterOnly && !includeMasterOnly)
            continue;
        for (const s of m.subs)
            out.push(`${m.key}.${s.key}`);
    }
    return out;
}
function loadAliases() {
    try {
        if (!fs_1.default.existsSync(ALIAS_FILE))
            return [];
        const raw = JSON.parse(fs_1.default.readFileSync(ALIAS_FILE, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    }
    catch (err) {
        logger_1.logger.error({ err, file: ALIAS_FILE }, 'alias-access: gagal baca alias-accounts.json');
        return [];
    }
}
function saveAliases(list) {
    const dir = path_1.default.dirname(ALIAS_FILE);
    try {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
    catch (e) {
        /* abaikan: direktori mungkin sudah ada */
    }
    fs_1.default.writeFileSync(ALIAS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function findAlias(username) {
    const needle = String(username || '').trim().toLowerCase();
    if (!needle)
        return null;
    return loadAliases().find((a) => String(a.username || '').toLowerCase() === needle) || null;
}
// Scope site untuk alias-tenant: '' / null = SEMUA site (alias di bawah master).
// siteId = terkunci ke 1 site. Dibaca LIVE dari JSON (seperti perms) -> tak perlu ubah sesi.
function getSiteScopeForUser(user) {
    if (!user || isMasterUser(user) || !user.isAlias)
        return null;
    const a = findAlias(user.username);
    const scope = a && typeof a.siteScope === 'string' ? a.siteScope.trim() : '';
    return scope || null;
}
// Master = user Prisma (bukan alias) dgn izin setting:manage ATAU username harywang.
function isMasterUser(user) {
    if (!user || user.isAlias)
        return false;
    const uname = String(user.username || '').trim().toLowerCase();
    if (uname === 'harywang')
        return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('setting:manage');
}
// Normalisasi perms alias: semua key default false; 'akun-alias.*' selalu false.
function normalizeAliasPerms(saved) {
    const out = {};
    for (const key of allPermKeys(false)) {
        out[key] = !!(saved && saved[key]);
    }
    return out;
}
// Perms efektif utk user pada request ini. Master = semua true (termasuk akun-alias).
function getMenuPermsForUser(user) {
    if (isMasterUser(user)) {
        const out = {};
        for (const key of allPermKeys(true))
            out[key] = true;
        return out;
    }
    if (user && user.isAlias) {
        const a = findAlias(user.username);
        return normalizeAliasPerms(a ? a.perms : {});
    }
    // User Prisma non-master (mis. operator lama): boleh LIHAT semua menu, tapi sub-AKSI (non-view)
    // default FALSE -> mencegah eskalasi hak (mis. Kirim Uang) tanpa sengaja. akun-alias tetap master-only.
    const out = {};
    for (const m of exports.MENU_DEFS) {
        if (m.masterOnly)
            continue;
        for (const s of m.subs)
            out[`${m.key}.${s.key}`] = s.key === 'view';
    }
    return out;
}
function canViewMenu(perms, menuKey) {
    return !!(perms && perms[`${menuKey}.view`]);
}
function canDo(perms, menuKey, subKey) {
    return !!(perms && perms[`${menuKey}.${subKey}`]);
}
// ── Login alias (dipanggil fallback di auth.service) ──────────────────────────
async function verifyAliasLogin(username, password) {
    const a = findAlias(username);
    if (!a || !password)
        return null;
    const hash = String(a.passwordHash || '').trim();
    if (!hash)
        return null;
    const ok = await bcryptjs_1.default.compare(password, hash);
    if (!ok)
        return null;
    return { username: a.username, name: a.name || a.username, perms: normalizeAliasPerms(a.perms) };
}
// ── Daftar untuk tabel Akun Alias (master synthetic + alias) ──────────────────
function listAccounts(masterUser) {
    const masterPerms = {};
    for (const key of allPermKeys(true))
        masterPerms[key] = true;
    const master = {
        username: (masterUser && masterUser.username) || 'harywang',
        name: (masterUser && masterUser.fullName) || 'Harywang',
        role: 'master',
        isMaster: true,
        perms: masterPerms,
        siteScope: '',
        createdAt: null,
    };
    const aliases = loadAliases().map((a) => ({
        username: a.username,
        name: a.name || a.username,
        role: 'alias',
        isMaster: false,
        perms: normalizeAliasPerms(a.perms),
        siteScope: a.siteScope || '',
        createdAt: a.createdAt || null,
    }));
    return [master, ...aliases];
}
// ── CRUD (master-only, dipanggil controller) ──────────────────────────────────
async function createAlias(input) {
    const username = String(input.username || '').trim();
    const name = String(input.name || '').trim() || username;
    const password = String(input.password || '');
    if (!username || !password)
        throw new Error('Username & password wajib diisi');
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username))
        throw new Error('Username 3-32 karakter (huruf/angka/._-)');
    if (username.toLowerCase() === 'harywang')
        throw new Error('Username "harywang" khusus master');
    if (findAlias(username))
        throw new Error('Username sudah dipakai');
    const list = loadAliases();
    list.push({
        username,
        name,
        passwordHash: await bcryptjs_1.default.hash(password, 12),
        role: 'alias',
        perms: normalizeAliasPerms(input.perms),
        siteScope: String(input.siteScope || '').trim(),
        createdAt: Math.floor(Date.now() / 1000),
    });
    saveAliases(list);
}
async function updateAlias(username, input) {
    const list = loadAliases();
    const a = list.find((x) => String(x.username || '').toLowerCase() === String(username || '').toLowerCase());
    if (!a)
        throw new Error('Akun alias tidak ditemukan');
    if (input.name != null && String(input.name).trim())
        a.name = String(input.name).trim();
    if (input.password)
        a.passwordHash = await bcryptjs_1.default.hash(String(input.password), 12);
    if (input.perms != null)
        a.perms = normalizeAliasPerms(input.perms);
    if (input.siteScope !== undefined)
        a.siteScope = String(input.siteScope || '').trim();
    saveAliases(list);
}
function deleteAlias(username) {
    const needle = String(username || '').toLowerCase();
    const list = loadAliases().filter((x) => String(x.username || '').toLowerCase() !== needle);
    saveAliases(list);
}
//# sourceMappingURL=alias-access.service.js.map