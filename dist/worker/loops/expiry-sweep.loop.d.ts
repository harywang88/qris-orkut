/**
 * Expiry Sweep Loop — runs every 30 seconds
 *
 * Expires open QR transactions that have passed their expiresAt deadline,
 * releases their amount locks, and purges stale HMAC nonces.
 */
export declare function startExpirySweepLoop(): void;
