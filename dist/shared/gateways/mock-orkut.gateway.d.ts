import type { QrisAccount } from '@prisma/client';
import type { IOrkutGateway, QrGenerationResult, RecheckResult, RawMutation } from './gateway.interface';
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
export declare class MockOrkutGateway implements IOrkutGateway {
    generateQr(account: QrisAccount, finalAmount: number, _note: string): Promise<QrGenerationResult>;
    recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult>;
    fetchMutations(_account: QrisAccount): Promise<RawMutation[]>;
}
/** Singleton instance used throughout the application. */
export declare const mockGateway: MockOrkutGateway;
