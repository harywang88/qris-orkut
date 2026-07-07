/**
 * Mutation Poll Loop — runs every 1500ms
 *
 * Reads unmatched credit mutations from the database and attempts to match
 * each one to an open transaction. On a successful match the transaction
 * is marked paid and queued for deposit.
 *
 * This DB-driven approach is the correct mock equivalent of polling a live
 * banking gateway: simulate-payment.ts injects the mutation row, and this
 * loop picks it up within 1.5 seconds.
 */
export declare function startMutationPollLoop(): void;
