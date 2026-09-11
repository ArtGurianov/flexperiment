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
  /** Exact replay through a caller-supplied command key. The only proof that holds for a command whose precondition an intervening B* can legally restore. */
  | "DURABLE_KEY"
  /** The request PINS the predecessor/version it was made against, so a stale retry is refused (STALE/conflict) rather than applied to newer state. */
  | "STALE_BOUND"
  /**
   * The command's write precondition can NEVER be legally restored once consumed - a one-way edge, a consumed capability, a terminal row. No B* can make a stale retry apply again. */
  | "MONOTONIC_REPLAY_SAFE"
  /** Session/authorization plumbing, not a business write. */
  | "NOT_A_BUSINESS_WRITE"
  /**
   * Not yet PROVEN under the current obligation. Must be zero before rollout.
   *
   * Note what this replaced. Until this revision the obligation was
   * "A commits, retry A" - and "the current state no longer admits an
   * immediate retry" or "the candidate equals the current row" were accepted
   * as proofs. Neither survives the real question:
   *
   *     A commits, its response is lost,
   *     ANY legally possible sequence B* occurs,
   *     old A is retried
   *     -> old A must never mutate authority or evidence created after A.
   *
   * A state gate that B* can legally re-open (suspend after a reactivation,
   * audience revoke after a new verification, ORD open after the draft was
   * confirmed) is not a proof. Neither is equality against the CURRENT row,
   * because A -> B -> A is often a legitimate revert intent and content
   * equality cannot distinguish it from a stale retry. Neither is an
   * in-place converging UPDATE, which writes no second row but can overwrite
   * evidence newer than the retry.
   */
  | "UNPROVEN";

const ADMIN: Readonly<Record<string, Classification>> = {
  "/feature-state/suspend": "STALE_BOUND", // body carries expected_revision; the CAS refuses a retry after any later transition
  "/feature-state/reactivate": "STALE_BOUND", // same expected_revision CAS
  "/partners": "MONOTONIC_REPLAY_SAFE", // UNIQUE(agent_id); a provisioned identity is never un-provisioned
  "/partners/:id/invite/reissue": "STALE_BOUND", // PR-C3: pins the live capability it replaces; recovery is a reason on the same rotation
  "/invites/:id/revoke": "MONOTONIC_REPLAY_SAFE", // revoked_at is one-way for that invite id
  "/partners/:id/legal-profile/verify": "MONOTONIC_REPLAY_SAFE", // onboarding graph is one-way; PROFILE_SUBMITTED is never re-entered
  "/partners/:id/legal-profile/change": "STALE_BOUND", // pins the verified revision it changes FROM
  "/partners/:id/legal-profile/change/:requestId/verify": "STALE_BOUND", // pins supersedes_revision_id; a stale retry resolves STALE
  "/partners/:id/legal-profile/change/:requestId/reject": "MONOTONIC_REPLAY_SAFE", // PENDING -> REJECTED is terminal; 0051's transition guard never re-admits PENDING
  "/partners/:id/tax-treatment": "DURABLE_KEY", // admin_command_idempotency (PR-F)
  "/partners/:id/framework/issue": "MONOTONIC_REPLAY_SAFE", // one-way edge out of PROFILE_VERIFIED
  "/partners/:id/activate": "MONOTONIC_REPLAY_SAFE", // PARTNER_ACTIVE is terminal
  "/partners/:id/promo": "MONOTONIC_REPLAY_SAFE", // UNIQUE(normalized_code); a code is never freed
  "/partners/:id/audience/:cityId/verify": "DURABLE_KEY", // PR-C2
  "/partners/:id/audience/:cityId/revoke": "STALE_BOUND", // pins aggregate_revision; re-verification is legal, so the VERIFIED gate is not a proof
  "/delegations/:id/revoke": "MONOTONIC_REPLAY_SAFE", // one revocation row per delegation, forever
  "/partners/:id/npd-status": "DURABLE_KEY", // PR-C2
  "/retention-policy": "DURABLE_KEY", // PR-C2
  "/partners/:id/legal-hold": "DURABLE_KEY", // place -> release -> retry creates a SECOND hold; the partial index only refuses a concurrent one
  "/legal-holds/:id/release": "MONOTONIC_REPLAY_SAFE", // released_at is one-way for that hold id
  "/partners/:id/destroy": "MONOTONIC_REPLAY_SAFE", // destruction event is terminal and replayed
  "/framework-agreement-revisions": "STALE_BOUND", // pins the revision the clauses were authored against
  "/delegation-template-revisions": "STALE_BOUND", // pins the revision the clauses were authored against
  "/channel-policy": "STALE_BOUND", // pins policy_revision
  "/engagements": "MONOTONIC_REPLAY_SAFE", // UNIQUE(partner, occurrence) -> ALREADY_EXISTS; an engagement is never deleted
  "/engagements/:id/revisions": "STALE_BOUND", // pins the revision it supersedes
  "/engagements/:id/activate": "DURABLE_KEY", // PR-C2
  "/engagements/:id/suspend": "STALE_BOUND", // pins lifecycle_revision; reactivation re-opens the ACTIVE gate
  "/engagements/:id/close": "MONOTONIC_REPLAY_SAFE", // one closure event per engagement, replayed
  "/engagements/:id/creative": "STALE_BOUND", // pins the creative revision it supersedes
  "/engagements/:id/creative/:revisionId/authorize": "STALE_BOUND", // pins the authorization chain HEAD, not the live row a revocation clears
  "/creative-authorizations/:id/revoke": "MONOTONIC_REPLAY_SAFE", // revoked_at is one-way for that authorization id
  "/engagements/:id/distributions": "DURABLE_KEY", // PR-C2, admin surface
  "/distributions/:id/correct": "STALE_BOUND", // pins the revision it supersedes
  "/distributions/:id/require-removal": "STALE_BOUND", // pins event_sequence; the removal lifecycle is cyclic
  "/distributions/:id/confirm-removal": "STALE_BOUND", // pins event_sequence
  "/distributions/:id/mark-overdue": "STALE_BOUND", // pins event_sequence
  "/distributions/:id/mark-unverified": "STALE_BOUND", // pins event_sequence
  "/distributions/:id/review-cleared": "STALE_BOUND", // pins event_sequence; a correction re-opens review
  "/ord/provider-profile": "STALE_BOUND", // pins the revision it supersedes
  "/ord/provider-operation": "STALE_BOUND", // pins the operation being reopened; CORRECTION_ONLY is a reopenable state
  "/ord/provider-operation/:id/submitted": "MONOTONIC_REPLAY_SAFE", // 0048's observed-id guard makes vk_external_id unchangeable once set; first-writer-wins on evidence_ref
  "/ord/provider-operation/:id/confirm": "MONOTONIC_REPLAY_SAFE", // SUBMITTED is never re-entered for that row id
  "/ord/provider-operation/:id/erir": "MONOTONIC_REPLAY_SAFE", // observed-id guard; erir_code is never cleared
  "/ord/provider-operation/:id/lock": "MONOTONIC_REPLAY_SAFE", // EXTERNALLY_LOCKED is terminal
  "/creative-revisions/:id/register": "MONOTONIC_REPLAY_SAFE", // any existing registration for the creative revision is returned; a chain is never removed
  "/ord/creative-registrations/:id/submitted": "MONOTONIC_REPLAY_SAFE", // same 0048 observed-id guard; first-writer-wins on evidence_ref
  "/ord/creative-registrations/:id/confirm": "MONOTONIC_REPLAY_SAFE", // SUBMITTED is never re-entered for that row id
  "/ord/creative-registrations/:id/correct": "STALE_BOUND", // bound to a named predecessor registration
  "/ord/creative-registrations/:id/erir": "MONOTONIC_REPLAY_SAFE", // observed-id guard; erir_code is never cleared
  "/ord/creative-registrations/:id/lock": "MONOTONIC_REPLAY_SAFE", // EXTERNALLY_LOCKED is terminal
  "/distributions/:id/reports": "STALE_BOUND", // pins the report revision it supersedes
  "/distributions/:id/reports/:periodKey/reconciliation": "STALE_BOUND", // pins the report revision the ERIR evidence was gathered for
  "/engagements/:id/reward-registry/finalize": "MONOTONIC_REPLAY_SAFE", // one registry snapshot per engagement, replayed
  "/engagements/:id/reward-registry/correct": "STALE_BOUND", // pins the effective snapshot the correction was decided against
  "/engagements/:id/zero-reward-closure": "MONOTONIC_REPLAY_SAFE", // UNIQUE(engagement_id); zero is an absorbing floor
  "/settlements": "MONOTONIC_REPLAY_SAFE", // at most one settlement per immutable effective snapshot, forever
  "/settlements/:id/act": "MONOTONIC_REPLAY_SAFE", // one act per settlement, replayed
  "/acts/:id/present": "MONOTONIC_REPLAY_SAFE", // presented_at is one-way
  "/paid-invoices": "MONOTONIC_REPLAY_SAFE", // one payload per act, replayed
  "/paid-invoices/:id/submission": "MONOTONIC_REPLAY_SAFE", // observed-id guard; submission_state is never cleared
  "/paid-invoices/:id/reconciliation": "MONOTONIC_REPLAY_SAFE", // observed-id guard; EXTERNALLY_LOCKED is terminal
  "/payments/begin": "DURABLE_KEY", // CONFIRMED_NOT_MADE frees the active-attempt index; paying again is legal and this moves money
  "/payment-attempts/:id/made": "MONOTONIC_REPLAY_SAFE", // MADE is terminal for that attempt
  "/payment-attempts/:id/payout-unknown": "MONOTONIC_REPLAY_SAFE", // IN_PROGRESS is never re-entered
  "/payment-attempts/:id/confirmed-not-made": "MONOTONIC_REPLAY_SAFE", // CONFIRMED_NOT_MADE is terminal for that attempt
  "/payment-attempts/:id/npd-receipt": "MONOTONIC_REPLAY_SAFE", // one receipt per attempt, replayed
};

const PARTNER: Readonly<Record<string, Classification>> = {
  // The unauthenticated router. Found by this test, not by hand - which is
  // the point: a manual pass over "the partner surface" missed all three.
  "/invite/consume": "MONOTONIC_REPLAY_SAFE", // consumed_at is never un-consumed
  "/login/request": "NOT_A_BUSINESS_WRITE",
  "/login/verify": "NOT_A_BUSINESS_WRITE",
  "/logout": "NOT_A_BUSINESS_WRITE",
  "/step-up": "NOT_A_BUSINESS_WRITE",
  "/engagement-step-up": "NOT_A_BUSINESS_WRITE",
  "/settlement-step-up": "NOT_A_BUSINESS_WRITE",
  "/legal-profile": "STALE_BOUND", // pins legal_profile_draft_revision (0055); the draft is rewritten in place
  "/legal-profile/change": "STALE_BOUND", // pins the verified revision it changes FROM
  "/framework/accept": "MONOTONIC_REPLAY_SAFE", // exact-parameter replay; the acceptance row is permanent
  "/delegation/:id/revoke": "MONOTONIC_REPLAY_SAFE", // one revocation row per delegation, forever
  "/payout-profile": "DURABLE_KEY", // PR-C2
  "/payout-profile/revoke": "DURABLE_KEY", // PR-C2
  "/engagements/:id/accept": "MONOTONIC_REPLAY_SAFE", // one acceptance per (engagement, revision), replayed
  "/engagements/:id/distributions": "DURABLE_KEY", // PR-C2
  "/distributions/:id/correct": "STALE_BOUND", // pins the revision it supersedes
  "/distributions/:id/removal-claim": "STALE_BOUND", // pins event_sequence; the removal lifecycle is cyclic
  "/acts/:id/accept": "MONOTONIC_REPLAY_SAFE", // one acceptance per act, replayed
  "/acts/:id/dispute": "MONOTONIC_REPLAY_SAFE", // one dispute per act, replayed
  "/npd-receipts/submit": "DURABLE_KEY", // PR-C2
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

  it("pins what is PROVEN under the A -> B* -> retry A obligation", () => {
    // Each of these carries an actual proof, not an observation that an
    // immediate retry happens to fail today:
    //   DURABLE_KEY            - exact replay, whatever B* did
    //   MONOTONIC_REPLAY_SAFE  - no legal B* restores the precondition
    //   STALE_BOUND            - the request pins the monotone version it
    //                            was authored against
    const proven = (table: Readonly<Record<string, Classification>>, kind: Classification) =>
      Object.entries(table).filter(([, value]) => value === kind).map(([route]) => route).sort();

    // DURABLE_KEY is the smallest class ON PURPOSE, and stayed that way when
    // the 62 were closed. It is the fallback for commands where an identical
    // body genuinely means both "retry my lost call" and "do it again" -
    // reaching for it first would have hidden every route whose own
    // semantics already answer the question, and each key added is a key a
    // client has to keep.
    expect(proven(ADMIN, "DURABLE_KEY")).toEqual([
      "/engagements/:id/activate",
      "/engagements/:id/distributions",
      "/partners/:id/audience/:cityId/verify",
      "/partners/:id/legal-hold",
      "/partners/:id/npd-status",
      "/partners/:id/tax-treatment",
      "/payments/begin",
      "/retention-policy",
    ]);
    expect(proven(PARTNER, "DURABLE_KEY")).toEqual([
      "/engagements/:id/distributions",
      "/npd-receipts/submit",
      "/payout-profile",
      "/payout-profile/revoke",
    ]);

    expect(proven(PARTNER, "MONOTONIC_REPLAY_SAFE")).toEqual([
      "/acts/:id/accept",
      "/acts/:id/dispute",
      "/delegation/:id/revoke",
      "/engagements/:id/accept",
      "/framework/accept",
      "/invite/consume",
    ]);
    expect(proven(PARTNER, "STALE_BOUND")).toEqual([
      "/distributions/:id/correct",
      "/distributions/:id/removal-claim",
      "/legal-profile",
      "/legal-profile/change",
    ]);

    // Review round 2, P2: the admin classes are pinned by full sorted
    // MEMBERSHIP, not by count plus spot checks. A count leaves two routes
    // free to swap classes without CI noticing - which, after four rounds of
    // this matrix moving, is exactly the drift this registry exists to stop.
    expect(proven(ADMIN, "MONOTONIC_REPLAY_SAFE")).toEqual([
      "/acts/:id/present",
      "/creative-authorizations/:id/revoke",
      "/creative-revisions/:id/register",
      "/delegations/:id/revoke",
      "/engagements",
      "/engagements/:id/close",
      "/engagements/:id/reward-registry/finalize",
      "/engagements/:id/zero-reward-closure",
      "/invites/:id/revoke",
      "/legal-holds/:id/release",
      "/ord/creative-registrations/:id/confirm",
      "/ord/creative-registrations/:id/erir",
      "/ord/creative-registrations/:id/lock",
      "/ord/creative-registrations/:id/submitted",
      "/ord/provider-operation/:id/confirm",
      "/ord/provider-operation/:id/erir",
      "/ord/provider-operation/:id/lock",
      "/ord/provider-operation/:id/submitted",
      "/paid-invoices",
      "/paid-invoices/:id/reconciliation",
      "/paid-invoices/:id/submission",
      "/partners",
      "/partners/:id/activate",
      "/partners/:id/destroy",
      "/partners/:id/framework/issue",
      "/partners/:id/legal-profile/change/:requestId/reject",
      "/partners/:id/legal-profile/verify",
      "/partners/:id/promo",
      "/payment-attempts/:id/confirmed-not-made",
      "/payment-attempts/:id/made",
      "/payment-attempts/:id/npd-receipt",
      "/payment-attempts/:id/payout-unknown",
      "/settlements",
      "/settlements/:id/act",
    ]);
    expect(proven(ADMIN, "STALE_BOUND")).toEqual([
      "/channel-policy",
      "/delegation-template-revisions",
      "/distributions/:id/confirm-removal",
      "/distributions/:id/correct",
      "/distributions/:id/mark-overdue",
      "/distributions/:id/mark-unverified",
      "/distributions/:id/reports",
      "/distributions/:id/reports/:periodKey/reconciliation",
      "/distributions/:id/require-removal",
      "/distributions/:id/review-cleared",
      "/engagements/:id/creative",
      "/engagements/:id/creative/:revisionId/authorize",
      "/engagements/:id/revisions",
      "/engagements/:id/reward-registry/correct",
      "/engagements/:id/suspend",
      "/feature-state/reactivate",
      "/feature-state/suspend",
      "/framework-agreement-revisions",
      "/ord/creative-registrations/:id/correct",
      "/ord/provider-operation",
      "/ord/provider-profile",
      "/partners/:id/audience/:cityId/revoke",
      "/partners/:id/invite/reissue",
      "/partners/:id/legal-profile/change",
      "/partners/:id/legal-profile/change/:requestId/verify",
    ]);

    const provenTotal = [...Object.values(ADMIN), ...Object.values(PARTNER)]
      .filter((value) => value === "DURABLE_KEY" || value === "STALE_BOUND" || value === "MONOTONIC_REPLAY_SAFE").length;
    expect(provenTotal).toBe(81);
  });

  it("has no UNPROVEN route left - the rollout gate this registry exists for", () => {
    // This number went 0 -> 62 -> 0. The 62 was not a regression: it was the
    // honest recount after the obligation was corrected from "A, immediate
    // retry A" to A -> B* -> retry A, which invalidated every state-gate and
    // current-row-equality classification at once.
    const unproven = (table: Readonly<Record<string, Classification>>) =>
      Object.entries(table).filter(([, value]) => value === "UNPROVEN").map(([route]) => route);
    expect(unproven(ADMIN)).toEqual([]);
    expect(unproven(PARTNER)).toEqual([]);
  });

  it("no route is parked in a quarantine class any more", () => {
    // SPECIAL_RECOVERY existed for exactly one route: invite reissue returns
    // a raw token that is never persisted, so no idempotency mechanism can
    // re-serve the original after a lost response. PR-C3 answered that with
    // a NAMED recovery command rather than a key - and, writing the contract
    // red first, found the ordinary reissue had the same defect sitting
    // unexamined behind the quarantine label. Both are predecessor-bound
    // now, so the class has nothing left to hold.
    //
    // The label was worth having: it kept an unproven route visible instead
    // of letting a zero elsewhere imply the gate was closed. What it must
    // not become is a place things rest.
    expect(Object.values(ADMIN)).not.toContain("SPECIAL_RECOVERY");
    expect(ADMIN["/partners/:id/invite/reissue"]).toBe("STALE_BOUND");
  });
});
