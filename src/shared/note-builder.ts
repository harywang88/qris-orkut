/**
 * Builds the payment note attached to each QRIS transaction.
 *
 * Format: DDMMYY HHmmss ACCCODE USERID FINALAMOUNT
 *
 * Example:
 *   date     = 2026-03-21 14:05:09
 *   accCode  = "01WR"
 *   userId   = "USER123"
 *   final    = 50001
 *
 *   Result: "210326 140509 01WR USER123 50001"
 */
export function buildNote(
  date: Date,
  accCode: string,
  userId: string,
  finalAmount: number,
): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);

  const HH = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  return `${dd}${mm}${yy} ${HH}${min}${ss} ${accCode} ${userId} ${finalAmount}`;
}
