// Saldo Awal Manual (JANGKAR) + Baris BASELINE (awal operasional) untuk menu Laporan.
// Latar: saldo awal/akhir dulu dihitung "mundur" dari saldo terkini lewat mutasi. Untuk Madera,
// balanceBefore/After=0 -> walk-back bisa negatif. Solusi: jangkar (saldo awal harian) + baseline
// (baris tetap "awal operasional" dgn SEMUA kolom pasti). Saldo akhir hari D = jangkar hari D+1
// (buku berjalan, di-set otomatis oleh controller saat hari lampau ditutup).
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';

const ANCHOR_FILE = path.join(process.cwd(), 'data', 'report-opening-balance.json');
const BASELINE_FILE = path.join(process.cwd(), 'data', 'report-baseline.json');

type AnchorStore = Record<string, Record<string, number>>;
export interface BaselineRow {
  saldoAwal: number;
  nominal: number;
  pending: number;
  fee: number;
  fee2: number;
  fee3: number;
  pencairan: number;
  saldoAkhir: number;
}
type BaselineStore = Record<string, Record<string, BaselineRow>>;

function _readJson<T>(file: string, fallback: T): T {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as T) || fallback;
  } catch {
    return fallback;
  }
}
function _writeJson(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ err, file }, 'report-opening-balance: gagal tulis sidecar');
  }
}

// ── Jangkar saldo awal (scope, tanggal WIB 'YYYY-MM-DD') ──
export function getOpeningAnchor(scope: string, wibDate: string): number | null {
  const v = _readJson<AnchorStore>(ANCHOR_FILE, {})[scope]?.[wibDate];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function setOpeningAnchor(scope: string, wibDate: string, value: number | null): void {
  const store = _readJson<AnchorStore>(ANCHOR_FILE, {});
  if (!store[scope]) store[scope] = {};
  if (value === null || !Number.isFinite(value as number)) delete store[scope][wibDate];
  else store[scope][wibDate] = Math.round(value as number);
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  _writeJson(ANCHOR_FILE, store);
}
export function listOpeningAnchors(): AnchorStore {
  return _readJson<AnchorStore>(ANCHOR_FILE, {});
}

// ── Baris baseline "awal operasional" (semua kolom pasti) ──
export function getBaseline(scope: string, wibDate: string): BaselineRow | null {
  const r = _readJson<BaselineStore>(BASELINE_FILE, {})[scope]?.[wibDate];
  return r && typeof r.saldoAkhir === 'number' ? r : null;
}
export function setBaseline(scope: string, wibDate: string, row: BaselineRow | null): void {
  const store = _readJson<BaselineStore>(BASELINE_FILE, {});
  if (!store[scope]) store[scope] = {};
  if (row === null) delete store[scope][wibDate];
  else store[scope][wibDate] = row;
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  _writeJson(BASELINE_FILE, store);
}
export function listBaselines(): BaselineStore {
  return _readJson<BaselineStore>(BASELINE_FILE, {});
}

// ── Override STATUS rekonsiliasi Laporan (match/unmatch) per (scope, tanggal WIB) ──
// Untuk kasus koko sudah rekonsiliasi manual tapi walk-back saldo (Madera rapuh) tetap "unmatch".
// scope '*' = berlaku utk SEMUA scope pada tanggal itu (site + overall). Override DISPLAY saja.
const STATUS_FILE = path.join(process.cwd(), 'data', 'report-status-override.json');
type StatusStore = Record<string, Record<string, string>>;
export function getStatusOverride(scope: string, wibDate: string): 'match' | 'unmatch' | null {
  const v = _readJson<StatusStore>(STATUS_FILE, {})[scope]?.[wibDate];
  return v === 'match' || v === 'unmatch' ? v : null;
}
export function setStatusOverride(scope: string, wibDate: string, value: 'match' | 'unmatch' | null): void {
  const store = _readJson<StatusStore>(STATUS_FILE, {});
  if (!store[scope]) store[scope] = {};
  if (value !== 'match' && value !== 'unmatch') delete store[scope][wibDate];
  else store[scope][wibDate] = value;
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  _writeJson(STATUS_FILE, store);
}
export function listStatusOverrides(): StatusStore {
  return _readJson<StatusStore>(STATUS_FILE, {});
}

// ── Override PENCAIRAN Laporan (Madera->bank) per (scope, tanggal WIB) ──
// Koreksi manual: transfer dini hari kadang salah-label OrderKuota (mundur 1 hari) mengacaukan total.
// Override DISPLAY saja (juga dipakai di saldoAkhir); data mutasi tidak diubah.
const PENCAIRAN_FILE = path.join(process.cwd(), 'data', 'report-pencairan-override.json');
type PencairanStore = Record<string, Record<string, number>>;
export function getPencairanOverride(scope: string, wibDate: string): number | null {
  const v = _readJson<PencairanStore>(PENCAIRAN_FILE, {})[scope]?.[wibDate];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function setPencairanOverride(scope: string, wibDate: string, value: number | null): void {
  const store = _readJson<PencairanStore>(PENCAIRAN_FILE, {});
  if (!store[scope]) store[scope] = {};
  if (value === null || !Number.isFinite(value as number)) delete store[scope][wibDate];
  else store[scope][wibDate] = Math.round(value as number);
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  _writeJson(PENCAIRAN_FILE, store);
}
export function listPencairanOverrides(): PencairanStore {
  return _readJson<PencairanStore>(PENCAIRAN_FILE, {});
}

// ── Override FEE3 (biaya transfer Madera->bank) per (scope, tanggal WIB) ──
// Sumber SAMA dgn pencairan (Madera), kena salah-label tanggal yg sama (transfer dini hari
// dilabeli OrderKuota mundur 1 hari). Override DISPLAY saja (juga dipakai di saldoAkhir); data mutasi tak diubah.
const FEE3_FILE = path.join(process.cwd(), 'data', 'report-fee3-override.json');
export function getFee3Override(scope: string, wibDate: string): number | null {
  const v = _readJson<PencairanStore>(FEE3_FILE, {})[scope]?.[wibDate];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function setFee3Override(scope: string, wibDate: string, value: number | null): void {
  const store = _readJson<PencairanStore>(FEE3_FILE, {});
  if (!store[scope]) store[scope] = {};
  if (value === null || !Number.isFinite(value as number)) delete store[scope][wibDate];
  else store[scope][wibDate] = Math.round(value as number);
  if (Object.keys(store[scope]).length === 0) delete store[scope];
  _writeJson(FEE3_FILE, store);
}
export function listFee3Overrides(): PencairanStore {
  return _readJson<PencairanStore>(FEE3_FILE, {});
}
