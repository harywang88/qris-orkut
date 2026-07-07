/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a colon-delimited string: ivHex:authTagHex:ciphertextHex
 */
export declare function encrypt(plaintext: string): string;
/**
 * Decrypts a value produced by encrypt().
 * Throws if the stored value is malformed or authentication fails.
 */
export declare function decrypt(stored: string): string;
