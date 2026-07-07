/**
 * Orkut Fetch Scheduler
 *
 * Arsitektur baru:
 * - Local DB adalah sumber utama untuk dashboard + Python worker.
 * - OrderKuota hanya dipoll oleh worker scheduler ini.
 * - Setiap merchant punya interval custom sendiri dari menu Merchant QR.
 * - Akun aktif (punya transaksi open) diprioritaskan lebih cepat.
 * - Jika provider membalas 469, akun langsung cooldown 5 menit.
 */
export declare function startOrkutFetchLoop(): void;
