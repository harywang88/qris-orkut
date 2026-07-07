"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountFullError = void 0;
exports.findUniqueCode = findUniqueCode;
exports.createAmountLock = createAmountLock;
exports.reserveUniqueCode = reserveUniqueCode;
const logger_1 = require("../config/logger");
/** Thrown when all 999 unique codes for an account are currently in use. */
class AccountFullError extends Error {
    constructor(accountCode) {
        super(`QRIS account ${accountCode} has no available unique codes. All 999 slots are locked.`);
        this.name = 'AccountFullError';
    }
}
exports.AccountFullError = AccountFullError;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
/** Awal hari (00:00 WIB) dalam UTC — dasar reset harian nominal unik. */
function wibDayStart(now) {
    return new Date(Math.floor((now.getTime() + WIB_OFFSET_MS) / 86400000) * 86400000 - WIB_OFFSET_MS);
}
/** Kunci hari (YYYY-MM-DD WIB) — dilekatkan ke activeKey agar nominal boleh dipakai ulang besok. */
function wibDayKey(now) {
    return new Date(now.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}
/** Bulatkan KE ATAS ke kelipatan 1.000 (10.000->10.000; 10.123->11.000; 51.216->52.000). */
function roundUpToThousand(amount) {
    return Math.ceil(amount / 1000) * 1000;
}
/** Batas maksimal nominal QR (plafon). Di batas ini QR TIDAK diberi kode unik agar tak melewati batas. */
const MAX_QR_AMOUNT = 10000000;
/**
 * Phase 1: Cari kode unik (read-only). Wajib di dalam Prisma $transaction.
 * MODEL BARU (koko): base = nominal DIBULATKAN KE ATAS ke kelipatan 1.000; kode = urutan harian
 * per (akun, base), dihitung dari SEMUA lock hari ini (WIB) — tidak dibebaskan saat expired/paid,
 * sehingga 1 finalAmount = 1 member sepanjang hari (deteksi bayar-2x 100% akurat). Reset otomatis 00:00 WIB.
 * Anti-tabrakan: tiap base punya blok [base+1 .. base+999] eksklusif (karena kelipatan 1.000).
 */
async function findUniqueCode(tx, qrisAccountId, accountCode, requestedAmount) {
    const base = roundUpToThousand(requestedAmount);
    // Perlakuan khusus batas maksimal: nominal yang membulat ke >= 10.000.000 (mis. 9.999.001-10.000.000)
    // TETAP 10.000.000 TANPA kode unik (menambah kode akan melewati plafon). Konsekuensi: QR 10jt tidak
    // ber-nominal-unik (tak bisa dibedakan antar-member) — diterima karena ini plafon & sangat jarang.
    if (base >= MAX_QR_AMOUNT) {
        return { uniqueCode: 0, finalAmount: MAX_QR_AMOUNT, base: MAX_QR_AMOUNT };
    }
    const dayStart = wibDayStart(new Date());
    const todayLocks = await tx.amountLock.findMany({
        where: {
            qrisAccountId,
            createdAt: { gte: dayStart },
            finalAmount: { gte: base + 1, lte: base + 999 },
        },
        select: { finalAmount: true },
    });
    const occupiedCodes = new Set(todayLocks.map((l) => l.finalAmount - base));
    let uniqueCode = null;
    for (let code = 1; code <= 999; code++) {
        if (!occupiedCodes.has(code)) {
            uniqueCode = code;
            break;
        }
    }
    if (uniqueCode === null) {
        throw new AccountFullError(accountCode);
    }
    return { uniqueCode, finalAmount: base + uniqueCode, base };
}
/**
 * Phase 2: Persist the AmountLock after the Transaction record already exists.
 * The Transaction must be inserted first to satisfy the FK constraint.
 */
async function createAmountLock(tx, opts) {
    const { qrisAccountId, requestedAmount, uniqueCode, finalAmount, expiresAt, transactionId } = opts;
    const lock = await tx.amountLock.create({
        data: {
            qrisAccountId,
            requestedAmount,
            uniqueCode,
            finalAmount,
            activeKey: uniqueCode > 0 ? `${qrisAccountId}:${finalAmount}:${wibDayKey(new Date())}` : null,
            transactionId,
            expiresAt,
            status: 'active',
        },
    });
    logger_1.logger.debug({ uniqueCode, finalAmount, requestedAmount }, 'Amount lock reserved');
    return { uniqueCode, finalAmount, lockId: lock.id };
}
/**
 * Convenience wrapper: find a unique code and immediately persist the lock.
 * Only safe to call AFTER the Transaction record has been inserted in the same tx.
 */
async function reserveUniqueCode(opts) {
    const { tx, qrisAccountId, accountCode, requestedAmount, expiresAt, transactionId } = opts;
    const { uniqueCode, finalAmount } = await findUniqueCode(tx, qrisAccountId, accountCode, requestedAmount);
    return createAmountLock(tx, {
        qrisAccountId,
        requestedAmount,
        uniqueCode,
        finalAmount,
        expiresAt,
        transactionId,
    });
}
//# sourceMappingURL=amount-lock.service.js.map