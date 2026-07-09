/**
 * Daftar Bank per-site — rekening tujuan pencairan (Madera->bank) tersimpan.
 * JSON sidecar (tanpa migrasi DB), pola sama dgn site.service:
 *   - data/site-banks.json -> SiteBank[]
 * Dipakai: menu Daftar Bank (CRUD) + Kirim Uang (picker rekening tersimpan).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "../config/logger";
import { getSiteById } from "./site.service";

export interface SiteBank {
  id: string;
  siteId: string;
  bankCode: string;      // SWIFT/provider code (mis CENAIDJA)
  bankName: string;      // display (mis "Bank BCA")
  namaRekening: string;  // nama pemilik (hasil inquiry / manual)
  noRekening: string;    // nomor rekening
  createdAt?: number;
  createdBy?: string;
  updatedAt?: number;
}
export interface SiteBankInput {
  siteId: string; bankCode: string; bankName: string; namaRekening: string; noRekening: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "site-banks.json");

function ensureDir(): void { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ } }
function readAll(): SiteBank[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(raw) ? (raw as SiteBank[]) : [];
  } catch (err) { logger.error({ err, file: FILE }, "site-bank.service: gagal baca"); return []; }
}
function writeAll(data: SiteBank[]): void {
  ensureDir();
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, FILE);
}
function digits(s: unknown): string { return String(s ?? "").replace(/[^0-9]/g, ""); }

export function listBanks(siteId?: string | null): SiteBank[] {
  const all = readAll();
  return siteId ? all.filter((b) => b.siteId === siteId) : all;
}
export function listBanksForScope(scope: string | null): SiteBank[] {
  return scope ? readAll().filter((b) => b.siteId === scope) : readAll();
}
export function getBankById(id: string): SiteBank | null {
  return readAll().find((b) => b.id === id) || null;
}
export function bankExists(siteId: string, bankCode: string, noRekening: string, exceptId?: string): boolean {
  const no = digits(noRekening);
  return readAll().some((b) => b.siteId === siteId && b.bankCode === bankCode && digits(b.noRekening) === no && b.id !== exceptId);
}
export function createBank(input: SiteBankInput, createdBy?: string): SiteBank {
  if (!getSiteById(input.siteId)) throw new Error("Site tidak ditemukan");
  const noRek = digits(input.noRekening);
  if (!input.bankCode || !noRek) throw new Error("Bank & nomor rekening wajib diisi");
  if (bankExists(input.siteId, input.bankCode, noRek)) throw new Error("Rekening ini sudah terdaftar di site ini");
  const rec: SiteBank = {
    id: "bank_" + crypto.randomBytes(6).toString("hex"),
    siteId: input.siteId,
    bankCode: String(input.bankCode).trim(),
    bankName: String(input.bankName || "").trim(),
    namaRekening: String(input.namaRekening || "").trim(),
    noRekening: noRek,
    createdAt: Date.now(),
    createdBy: createdBy || undefined,
  };
  const all = readAll(); all.push(rec); writeAll(all);
  return rec;
}
export function updateBank(id: string, patch: Partial<SiteBankInput>): SiteBank | null {
  const all = readAll();
  const i = all.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const cur = all[i];
  const next: SiteBank = {
    ...cur,
    bankCode: patch.bankCode !== undefined ? String(patch.bankCode).trim() : cur.bankCode,
    bankName: patch.bankName !== undefined ? String(patch.bankName).trim() : cur.bankName,
    namaRekening: patch.namaRekening !== undefined ? String(patch.namaRekening).trim() : cur.namaRekening,
    noRekening: patch.noRekening !== undefined ? digits(patch.noRekening) : cur.noRekening,
    updatedAt: Date.now(),
  };
  if (bankExists(next.siteId, next.bankCode, next.noRekening, id)) throw new Error("Rekening ini sudah terdaftar di site ini");
  all[i] = next; writeAll(all);
  return next;
}
export function deleteBank(id: string): SiteBank | null {
  const all = readAll();
  const i = all.findIndex((b) => b.id === id);
  if (i < 0) return null;
  const [removed] = all.splice(i, 1);
  writeAll(all);
  return removed;
}
