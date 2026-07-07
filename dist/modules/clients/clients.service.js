"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listClients = listClients;
exports.getClientById = getClientById;
exports.createClient = createClient;
exports.rotateWidgetKey = rotateWidgetKey;
exports.updateClient = updateClient;
exports.deleteClient = deleteClient;
exports.rotateApiSecret = rotateApiSecret;
exports.getDecryptedSecret = getDecryptedSecret;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../../config/database");
const encryption_1 = require("../../core/encryption");
async function listClients() {
    return database_1.db.client.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            name: true,
            panelCode: true,
            apiKey: true,
            status: true,
            callbackUrl: true,
            depositApiUrl: true,
            createdAt: true,
            updatedAt: true,
        },
    });
}
async function getClientById(id) {
    return database_1.db.client.findUnique({ where: { id } });
}
async function createClient(data) {
    const apiKey = `qris_${data.panelCode.toLowerCase()}_${crypto_1.default.randomBytes(12).toString('hex')}`;
    const rawSecret = crypto_1.default.randomBytes(32).toString('hex');
    const apiSecretEncrypted = (0, encryption_1.encrypt)(rawSecret);
    // Public browser widget key (alfael-style ?key=). Safe to expose; low-privilege.
    const widgetKey = `wk_${data.panelCode.toLowerCase()}_${crypto_1.default.randomBytes(24).toString('hex')}`;
    const client = await database_1.db.client.create({
        data: {
            name: data.name,
            panelCode: data.panelCode.toUpperCase(),
            apiKey,
            apiSecretEncrypted,
            status: 'active',
            callbackUrl: data.callbackUrl || null,
            depositApiUrl: data.depositApiUrl || null,
            depositApiKey: data.depositApiKey || null,
            widgetKey,
            widgetAllowedOrigins: data.widgetAllowedOrigins || null,
        },
    });
    return { client, rawSecret };
}
/**
 * Generates (or regenerates) the public widget key for a client.
 * Returns the new widget key.
 */
async function rotateWidgetKey(id) {
    const client = await database_1.db.client.findUniqueOrThrow({ where: { id } });
    const widgetKey = `wk_${client.panelCode.toLowerCase()}_${crypto_1.default.randomBytes(24).toString('hex')}`;
    await database_1.db.client.update({ where: { id }, data: { widgetKey } });
    return widgetKey;
}
async function updateClient(id, data) {
    return database_1.db.client.update({
        where: { id },
        data: {
            name: data.name,
            status: data.status,
            callbackUrl: data.callbackUrl ?? null,
            depositApiUrl: data.depositApiUrl ?? null,
            depositApiKey: data.depositApiKey ?? null,
            widgetAllowedOrigins: data.widgetAllowedOrigins ?? null,
        },
    });
}
async function deleteClient(id) {
    // Soft-check: don't delete clients with transactions
    const txCount = await database_1.db.transaction.count({ where: { clientId: id } });
    if (txCount > 0) {
        throw new Error(`Klien memiliki ${txCount} transaksi dan tidak dapat dihapus.`);
    }
    await database_1.db.client.delete({ where: { id } });
}
/**
 * Rotates the API secret for a client.
 * Returns the new raw secret (shown to admin once, never stored in plain text).
 */
async function rotateApiSecret(id) {
    const rawSecret = crypto_1.default.randomBytes(32).toString('hex');
    const apiSecretEncrypted = (0, encryption_1.encrypt)(rawSecret);
    await database_1.db.client.update({
        where: { id },
        data: { apiSecretEncrypted },
    });
    return rawSecret;
}
/**
 * Returns the decrypted API secret for display.
 * Only call this when the admin explicitly requests it.
 */
async function getDecryptedSecret(id) {
    const client = await database_1.db.client.findUniqueOrThrow({ where: { id } });
    return (0, encryption_1.decrypt)(client.apiSecretEncrypted);
}
//# sourceMappingURL=clients.service.js.map