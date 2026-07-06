import QRCode from 'qrcode';
import type { QrisAccount } from '@prisma/client';
import type {
  IOrkutGateway,
  QrGenerationResult,
  RecheckResult,
  RawMutation,
} from './gateway.interface';
import { buildDynamicQrisPayload } from '../qris-payload';

/**
 * MockOrkutGateway — safe local implementation.
 *
 * - generateQr: uses the account's stored qrisPayload (or a placeholder) to
 *   produce a real QR code image via the `qrcode` npm library.
 * - recheckTransaction: always returns "pending" (the worker + DB mutations
 *   drive actual state changes; mock recheck is a no-op).
 * - fetchMutations: returns empty array (use scripts/simulate-payment.ts to
 *   inject mutations directly into the DB for testing).
 *
 * No network calls are made by this class.
 */
export class MockOrkutGateway implements IOrkutGateway {
  async generateQr(
    account: QrisAccount,
    finalAmount: number,
    _note: string,
  ): Promise<QrGenerationResult> {
    // Use the account's stored QRIS payload or fall back to a clearly mock value
    const basePayload =
      account.qrisPayload ??
      `MOCK_QRIS_PAYLOAD_${account.code}_${Date.now()}`;

    let qrPayload = basePayload;
    try {
      qrPayload = buildDynamicQrisPayload(basePayload, finalAmount);
    } catch {
      // Fall back to the stored payload when the QRIS string is malformed.
    }

    const qrImageBase64 = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    return { qrPayload, qrImageBase64 };
  }

  async recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult> {
    // The mock gateway always reports pending.
    // Actual paid status comes from mutation matching in the worker (Prompt 2).
    return { status: 'pending' };
  }

  async fetchMutations(_account: QrisAccount): Promise<RawMutation[]> {
    // No live polling in mock mode.
    // Use scripts/simulate-payment.ts to inject mutations into the DB directly.
    return [];
  }
}

/** Singleton instance used throughout the application. */
export const mockGateway = new MockOrkutGateway();
