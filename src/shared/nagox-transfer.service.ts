/**
 * Nagox Transfer (Fase 2) — catat transfer Madera->Bank ke DB Nagox saat CS "Approve".
 * - Sidecar `data/nagox-transfers.json`: status pencatatan per SettlementRequest.id.
 * - callNagoxTransfer(): spawn python `nagox/nagox_transfer.py` (login + POST /bank-transfers).
 * Anti-dobel: python pakai REF unik + verifikasi daftar; di sini kita bedakan
 * 'unknown' (timeout/kill = TIDAK PASTI) dari 'fail'. TIDAK menyimpan kredensial.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { logger } from '../config/logger';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'nagox-transfers.json');

export type NagoxTfStatus = 'ok' | 'fail' | 'rejected' | 'pending' | 'unknown';
export interface NagoxTfRecord {
  status: NagoxTfStatus;
  at: string;
  message?: string;
  pengirim?: string;
  penerima?: string;
}

/** Baca ketat: {} hanya bila file belum ada; error baca lain dilempar (cegah clobber). */
function readStrict(): Record<string, NagoxTfRecord> {
  let raw: string;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? (j as Record<string, NagoxTfRecord>) : {};
  } catch {
    return {};
  }
}

export function readNagoxTransfers(): Record<string, NagoxTfRecord> {
  try {
    return readStrict();
  } catch {
    return {};
  }
}

export function getNagoxTransfer(id: string): NagoxTfRecord | null {
  return readNagoxTransfers()[id] || null;
}

export function setNagoxTransfer(id: string, rec: NagoxTfRecord): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const all = readStrict(); // lempar bila baca gagal -> jangan timpa/clobber record lain
    all[id] = rec;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logger.error({ err }, 'setNagoxTransfer gagal');
    throw err;
  }
}

export interface NagoxTransferInput {
  settlementId: string;
  norekPenerima: string;
  bankPenerima?: string;
  panel?: string;
  nominal: number;
  nilaiBiaya: number;
  catatan: string;
  dryRun?: boolean;
}

export interface NagoxTransferResult {
  ok: boolean;
  message: string;
  pengirim?: string;
  penerima?: string;
  already?: boolean;
  unknown?: boolean; // status TIDAK PASTI (timeout/putus) -> jangan vonis gagal
  dryRun?: boolean;
}

export function callNagoxTransfer(input: NagoxTransferInput): NagoxTransferResult {
  const pyBin = process.env.NAGOX_PYTHON_BIN || '/usr/bin/python3';
  const script = path.join(process.cwd(), 'nagox', 'nagox_transfer.py');
  const payload = JSON.stringify({
    settlement_id: input.settlementId,
    norek_penerima: input.norekPenerima,
    bank_penerima: input.bankPenerima || '',
    panel: input.panel || '',
    nominal: input.nominal,
    nilai_biaya: input.nilaiBiaya,
    jenis_biaya: 'flat',
    catatan: input.catatan,
    dry_run: !!input.dryRun,
  });
  const proc = spawnSync(pyBin, [script], { input: payload, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const out = String(proc.stdout || '');
  const m = out.match(/NAGOXTF_JSON_BEGIN\s*([\s\S]*?)\s*NAGOXTF_JSON_END/);
  if (!m) {
    const errCode = proc.error ? (proc.error as NodeJS.ErrnoException).code : undefined;
    if (errCode === 'ENOENT') {
      return { ok: false, message: 'Python/NAGOX_PYTHON_BIN tidak ditemukan.' };
    }
    // timeout/kill (SIGTERM/ETIMEDOUT) = POST MUNGKIN sudah terkirim -> TIDAK PASTI
    if (proc.signal === 'SIGTERM' || errCode === 'ETIMEDOUT') {
      logger.warn({ signal: proc.signal, errCode }, 'callNagoxTransfer: timeout/kill (unknown)');
      return { ok: false, unknown: true, message: 'Timeout - status TIDAK PASTI. Cek manual di Nagox sebelum ulang.' };
    }
    logger.warn({ stderr: String(proc.stderr || '').slice(-300) }, 'callNagoxTransfer: no marker');
    return { ok: false, unknown: true, message: 'Script Nagox tak memberi hasil jelas - status TIDAK PASTI.' };
  }
  try {
    const j = JSON.parse(m[1].trim()) as {
      ok?: boolean; message?: string; pengirim?: string; penerima?: string;
      already?: boolean; indeterminate?: boolean; dry_run?: boolean;
    };
    return {
      ok: !!j.ok,
      message: String(j.message || ''),
      pengirim: j.pengirim,
      penerima: j.penerima,
      already: !!j.already,
      unknown: !!j.indeterminate,
      dryRun: j.dry_run,
    };
  } catch {
    return { ok: false, unknown: true, message: 'Output pencatatan Nagox tidak valid - status TIDAK PASTI.' };
  }
}
