"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mockGateway = exports.MockOrkutGateway = void 0;
const qrcode_1 = __importDefault(require("qrcode"));
const qris_payload_1 = require("../qris-payload");
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
class MockOrkutGateway {
    async generateQr(account, finalAmount, _note) {
        // Use the account's stored QRIS payload or fall back to a clearly mock value
        const basePayload = account.qrisPayload ??
            `MOCK_QRIS_PAYLOAD_${account.code}_${Date.now()}`;
        let qrPayload = basePayload;
        try {
            qrPayload = (0, qris_payload_1.buildDynamicQrisPayload)(basePayload, finalAmount);
        }
        catch {
            // Fall back to the stored payload when the QRIS string is malformed.
        }
        const qrImageBase64 = await qrcode_1.default.toDataURL(qrPayload, {
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
    async recheckTransaction(_qrId, _account) {
        // The mock gateway always reports pending.
        // Actual paid status comes from mutation matching in the worker (Prompt 2).
        return { status: 'pending' };
    }
    async fetchMutations(_account) {
        // No live polling in mock mode.
        // Use scripts/simulate-payment.ts to inject mutations into the DB directly.
        return [];
    }
}
exports.MockOrkutGateway = MockOrkutGateway;
/** Singleton instance used throughout the application. */
exports.mockGateway = new MockOrkutGateway();
//# sourceMappingURL=mock-orkut.gateway.js.map