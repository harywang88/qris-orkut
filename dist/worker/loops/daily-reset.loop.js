"use strict";
/**
 * Daily Reset Loop — reset usedToday tiap pergantian hari WIB (Asia/Jakarta, UTC+7).
 *
 * Idempotent & tahan-restart: TIDAK mengandalkan timer tepat jam 00:00. Tiap ~5 menit
 * (dan sekali saat start) cek: akun yang lastResetAt-nya SEBELUM tengah malam WIB hari ini
 * (atau null) -> usedToday=0, lastResetAt=now. Kalau worker mati saat midnight, reset tetap
 * terjadi pada tick pertama setelah hidup lagi. Reset hanya sekali per hari WIB per akun.
 *
 * Memperbaiki bug: dulu usedToday hanya bisa direset MANUAL -> "limit harian" jadi limit
 * seumur hidup, lama-lama akun terkena batas dailyLimit dan tak bisa generate lagi.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDailyResetLoop = startDailyResetLoop;
const database_1 = require("../../config/database");
const logger_1 = require("../../config/logger");
const INTERVAL_MS = 5 * 60 * 1000; // cek tiap 5 menit
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
let running = false;
/** Instant UTC dari tengah malam WIB hari ini (mis. 00:00 WIB = 17:00 UTC hari sebelumnya). */
function startOfWibDayUtc(now) {
    const wib = new Date(now.getTime() + WIB_OFFSET_MS);
    const wibMidnightAsUtc = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), 0, 0, 0, 0);
    return new Date(wibMidnightAsUtc - WIB_OFFSET_MS);
}
async function tick() {
    const now = new Date();
    const boundary = startOfWibDayUtc(now);
    // lastResetAt = DateTime @default(now()) (non-nullable) -> tak pernah null, cukup filter '< boundary'.
    const res = await database_1.db.qrisAccount.updateMany({
        where: { lastResetAt: { lt: boundary } },
        data: { usedToday: 0, lastResetAt: now },
    });
    if (res.count > 0) {
        logger_1.logger.info({ count: res.count, wibMidnightUtc: boundary.toISOString() }, 'Daily reset: usedToday direset ke 0 (pergantian hari WIB)');
    }
}
function startDailyResetLoop() {
    logger_1.logger.info({ intervalMs: INTERVAL_MS }, 'Daily reset loop started (usedToday reset per hari WIB)');
    tick().catch((err) => logger_1.logger.error({ err }, 'Daily reset initial tick error'));
    setInterval(() => {
        if (running)
            return;
        running = true;
        tick()
            .catch((err) => logger_1.logger.error({ err }, 'Daily reset loop error'))
            .finally(() => { running = false; });
    }, INTERVAL_MS);
}
//# sourceMappingURL=daily-reset.loop.js.map
