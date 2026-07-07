import { Request, Response, NextFunction } from 'express';
/**
 * Builds the canonical string for HMAC signing.
 *
 * Format:
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 */
export declare function buildCanonicalString(method: string, urlPath: string, timestamp: string, nonce: string, bodyHex: string): string;
/**
 * Express middleware that validates HMAC signatures on incoming API requests.
 *
 * Required headers:
 *   X-API-Key    — identifies the client
 *   X-Timestamp  — Unix timestamp in seconds (string)
 *   X-Nonce      — unique random string per request
 *   X-Signature  — HMAC-SHA256 hex of the canonical string
 *
 * On success, attaches the authenticated client to req.client.
 */
export declare function hmacMiddleware(req: Request, res: Response, next: NextFunction): Promise<void>;
/**
 * Periodically purge expired nonces to prevent unbounded table growth.
 * Call this on a scheduled basis (e.g., every 15 minutes in the worker).
 */
export declare function purgeExpiredNonces(): Promise<number>;
export declare function hmacOrSessionMiddleware(req: Request, res: Response, next: NextFunction): Promise<void>;
