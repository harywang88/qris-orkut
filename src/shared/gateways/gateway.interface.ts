import type { QrisAccount } from '@prisma/client';

export interface QrGenerationResult {
  qrPayload: string;
  qrImageBase64: string;
}

export interface RecheckResult {
  status: 'pending' | 'paid';
  paidAmount?: number;
  issuerName?: string;
  rrn?: string;
}

export interface RawMutation {
  amount: number;
  type: 'credit' | 'debit';
  balanceBefore: number;
  balanceAfter: number;
  issuerName?: string;
  rrn?: string;
  walletCategory?: 'qris' | 'utama' | 'madera';
  transactionTime: Date;
  rawDataJson: string;
  rawHash: string;
}

/**
 * Interface that every QRIS gateway adapter must implement.
 *
 * MockOrkutGateway: safe local implementation (no network calls).
 * RealOrkutGateway: shell adapter for the real provider (configured via env).
 */
export interface IOrkutGateway {
  /** Generates the QR payload string and a base64 image from an account's QRIS data. */
  generateQr(
    account: QrisAccount,
    finalAmount: number,
    note: string,
  ): Promise<QrGenerationResult>;

  /**
   * Asks the gateway to re-check whether a given QR was paid.
   * Returns current payment status.
   */
  recheckTransaction(qrId: string, account: QrisAccount): Promise<RecheckResult>;

  /**
   * Fetches new mutations (incoming payments) for an account since the last poll.
   * Used by the worker's mutation-poll loop (Prompt 2).
   */
  fetchMutations(account: QrisAccount): Promise<RawMutation[]>;
}
