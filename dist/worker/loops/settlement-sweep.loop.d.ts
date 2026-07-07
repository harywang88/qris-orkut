/**
 * Settlement Sweep Loop — runs every 60 seconds
 *
 * Finds pending settlement requests and processes them via processSettlement().
 * Processing is synchronous per request to avoid partial ledger state.
 */
export declare function startSettlementSweepLoop(): void;
