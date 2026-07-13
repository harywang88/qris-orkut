import { Request, Response } from 'express';
import { execFile } from 'child_process';

// Menu "Cari Selisih" — rekonsiliasi ledger Nagox (rek. QRIS KITA 466) vs DB qris-orkut.
// Memanggil /opt/qris-orkut/nagox/nagox_recon.py --pull <tanggal> --json (auto-login + cache).
const RECON_SCRIPT = '/opt/qris-orkut/nagox/nagox_recon.py';

// Tanggal WIB (UTC+7) format YYYY-MM-DD; offsetDays -1 = kemarin.
function wibDate(offsetDays = 0): string {
  const t = new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return t.toISOString().slice(0, 10);
}

export async function showCariSelisih(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.tanggal === 'string' ? req.query.tanggal : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : wibDate(-1); // default: kemarin (hari yg sudah tutup)

  const result = await new Promise<Record<string, unknown>>((resolve) => {
    execFile(
      'python3',
      [RECON_SCRIPT, '--pull', date, '--json'],
      { timeout: 90_000, maxBuffer: 24 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!stdout) {
          resolve({ error: String(stderr || (err && err.message) || 'gagal menjalankan rekonsiliasi').slice(0, 400) });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ error: 'Gagal membaca hasil rekonsiliasi.' });
        }
      },
    );
  });

  res.render('cari-selisih/index', {
    title: 'Cari Selisih',
    date,
    today: wibDate(0),
    yesterday: wibDate(-1),
    result,
  });
}
