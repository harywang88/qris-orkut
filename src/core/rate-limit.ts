/**
 * Rate limiter in-memory sederhana (sliding window), tanpa dependency eksternal.
 *
 * Dipakai untuk endpoint publik /widget/generate yang hanya dijaga widgetKey +
 * Origin allowlist. Origin bisa dipalsukan dari script (bukan browser), jadi
 * kita batasi jumlah permintaan per kunci (mis. per-IP) dalam jendela waktu.
 *
 * Catatan: state hanya di memori proses -> reset saat restart, dan tidak
 * dibagi antar-instance PM2. Untuk qris-app (1 instance) ini cukup sebagai
 * pertahanan dasar anti-spam. Kalau nanti scale multi-instance, ganti ke
 * store bersama (mis. Redis).
 */

interface Window {
  count: number;
  resetAt: number; // epoch ms saat jendela berakhir
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number; // sisa kuota di jendela ini
  retryAfterMs: number; // berapa lama lagi jendela reset (0 kalau masih allowed)
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly hits = new Map<string, Window>();
  private lastSweep = 0;

  constructor(opts: { windowMs: number; max: number }) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
  }

  /**
   * Catat satu percobaan untuk `key` dan kembalikan apakah diizinkan.
   * Memanggil ini SUDAH menghitung 1 hit bila diizinkan.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    this.maybeSweep(now);

    const existing = this.hits.get(key);
    if (!existing || now >= existing.resetAt) {
      // Jendela baru.
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterMs: 0 };
    }

    if (existing.count >= this.max) {
      return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
    }

    existing.count += 1;
    return { allowed: true, remaining: this.max - existing.count, retryAfterMs: 0 };
  }

  /** Bersihkan entri kedaluwarsa sesekali agar Map tidak tumbuh tanpa batas. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, win] of this.hits) {
      if (now >= win.resetAt) this.hits.delete(key);
    }
  }
}
