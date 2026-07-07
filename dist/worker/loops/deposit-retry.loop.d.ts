/**
 * Deposit Retry Loop — runs every 20 seconds
 *
 * Finds paid transactions in deposit_queued state whose most recent failed
 * attempt has a nextRetryAt in the past, and retries the deposit.
 *
 * Retry schedule (from deposit.service.ts):
 *   attempt 1 → immediate (handled by mutation-poll loop)
 *   attempt 2 → 30s after attempt 1 failure
 *   attempt 3 → 120s after attempt 2 failure
 *   attempt 4 → 300s after attempt 3 failure
 *   → manual_review after 4 failures
 */
export declare function startDepositRetryLoop(): void;
