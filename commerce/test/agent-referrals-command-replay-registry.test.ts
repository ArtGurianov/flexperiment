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
  /** The command's write precondition can NEVER be legally restored once consumed - a one-way edge, a consumed capability, a terminal row. No B* can make a stale retry apply again. */
  | "MONOTONIC_REPLAY_SAFE"
  /** A repeat is refused with a named, catchable code, and no legal B* can restore the state that refusal depends on. */
  | "NAMED_REFUSAL"
  /** The response carries a secret that is never persisted, so no idempotency mechanism can re-serve it. Needs explicit lost-response recovery semantics. */
  | "SPECIAL_RECOVERY"
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
  "/feature-state/suspend": "UNPROVEN",
  "/feature-state/reactivate": "UNPROVEN",
  "/partners": "UNPROVEN",
  "/partners/:id/invite/reissue": "SPECIAL_RECOVERY", // raw token is never persisted; needs defined recovery semantics
  "/invites/:id/revoke": "UNPROVEN",
  "/partners/:id/legal-profile/verify": "MONOTONIC_REPLAY_SAFE", // onboarding graph is one-way; PROFILE_SUBMITTED is never re-entered
  "/partners/:id/legal-profile/change": "UNPROVEN",
  "/partners/:id/legal-profile/change/:requestId/verify": "STALE_BOUND", // pins supersedes_revision_id; a stale retry resolves STALE
  "/partners/:id/legal-profile/change/:requestId/reject": "UNPROVEN",
  "/partners/:id/tax-treatment": "DURABLE_KEY", // admin_command_idempotency (PR-F)
  "/partners/:id/framework/issue": "MONOTONIC_REPLAY_SAFE", // one-way edge out of PROFILE_VERIFIED
  "/partners/:id/activate": "MONOTONIC_REPLAY_SAFE", // PARTNER_ACTIVE is terminal
  "/partners/:id/promo": "UNPROVEN",
  "/partners/:id/audience/:cityId/verify": "DURABLE_KEY", // PR-C2
  "/partners/:id/audience/:cityId/revoke": "UNPROVEN",
  "/delegations/:id/revoke": "UNPROVEN",
  "/partners/:id/npd-status": "DURABLE_KEY", // PR-C2
  "/retention-policy": "DURABLE_KEY", // PR-C2
  "/partners/:id/legal-hold": "UNPROVEN",
  "/legal-holds/:id/release": "UNPROVEN",
  "/partners/:id/destroy": "MONOTONIC_REPLAY_SAFE", // destruction event is terminal and replayed
  "/framework-agreement-revisions": "UNPROVEN",
  "/delegation-template-revisions": "UNPROVEN",
  "/channel-policy": "UNPROVEN",
  "/engagements": "UNPROVEN",
  "/engagements/:id/revisions": "UNPROVEN",
  "/engagements/:id/activate": "DURABLE_KEY", // PR-C2
  "/engagements/:id/suspend": "UNPROVEN",
  "/engagements/:id/close": "UNPROVEN",
  "/engagements/:id/creative": "UNPROVEN",
  "/engagements/:id/creative/:revisionId/authorize": "UNPROVEN",
  "/creative-authorizations/:id/revoke": "UNPROVEN",
  "/engagements/:id/distributions": "DURABLE_KEY", // PR-C2, admin surface
  "/distributions/:id/correct": "UNPROVEN",
  "/distributions/:id/require-removal": "UNPROVEN",
  "/distributions/:id/confirm-removal": "UNPROVEN",
  "/distributions/:id/mark-overdue": "UNPROVEN",
  "/distributions/:id/mark-unverified": "UNPROVEN",
  "/distributions/:id/review-cleared": "UNPROVEN",
  "/ord/provider-profile": "UNPROVEN",
  "/ord/provider-operation": "UNPROVEN",
  "/ord/provider-operation/:id/submitted": "UNPROVEN",
  "/ord/provider-operation/:id/confirm": "UNPROVEN",
  "/ord/provider-operation/:id/erir": "UNPROVEN",
  "/ord/provider-operation/:id/lock": "UNPROVEN",
  "/creative-revisions/:id/register": "UNPROVEN",
  "/ord/creative-registrations/:id/submitted": "UNPROVEN",
  "/ord/creative-registrations/:id/confirm": "UNPROVEN",
  "/ord/creative-registrations/:id/correct": "STALE_BOUND", // bound to a named predecessor registration
  "/ord/creative-registrations/:id/erir": "UNPROVEN",
  "/ord/creative-registrations/:id/lock": "UNPROVEN",
  "/distributions/:id/reports": "UNPROVEN",
  "/distributions/:id/reports/:periodKey/reconciliation": "UNPROVEN",
  "/engagements/:id/reward-registry/finalize": "UNPROVEN",
  "/engagements/:id/reward-registry/correct": "UNPROVEN",
  "/engagements/:id/zero-reward-closure": "UNPROVEN",
  "/settlements": "UNPROVEN",
  "/settlements/:id/act": "UNPROVEN",
  "/acts/:id/present": "UNPROVEN",
  "/paid-invoices": "UNPROVEN",
  "/paid-invoices/:id/submission": "UNPROVEN",
  "/paid-invoices/:id/reconciliation": "UNPROVEN",
  "/payments/begin": "UNPROVEN",
  "/payment-attempts/:id/made": "UNPROVEN",
  "/payment-attempts/:id/payout-unknown": "UNPROVEN",
  "/payment-attempts/:id/confirmed-not-made": "UNPROVEN",
  "/payment-attempts/:id/npd-receipt": "UNPROVEN",
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
  "/legal-profile": "UNPROVEN",
  "/legal-profile/change": "UNPROVEN",
  "/framework/accept": "MONOTONIC_REPLAY_SAFE", // exact-parameter replay; the acceptance row is permanent
  "/delegation/:id/revoke": "UNPROVEN",
  "/payout-profile": "DURABLE_KEY", // PR-C2
  "/payout-profile/revoke": "DURABLE_KEY", // PR-C2
  "/engagements/:id/accept": "UNPROVEN",
  "/engagements/:id/distributions": "DURABLE_KEY", // PR-C2
  "/distributions/:id/correct": "UNPROVEN",
  "/distributions/:id/removal-claim": "UNPROVEN",
  "/acts/:id/accept": "UNPROVEN",
  "/acts/:id/dispute": "UNPROVEN",
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
    // Deliberately small. Each of these carries an actual proof, not an
    // observation that an immediate retry happens to fail today:
    //   DURABLE_KEY            - exact replay, whatever B* did
    //   MONOTONIC_REPLAY_SAFE  - no legal B* restores the precondition
    //   STALE_BOUND            - the request pins what it was made against
    const proven = (table: Readonly<Record<string, Classification>>, kind: Classification) =>
      Object.entries(table).filter(([, value]) => value === kind).map(([route]) => route).sort();

    expect(proven(ADMIN, "DURABLE_KEY")).toEqual([
      "/engagements/:id/activate",
      "/engagements/:id/distributions",
      "/partners/:id/audience/:cityId/verify",
      "/partners/:id/npd-status",
      "/partners/:id/tax-treatment",
      "/retention-policy",
    ]);
    expect(proven(PARTNER, "DURABLE_KEY")).toEqual([
      "/engagements/:id/distributions",
      "/npd-receipts/submit",
      "/payout-profile",
      "/payout-profile/revoke",
    ]);
    expect(proven(ADMIN, "MONOTONIC_REPLAY_SAFE")).toEqual([
      "/partners/:id/activate",
      "/partners/:id/destroy",
      "/partners/:id/framework/issue",
      "/partners/:id/legal-profile/verify",
    ]);
    expect(proven(PARTNER, "MONOTONIC_REPLAY_SAFE")).toEqual([
      "/framework/accept",
      "/invite/consume",
    ]);
    expect(proven(ADMIN, "STALE_BOUND")).toEqual([
      "/ord/creative-registrations/:id/correct",
      "/partners/:id/legal-profile/change/:requestId/verify",
    ]);
    expect(proven(PARTNER, "STALE_BOUND")).toEqual([]);

    // The total is asserted rather than left to be recomputed by hand: the
    // first write-up of this said 16 by forgetting the partner monotonic
    // pair, which is exactly the arithmetic a pinned number prevents.
    const provenTotal = [...Object.values(ADMIN), ...Object.values(PARTNER)]
      .filter((value) => value === "DURABLE_KEY" || value === "STALE_BOUND" || value === "MONOTONIC_REPLAY_SAFE").length;
    expect(provenTotal).toBe(18);
  });

  it("pins what is still UNPROVEN, which must be zero before rollout", () => {
    // This number GREW when the obligation was corrected, and that is the
    // honest outcome rather than a regression: the previous zero was
    // measured against "A, immediate retry A", which accepted a state gate
    // B* can legally re-open and equality against the current row as proofs.
    // Neither survives A -> B* -> retry A.
    const unproven = (table: Readonly<Record<string, Classification>>) =>
      Object.entries(table).filter(([, value]) => value === "UNPROVEN").map(([route]) => route);
    expect(unproven(ADMIN).length).toBe(54);
    expect(unproven(PARTNER).length).toBe(8);
  });

  it("keeps the special class visible rather than counting it as closed", () => {
    // /partners/:id/invite/reissue returns a raw token that is never
    // persisted, so no idempotency mechanism can re-serve the original after
    // a lost response. It needs defined recovery semantics, and until it has
    // them the rollout gate is not closed - a zero elsewhere does not cover it.
    expect(ADMIN["/partners/:id/invite/reissue"]).toBe("SPECIAL_RECOVERY");
  });
});
