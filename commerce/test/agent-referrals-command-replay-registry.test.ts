import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The exhaustiveness contract behind
 * docs/design/AGENT_REFERRALS_COMMAND_REPLAY_MATRIX.md.
 *
 * The matrix went through three review rounds and was incomplete every time,
 * for the same reason each time: it was assembled by walking the React
 * surfaces, while the boundary it CLAIMED was "every command". Both routers
 * are authenticated but externally callable, so a caller does not need a
 * button to reach a route.
 *
 * So the boundary is now mechanical: every write route published by
 * agent-referrals-api-admin.ts and agent-referrals-api-partner.ts must carry
 * a replay classification here. A new POST route fails this test until
 * someone classifies it - which is the only thing that stops the matrix
 * silently rotting again between now and PR-C2.
 *
 * This test deliberately does NOT re-derive the classifications. It pins
 * them, and pins the pending set, so the two cannot drift apart.
 */

type Classification =
  /** Durable command identity: an exact replay returns the original response. */
  | "DURABLE_KEY"
  /** A repeat is refused or replayed by construction (unique index, existing-row check, one-way state edge). */
  | "REPLAY_SAFE"
  /** A repeat is refused with a named, catchable code added by PR-C. */
  | "NAMED_REFUSAL"
  /** An identical repeat mints a NEW durable fact. PR-C2 scope, rollout blocker. */
  | "REPEATABLE"
  /** A repeat mints a new secret that cannot be re-served, so plain durable identity does not apply. Needs its own defined recovery semantics. */
  | "SPECIAL_NON_REPLAYABLE_SECRET"
  /** Session/authorization plumbing, not a business write. */
  | "NOT_A_BUSINESS_WRITE"
  /** Not yet audited against the criterion. Must be empty before rollout. */
  | "UNAUDITED";

const ADMIN: Readonly<Record<string, Classification>> = {
  "/feature-state/suspend": "REPLAY_SAFE", // CAS on expected_revision, one-way per revision
  "/feature-state/reactivate": "REPLAY_SAFE",
  "/partners": "NAMED_REFUSAL", // partner_identities.agent_id UNIQUE -> ALREADY_PROVISIONED (PR-C)
  "/partners/:id/invite/reissue": "SPECIAL_NON_REPLAYABLE_SECRET", // supersedes the live invite and returns a raw token that is never persisted
  "/invites/:id/revoke": "REPLAY_SAFE", // conditional UPDATE, changes !== 1 -> NOT_REVOCABLE
  "/partners/:id/legal-profile/verify": "REPLAY_SAFE", // requires PROFILE_SUBMITTED
  "/partners/:id/legal-profile/change": "REPLAY_SAFE", // partial unique index -> ALREADY_PENDING
  "/partners/:id/legal-profile/change/:requestId/verify": "REPLAY_SAFE", // terminal-state replay -> REPLAYED
  "/partners/:id/legal-profile/change/:requestId/reject": "REPLAY_SAFE", // state CAS on the request row
  "/partners/:id/tax-treatment": "DURABLE_KEY", // admin_command_idempotency (PR-F)
  "/partners/:id/framework/issue": "REPLAY_SAFE", // onboarding transition CAS
  "/partners/:id/activate": "REPLAY_SAFE", // onboarding transition CAS
  "/partners/:id/promo": "NAMED_REFUSAL", // both promo UNIQUE constraints named (PR-C)
  "/partners/:id/audience/:cityId/verify": "REPEATABLE", // aggregate_revision + 1
  "/partners/:id/audience/:cityId/revoke": "REPLAY_SAFE", // requires current event_kind VERIFIED; after one revoke the retry is AUDIENCE_NOT_VERIFIED
  "/delegations/:id/revoke": "REPLAY_SAFE", // existing revocation row -> ALREADY_REVOKED
  "/partners/:id/npd-status": "REPEATABLE", // sequence + 1
  "/retention-policy": "REPEATABLE", // revision + 1, no same-content branch
  "/partners/:id/legal-hold": "REPEATABLE", // unconditional INSERT; each hold independently blocks destruction
  "/legal-holds/:id/release": "REPLAY_SAFE", // conditional UPDATE, changes !== 1 -> ALREADY_RELEASED
  "/partners/:id/destroy": "REPLAY_SAFE", // existing destruction event -> replayed: true
  "/framework-agreement-revisions": "REPLAY_SAFE", // PR-C2: identical clauses return the current revision
  "/delegation-template-revisions": "REPLAY_SAFE", // PR-C2: identical clauses return the current revision
  "/channel-policy": "REPLAY_SAFE", // PR-C2: same status from the same instant returns the current policy
  "/engagements": "REPLAY_SAFE", // engagementByPartnerAndOccurrence -> ALREADY_EXISTS
  "/engagements/:id/revisions": "REPLAY_SAFE", // PR-C2: identical terms + same occurrence material return the current revision
  "/engagements/:id/activate": "REPEATABLE", // CAS is not idempotency: revokes the live authorization, writes a second activation event
  "/engagements/:id/suspend": "REPLAY_SAFE", // requires ACTIVE; after suspension the retry is ILLEGAL_TRANSITION
  "/engagements/:id/close": "REPLAY_SAFE", // requires a non-CLOSED state + lifecycle CAS
  "/engagements/:id/creative": "REPLAY_SAFE", // PR-C2: identical creative_hash returns the current revision
  "/engagements/:id/creative/:revisionId/authorize": "REPLAY_SAFE", // PR-C2: the live authorization for the same creative is returned, not churned
  "/creative-authorizations/:id/revoke": "REPLAY_SAFE", // conditional UPDATE on revoked_at IS NULL -> ALREADY_REVOKED
  "/engagements/:id/distributions": "REPEATABLE", // fresh distribution identity per call (same command as the partner route)
  "/distributions/:id/correct": "REPLAY_SAFE", // PR-C2: identical canonical_hash returns the current revision
  "/distributions/:id/require-removal": "REPLAY_SAFE", // removal state machine has no self-loop -> ILLEGAL_TRANSITION
  "/distributions/:id/confirm-removal": "REPLAY_SAFE", // same state machine
  "/distributions/:id/mark-overdue": "REPLAY_SAFE", // same state machine
  "/distributions/:id/mark-unverified": "REPLAY_SAFE", // same state machine
  "/distributions/:id/review-cleared": "REPLAY_SAFE", // compliance transition legal only from REVIEW_REQUIRED
  "/ord/provider-profile": "REPLAY_SAFE", // PR-C2: identical content returns the current revision
  "/ord/provider-operation": "REPLAY_SAFE", // existing DRAFT -> replayed: true
  "/ord/provider-operation/:id/submitted": "REPLAY_SAFE", // converging UPDATE of the same values; no new row
  "/ord/provider-operation/:id/confirm": "REPLAY_SAFE", // requires local_state SUBMITTED -> NOT_SUBMITTED on retry
  "/ord/provider-operation/:id/erir": "REPLAY_SAFE", // explicit idempotent replay on identical code + evidence
  "/ord/provider-operation/:id/lock": "REPLAY_SAFE", // requires CORRECTION_ONLY -> NOT_CORRECTABLE once locked
  "/creative-revisions/:id/register": "REPLAY_SAFE", // existing current registration -> replayed: true
  "/ord/creative-registrations/:id/submitted": "REPLAY_SAFE", // converging UPDATE, guarded by lock_state
  "/ord/creative-registrations/:id/confirm": "REPLAY_SAFE", // WHERE lock_state = MUTABLE; once CORRECTION_ONLY -> CONCURRENT_CONFLICT
  "/ord/creative-registrations/:id/correct": "REPLAY_SAFE", // bound to a predecessor id; a second attempt is STALE
  "/ord/creative-registrations/:id/erir": "REPLAY_SAFE", // explicit idempotent replay on identical code + evidence
  "/ord/creative-registrations/:id/lock": "REPLAY_SAFE", // requires CORRECTION_ONLY -> NOT_CORRECTABLE once locked
  "/distributions/:id/reports": "REPLAY_SAFE", // explicit exact-semantic replay in insertReport
  "/distributions/:id/reports/:periodKey/reconciliation": "REPLAY_SAFE", // same insertReport path, identical reconciliation mints no revision
  "/engagements/:id/reward-registry/finalize": "REPLAY_SAFE", // existing registry snapshot -> replayed: true
  "/engagements/:id/reward-registry/correct": "REPLAY_SAFE", // correction is bound to the current effective snapshot; see correctPartnerRewardWithSettlement
  "/engagements/:id/zero-reward-closure": "REPLAY_SAFE", // existing closure -> replayed: true
  "/settlements": "REPLAY_SAFE", // settlementForEffectiveSnapshot -> replayed: true
  "/settlements/:id/act": "REPLAY_SAFE", // existing act for the settlement -> replayed: true
  "/acts/:id/present": "REPLAY_SAFE", // presented_at already set -> replayed: true
  "/paid-invoices": "REPLAY_SAFE", // idempotent by act_id, returns the byte-identical payload
  "/paid-invoices/:id/submission": "REPLAY_SAFE", // identical submission -> the same payload; differing values -> SUBMISSION_CONFLICT
  "/paid-invoices/:id/reconciliation": "REPLAY_SAFE", // lock_state guard + changes !== 1
  "/payments/begin": "REPLAY_SAFE", // unique active attempt -> ATTEMPT_ALREADY_ACTIVE
  "/payment-attempts/:id/made": "REPLAY_SAFE", // terminal status already MADE -> replayed: true
  "/payment-attempts/:id/payout-unknown": "REPLAY_SAFE", // terminal status already PAYOUT_UNKNOWN -> replayed: true
  "/payment-attempts/:id/confirmed-not-made": "REPLAY_SAFE", // terminal status already CONFIRMED_NOT_MADE -> replayed: true
  "/payment-attempts/:id/npd-receipt": "REPLAY_SAFE", // existing receipt for the attempt -> replayed: true
};

const PARTNER: Readonly<Record<string, Classification>> = {
  // The unauthenticated router. Found by this test, not by hand - which is
  // the point: a manual pass over "the partner surface" missed all three.
  "/invite/consume": "REPLAY_SAFE", // atomic CAS on consumed_at; a replay is ALREADY_CONSUMED
  "/login/request": "NOT_A_BUSINESS_WRITE", // OTP challenge, rate-limited auth plumbing
  "/login/verify": "NOT_A_BUSINESS_WRITE", // session mint
  "/logout": "NOT_A_BUSINESS_WRITE",
  "/step-up": "NOT_A_BUSINESS_WRITE", // mints a single-use authorization credential, not a business fact
  "/engagement-step-up": "NOT_A_BUSINESS_WRITE",
  "/settlement-step-up": "NOT_A_BUSINESS_WRITE",
  "/legal-profile": "REPLAY_SAFE", // PR-C2: an unchanged draft returns the identity without appending another event
  "/legal-profile/change": "REPLAY_SAFE", // partial unique index -> ALREADY_PENDING
  "/framework/accept": "REPLAY_SAFE", // exact-parameter replay -> idempotent no-op
  "/delegation/:id/revoke": "REPLAY_SAFE", // same revokeDelegationInTransaction -> ALREADY_REVOKED
  "/payout-profile": "REPEATABLE", // revision + 1; the retry's fresh grant binds to the NEW revision
  "/payout-profile/revoke": "REPEATABLE", // revision + 1
  "/engagements/:id/accept": "REPLAY_SAFE", // existing acceptance -> replayed: true
  "/engagements/:id/distributions": "REPEATABLE", // fresh distribution identity per call
  "/distributions/:id/correct": "REPLAY_SAFE", // PR-C2, same command as the admin route (both realms)
  "/distributions/:id/removal-claim": "REPLAY_SAFE", // removal state machine has no self-loop -> ILLEGAL_TRANSITION
  "/acts/:id/accept": "REPLAY_SAFE", // existing acceptance -> replayed: true
  "/acts/:id/dispute": "REPLAY_SAFE", // existing dispute -> replayed: true
  "/npd-receipts/submit": "REPEATABLE", // unconditional NPD_RECEIPT_EVIDENCE_SUBMITTED_BY_PARTNER event per call
};

const writeRoutesOf = (file: string): string[] => {
  const source = readFileSync(join(process.cwd(), "commerce", "src", file), "utf8");
  return [...source.matchAll(/\.(post|put|patch|delete)\("([^"]+)"/g)].map((match) => match[2]);
};

describe("agent-referrals command replay classification is exhaustive over the published write surface", () => {
  it("classifies every write route the admin router publishes", () => {
    const routes = writeRoutesOf("agent-referrals-api-admin.ts");
    expect(routes.length).toBeGreaterThan(0);
    const unclassified = routes.filter((route) => !(route in ADMIN));
    expect(unclassified, "new admin write routes must be classified in the replay matrix before they ship").toEqual([]);
    // And nothing lingers here for a route that no longer exists.
    expect(Object.keys(ADMIN).filter((route) => !routes.includes(route))).toEqual([]);
  });

  it("classifies every write route the partner router publishes", () => {
    const routes = writeRoutesOf("agent-referrals-api-partner.ts");
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((route) => !(route in PARTNER)), "new partner write routes must be classified").toEqual([]);
    expect(Object.keys(PARTNER).filter((route) => !routes.includes(route))).toEqual([]);
  });

  it("pins the PR-C2 scope: the repeatable set, in both realms", () => {
    // Changing this list is a deliberate act - either PR-C2 closed one, or a
    // new repeatable command was introduced and needs to be in PR-C2 too.
    const repeatable = (table: Readonly<Record<string, Classification>>) =>
      Object.entries(table).filter(([, value]) => value === "REPEATABLE").map(([route]) => route).sort();
    // PR-C2 step 2a closed the content-addressed half: what is left needs
    // durable command identity, because an identical body CAN be a
    // legitimate second command (a fresh NPD check, a second hold for a
    // different matter, a genuine re-activation) and no content comparison
    // can tell that from a retry.
    expect(repeatable(ADMIN)).toEqual([
      "/engagements/:id/activate",
      "/engagements/:id/distributions",
      "/partners/:id/audience/:cityId/verify",
      "/partners/:id/legal-hold",
      "/partners/:id/npd-status",
      "/retention-policy",
    ]);
    expect(repeatable(PARTNER)).toEqual([
      "/engagements/:id/distributions",
      "/npd-receipts/submit",
      "/payout-profile",
      "/payout-profile/revoke",
    ]);
  });

  it("has no UNAUDITED route left: the audit covers the whole published surface", () => {
    // PR-C2 step 1. Every one of the 35 routes PR-C left pending resolved to
    // REPLAY_SAFE, which is itself the useful finding: the repeatable class is
    // exactly "mint the next revision in an append-only chain with no state
    // gate", while every state TRANSITION in this system is already guarded
    // by the state it transitions from.
    const unaudited = (table: Readonly<Record<string, Classification>>) =>
      Object.values(table).filter((value) => value === "UNAUDITED").length;
    expect(unaudited(ADMIN)).toBe(0);
    expect(unaudited(PARTNER)).toBe(0);
  });
});
