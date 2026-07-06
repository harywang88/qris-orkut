import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database';
import { decrypt } from './encryption';
import { logger } from '../config/logger';

/** Maximum allowed drift between request timestamp and server time (seconds). */
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/** How long to keep nonce records to prevent replay attacks. */
const NONCE_TTL_MINUTES = 10;

/**
 * Builds the canonical string for HMAC signing.
 *
 * Format:
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 */
export function buildCanonicalString(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  bodyHex: string,
): string {
  return [method.toUpperCase(), urlPath, timestamp, nonce, bodyHex].join('\n');
}

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
export async function hmacMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const timestamp = req.headers['x-timestamp'] as string | undefined;
    const nonce = req.headers['x-nonce'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;

    if (!apiKey || !timestamp || !nonce || !signature) {
      res.status(401).json({
        success: false,
        error: 'Missing required HMAC headers: X-API-Key, X-Timestamp, X-Nonce, X-Signature',
      });
      return;
    }

    // Validate timestamp
    const tsNum = parseInt(timestamp, 10);
    if (isNaN(tsNum) || tsNum <= 0) {
      res.status(401).json({ success: false, error: 'X-Timestamp must be a valid Unix timestamp' });
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > TIMESTAMP_TOLERANCE_SECONDS) {
      res.status(401).json({
        success: false,
        error: `Request timestamp is too old or in the future (tolerance: ${TIMESTAMP_TOLERANCE_SECONDS}s)`,
      });
      return;
    }

    // Look up client
    const client = await db.client.findUnique({ where: { apiKey } });
    if (!client || client.status !== 'active') {
      res.status(401).json({ success: false, error: 'Invalid or inactive API key' });
      return;
    }

    // Compute body hash from raw bytes captured by express.json() verify option
    const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    const bodyHex = crypto.createHash('sha256').update(rawBody).digest('hex');

    // Use the full path as the client sees it (req.path is relative to router mount point)
    const fullPath = req.originalUrl.split('?')[0];

    // Build canonical string and verify signature
    const canonical = buildCanonicalString(req.method, fullPath, timestamp, nonce, bodyHex);
    const secret = decrypt(client.apiSecretEncrypted);

    const expectedSig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

    const expectedBuf = Buffer.from(expectedSig, 'hex');
    const receivedBuf = Buffer.from(signature.toLowerCase(), 'hex');

    if (
      expectedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      logger.warn({ apiKey, path: req.path }, 'HMAC signature mismatch');
      res.status(401).json({ success: false, error: 'Invalid HMAC signature' });
      return;
    }

    // Replay protection — check nonce uniqueness
    const existingNonce = await db.requestNonce.findUnique({
      where: { apiKey_nonce: { apiKey, nonce } },
    });

    if (existingNonce) {
      logger.warn({ apiKey, nonce }, 'Replay attack detected (duplicate nonce)');
      res.status(409).json({
        success: false,
        error: 'Duplicate request detected — nonce already used',
      });
      return;
    }

    // Store nonce with TTL
    const expiresAt = new Date(Date.now() + NONCE_TTL_MINUTES * 60 * 1000);
    await db.requestNonce.create({
      data: {
        clientId: client.id,
        apiKey,
        nonce,
        timestamp,
        expiresAt,
      },
    });

    // Attach authenticated client to request
    req.client = client;

    next();
  } catch (err) {
    logger.error({ err }, 'HMAC middleware unhandled error');
    res.status(500).json({ success: false, error: 'Internal server error during authentication' });
  }
}

/**
 * Periodically purge expired nonces to prevent unbounded table growth.
 * Call this on a scheduled basis (e.g., every 15 minutes in the worker).
 */
export async function purgeExpiredNonces(): Promise<number> {
  const result = await db.requestNonce.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

export async function hmacOrSessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.session.user) {
    next();
    return;
  }

  await hmacMiddleware(req, res, next);
}
