/**
 * Operational Cutoff (Mulai Operasional) — batas tampilan daftar.
 * Transaksi SEBELUM cutoff DISEMBUNYIKAN (bukan dihapus) di semua menu daftar,
 * kecuali diminta "Tampilkan Semua" (?all=1). Sidecar `data/operational-cutoff.json`.
 * Saldo carry-over TIDAK berubah (hide = display saja).
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';

const FILE = path.join(process.cwd(), 'data', 'operational-cutoff.json');

export interface OperationalCutoff {
  cutoffMs: number;
  enabled: boolean;
  updatedAt?: string;
}

export function getOperationalCutoff(): OperationalCutoff {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { cutoffMs: Number(j.cutoffMs) || 0, enabled: j.enabled !== false, updatedAt: j.updatedAt };
  } catch {
    return { cutoffMs: 0, enabled: false };
  }
}

export function setOperationalCutoff(cutoffMs: number, enabled: boolean): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cutoffMs, enabled, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logger.error({ err }, 'setOperationalCutoff gagal');
    throw err;
  }
}

/** Apakah request minta "Tampilkan Semua" (abaikan cutoff). */
export function isShowAll(req: { query?: Record<string, unknown> }): boolean {
  const v = req && req.query ? req.query.all : undefined;
  return v === '1' || v === 'true';
}

/** Date lower-bound utk filter daftar; null = tampilkan semua (cutoff nonaktif ATAU ?all=1). */
export function resolveListCutoffDate(showAll: boolean): Date | null {
  if (showAll) return null;
  const c = getOperationalCutoff();
  if (!c.enabled || !c.cutoffMs) return null;
  return new Date(c.cutoffMs);
}

/** Versi angka epoch-ms (utk sumber data non-Prisma / perbandingan manual). */
export function resolveListCutoffMs(showAll: boolean): number | null {
  if (showAll) return null;
  const c = getOperationalCutoff();
  if (!c.enabled || !c.cutoffMs) return null;
  return c.cutoffMs;
}
