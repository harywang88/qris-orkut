/**
 * Builds the payment note attached to each QRIS transaction.
 *
 * Format: QRIS-ACCCODE-USERID-YYYYMMDDHHmmss | Rp FINALAMOUNT
 *
 * Contoh:
 *   date     = 2026-07-09 12:43:12
 *   accCode  = "NGGICEL"
 *   userId   = "nagogilo"
 *   final    = 10002
 *
 *   Hasil: "QRIS-NGGICEL-nagogilo-20260709124312 | Rp 10.002"
 *
 * Note ini hanya untuk tampilan/keterangan (tidak dipakai untuk mencocokkan
 * pembayaran — matching pakai qrisAccountId + finalAmount + window waktu).
 */
export function buildNote(
  date: Date,
  accCode: string,
  userId: string,
  finalAmount: number,
): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());

  const HH = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  const stamp = `${yyyy}${mm}${dd}${HH}${min}${ss}`;
  const amountText = finalAmount.toLocaleString('id-ID');

  return `QRIS-${accCode}-${userId}-${stamp} | Rp ${amountText}`;
}
