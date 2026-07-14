/**
 * Nagox Pending — auto-catat "Uang Pending" ke DB Nagox (POST /pendings) saat CS "Catat Pending".
 * - Konfig bank per-SITE (sidecar `data/nagox-pending-config.json`): { siteId: {panel, bankId, bankLabel} }.
 *   Diisi master via modal (dari daftar bank Nagox live) -> TANPA hardcode.
 * - Record per-mutasi (sidecar `data/nagox-pending-records.json`): { mutationId: {status, at, message} }.
 *   status 'ok' => tercatat di Nagox => Reset dikunci (hapus manual di Nagox).
 * - callNagoxPending(): spawn python `nagox/nagox_pending.py`. Anti-dobel di python (pre-check daftar).
 * TIDAK menyimpan kredensial (semua via nagox_service).
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { logger } from '../config/logger';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'nagox-pending-config.json');
const RECORD_FILE = path.join(DATA_DIR, 'nagox-pending-records.json');

export interface NagoxPendingSiteConfig { panel: string; bankId: string; bankLabel: string; }
export type NagoxPendStatus = 'ok' | 'fail' | 'unknown' | 'already';
export interface NagoxPendRecord { status: NagoxPendStatus; at: string; message?: string; bankLabel?: string; by?: string; }

function _readStrict<T>(file: string): Record<string, T> {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw err; }
  try { const j = JSON.parse(raw); return j && typeof j === 'object' ? (j as Record<string, T>) : {}; }
  catch { return {}; }
}
function _writeAtomic(file: string, data: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── Konfig bank per-site ──
export function listPendingConfig(): Record<string, NagoxPendingSiteConfig> {
  try { return _readStrict<NagoxPendingSiteConfig>(CONFIG_FILE); } catch { return {}; }
}
export function getPendingConfig(siteId: string): NagoxPendingSiteConfig | null {
  return listPendingConfig()[siteId] || null;
}
export function setPendingConfig(siteId: string, cfg: NagoxPendingSiteConfig | null): void {
  const all = _readStrict<NagoxPendingSiteConfig>(CONFIG_FILE);
  if (!cfg || !cfg.bankId || !cfg.panel) delete all[siteId];
  else all[siteId] = { panel: String(cfg.panel).toUpperCase(), bankId: String(cfg.bankId), bankLabel: String(cfg.bankLabel || '') };
  _writeAtomic(CONFIG_FILE, all);
}

// ── Record pencatatan per mutasi ──
export function listNagoxPendRecords(): Record<string, NagoxPendRecord> {
  try { return _readStrict<NagoxPendRecord>(RECORD_FILE); } catch { return {}; }
}
export function getNagoxPendRecord(mutationId: string): NagoxPendRecord | null {
  return listNagoxPendRecords()[mutationId] || null;
}
export function setNagoxPendRecord(mutationId: string, rec: NagoxPendRecord | null): void {
  const all = _readStrict<NagoxPendRecord>(RECORD_FILE);
  if (!rec) delete all[mutationId]; else all[mutationId] = rec;
  _writeAtomic(RECORD_FILE, all);
}
/** true bila mutasi ini SUDAH tercatat sukses di Nagox (Reset harus dikunci). */
export function isRecordedToNagox(mutationId: string): boolean {
  const r = getNagoxPendRecord(mutationId);
  return !!r && r.status === 'ok';
}

// ── Spawn python ──
function _spawn(payload: Record<string, unknown>): { ok: boolean; raw?: Record<string, unknown>; unknown?: boolean; message?: string } {
  const pyBin = process.env.NAGOX_PYTHON_BIN || '/usr/bin/python3';
  const script = path.join(process.cwd(), 'nagox', 'nagox_pending.py');
  const proc = spawnSync(pyBin, [script], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const out = String(proc.stdout || '');
  const m = out.match(/NAGOXPEND_JSON_BEGIN\s*([\s\S]*?)\s*NAGOXPEND_JSON_END/);
  if (!m) {
    const errCode = proc.error ? (proc.error as NodeJS.ErrnoException).code : undefined;
    if (errCode === 'ENOENT') return { ok: false, message: 'Python tidak ditemukan.' };
    if (proc.signal === 'SIGTERM' || errCode === 'ETIMEDOUT') return { ok: false, unknown: true, message: 'Timeout - status TIDAK PASTI, cek manual di Nagox.' };
    logger.warn({ stderr: String(proc.stderr || '').slice(-300) }, 'nagox-pending: no marker');
    return { ok: false, unknown: true, message: 'Skrip Nagox tak memberi hasil jelas.' };
  }
  try { const j = JSON.parse(m[1].trim()) as Record<string, unknown>; return { ok: !!j.ok, raw: j, unknown: !!j.indeterminate, message: String(j.message || '') }; }
  catch { return { ok: false, unknown: true, message: 'Output Nagox tidak valid.' }; }
}

export interface CatatPendingInput {
  ref?: string; tanggalWaktu: string; user?: string; panel: string;
  namaBankPengirim?: string; bankId: string; jumlah: number; dryRun?: boolean;
}
export interface CatatPendingResult { ok: boolean; message: string; unknown?: boolean; already?: boolean; bankLabel?: string; dryRun?: boolean; }

export function callNagoxPending(input: CatatPendingInput): CatatPendingResult {
  const r = _spawn({
    ref: input.ref || '', tanggal_waktu: input.tanggalWaktu, user: input.user || '',
    source_panel: input.panel, nama_bank_pengirim: input.namaBankPengirim || '',
    bank_penerima_id: input.bankId, jumlah: input.jumlah, dry_run: !!input.dryRun,
  });
  const raw = r.raw || {};
  return {
    ok: r.ok, message: r.message || '', unknown: r.unknown,
    already: !!raw.already, bankLabel: raw.bank_label as string | undefined, dryRun: !!raw.dry_run,
  };
}

/** Untuk modal konfig: daftar panel Nagox. */
export function nagoxListPanels(): { ok: boolean; panels: string[]; message?: string } {
  const r = _spawn({ list_panels: true });
  return { ok: r.ok, panels: (r.raw?.panels as string[]) || [], message: r.message };
}
/** Untuk modal konfig: daftar bank {id,label} pada 1 panel. */
export function nagoxListBanks(panel: string): { ok: boolean; banks: { id: string; label: string }[]; message?: string } {
  const r = _spawn({ list_banks: true, source_panel: panel });
  return { ok: r.ok, banks: (r.raw?.banks as { id: string; label: string }[]) || [], message: r.message };
}
