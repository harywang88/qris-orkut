import type { QrisAccount } from '@prisma/client';
import type { IOrkutGateway, QrGenerationResult, RecheckResult, RawMutation } from './gateway.interface';
export declare class RealOrkutGateway implements IOrkutGateway {
    /**
     * Fetches QRIS payment mutations from orderkuota.com/akun/riwayat-saldo
     * by scraping the HTML using the session cookies stored on the account.
     *
     * Returns empty array if no cookies are configured.
     */
    fetchMutations(account: QrisAccount): Promise<RawMutation[]>;
    generateQr(_account: QrisAccount, _finalAmount: number, _note: string): Promise<QrGenerationResult>;
    recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult>;
}
export declare const realGateway: RealOrkutGateway;
