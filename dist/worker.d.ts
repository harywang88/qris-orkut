/**
 * QRIS Worker Process
 *
 * Runs background loops alongside the main Express server:
 *
 *   mutation-poll   — every 1500ms  — match unmatched DB mutations to open transactions
 *   expiry-sweep    — every 30s     — expire open QRs, release locks, purge nonces
 *   deposit-retry   — every 20s     — retry failed deposits
 *   settlement-sweep — every 60s   — process pending settlement requests
 *
 * Start: npm run dev:worker  (development)
 *        npm run start:worker (production)
 */
export {};
