/**
 * Penyimpanan daftar Web Game (panel deposit) di SERVER — dibagi ke semua akun
 * yang punya akses menu Pengaturan (master + alias). Sebelumnya daftar ini hanya
 * di localStorage browser, jadi tak terlihat lintas-akun/perangkat.
 *
 * Sidecar JSON sederhana (pola sama dgn pending-tags / alias-accounts). Berisi
 * konfigurasi panel + cookie/apiKey — hanya diekspos ke pengguna ber-menu Pengaturan.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'webgame-sites.json');

export function readWebgameSites(): unknown[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function writeWebgameSites(sites: unknown[]): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Array.isArray(sites) ? sites : [], null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    logger.error({ err }, 'writeWebgameSites gagal');
    throw err;
  }
}
