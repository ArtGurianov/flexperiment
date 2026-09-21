import type { CertificationPhase, CleanupDirection } from "./run";

/**
 * The order of a certification's phases and cleanup directions, written once.
 *
 * Both orders exist twice in the running system: here, where TypeScript decides
 * whether a transition moves forward, and in SQL, where a trigger refuses one
 * that moves back. Two spellings of one order can drift, and the drift would be
 * silent in the worst direction - a phase the application believes is later
 * than another while the database believes the opposite means a regression the
 * guard waves through.
 *
 * The frozen baseline cannot be regenerated from this, and is not meant to be.
 * What this gives is the single source a test compares the migrations against,
 * and the ladder a future migration fragment is built from rather than typed
 * out again.
 */

export const CERTIFICATION_PHASE_ORDER: readonly CertificationPhase[] = [
  "NEW", "OCCURRENCE_CREATED", "OCCURRENCE_PUBLISHED", "OCCURRENCE_OPEN", "QUOTE_READY",
  "CHECKOUT_SUBMITTING", "CHECKOUT_CREATED", "ORDER_IDENTIFIED", "PAYMENT_PROVEN",
  "TICKET_EMAIL_DELIVERED", "BOOKING_CANCELLED", "BOOKING_CANCELLED_EMAIL_DELIVERED",
  "REFUND_SUCCEEDED", "REFUND_EMAIL_DELIVERED", "OCCURRENCE_CLEANED", "COMPLETE",
];

export const CLEANUP_DIRECTION_ORDER: readonly CleanupDirection[] = [
  "NORMAL", "FINANCIAL_EFFECT_POSSIBLE", "CLEANUP_STARTED", "CATALOGUE_CLEAN",
];

export const rankOf = <T extends string>(order: readonly T[], value: T): number => order.indexOf(value);

/**
 * The `CASE` ladder a migration uses to compare two values of one of these
 * orders, generated from the order itself.
 *
 * A fragment written by hand is a third spelling. This is the second, and the
 * test below proves the ones already frozen agree with it.
 */
export const sqlRankLadder = (expression: string, order: readonly string[]): string =>
  `CASE ${expression} ${order.map((value, rank) => `WHEN '${value}' THEN ${rank}`).join(" ")} END`;

/** The members a `CHECK (col IN (...))` must list, in the order this contract fixes. */
export const sqlMembership = (column: string, order: readonly string[]): string =>
  `${column} IN (${order.map((value) => `'${value}'`).join(", ")})`;
