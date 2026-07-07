"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMutationPollLoop = startMutationPollLoop;
const logger_1 = require("../../config/logger");
const mutation_matcher_service_1 = require("../../shared/mutation-matcher.service");
const deposit_service_1 = require("../../shared/deposit.service");
const INTERVAL_MS = 1500;
let running = false;
async function tick() {
    const mutations = await (0, mutation_matcher_service_1.fetchUnmatchedMutations)(20);
    if (mutations.length === 0)
        return;
    logger_1.logger.debug({ count: mutations.length }, 'Mutation poll: processing unmatched mutations');
    for (const mutation of mutations) {
        const result = await (0, mutation_matcher_service_1.tryMatchMutation)(mutation);
        if (result.matched) {
            // Immediately attempt the first deposit after matching
            try {
                await (0, deposit_service_1.attemptDeposit)(result.transactionId);
            }
            catch (depositErr) {
                logger_1.logger.error({ depositErr, transactionId: result.transactionId }, 'Immediate deposit attempt failed after match');
            }
        }
    }
}
function startMutationPollLoop() {
    logger_1.logger.info({ intervalMs: INTERVAL_MS }, 'Mutation poll loop started');
    setInterval(() => {
        if (running)
            return;
        running = true;
        tick()
            .catch((err) => logger_1.logger.error({ err }, 'Mutation poll loop error'))
            .finally(() => {
            running = false;
        });
    }, INTERVAL_MS);
}
//# sourceMappingURL=mutation-poll.loop.js.map