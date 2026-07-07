"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encrypt = encrypt;
exports.decrypt = decrypt;
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("../config");
function getKey() {
    return Buffer.from(config_1.config.APP_ENCRYPTION_KEY, 'hex');
}
/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a colon-delimited string: ivHex:authTagHex:ciphertextHex
 */
function encrypt(plaintext) {
    const key = getKey();
    const iv = crypto_1.default.randomBytes(12); // 96-bit IV, recommended for GCM
    const cipher = crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}
/**
 * Decrypts a value produced by encrypt().
 * Throws if the stored value is malformed or authentication fails.
 */
function decrypt(stored) {
    const key = getKey();
    const parts = stored.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted value: expected ivHex:authTagHex:ciphertextHex');
    }
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encryptedBytes = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto_1.default.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedBytes), decipher.final()]).toString('utf8');
}
//# sourceMappingURL=encryption.js.map