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
export declare function buildNote(date: Date, accCode: string, userId: string, finalAmount: number): string;
