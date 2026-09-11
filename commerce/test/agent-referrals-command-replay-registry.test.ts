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
  "/partners/:id/audience/:cityId/revoke": "UNAUDITED",
  "/delegations/:id/revoke": "UNAUDITED",
  "/partners/:id/npd-status": "REPEATABLE", // sequence + 1
  "/retention-policy": "REPEATABLE", // revision + 1, no same-content branch
  "/partners/:id/legal-hold": "REPEATABLE", // unconditional INSERT; each hold independently blocks destruction
  "/legal-holds/:id/release": "UNAUDITED",
  "/partners/:id/destroy": "UNAUDITED",
  "/framework-agreement-revisions": "REPEATABLE", // revision + 1
  "/delegation-template-revisions": "REPEATABLE", // revision + 1
  "/channel-policy": "REPEATABLE", // MAX(policy_revision) + 1
  "/engagements": "REPLAY_SAFE", // engagementByPartnerAndOccurrence -> ALREADY_EXISTS
  "/engagements/:id/revisions": "REPEATABLE", // a new engagement revision per call
  "/engagements/:id/activate": "REPEATABLE", // CAS is not idempotency: revokes the live authorization, writes a second activation event
  "/engagements/:id/suspend": "UNAUDITED",
  "/engagements/:id/close": "UNAUDITED",
  "/engagements/:id/creative": "REPEATABLE", // revision + 1
  "/engagements/:id/creative/:revisionId/authorize": "REPEATABLE", // revokes and re-inserts even for the same creative revision
  "/creative-authorizations/:id/revoke": "UNAUDITED",
  "/engagements/:id/distributions": "REPEATABLE", // fresh distribution identity per call (same command as the partner route)
  "/distributions/:id/correct": "REPEATABLE", // revision + 1, no same-content branch
  "/distributions/:id/require-removal": "UNAUDITED",
  "/distributions/:id/confirm-removal": "UNAUDITED",
  "/distributions/:id/mark-overdue": "UNAUDITED",
  "/distributions/:id/mark-unverified": "UNAUDITED",
  "/distributions/:id/review-cleared": "UNAUDITED",
  "/ord/provider-profile": "REPEATABLE", // MAX(revision) + 1
  "/ord/provider-operation": "UNAUDITED",
  "/ord/provider-operation/:id/submitted": "UNAUDITED",
  "/ord/provider-operation/:id/confirm": "UNAUDITED",
  "/ord/provider-operation/:id/erir": "UNAUDITED",
  "/ord/provider-operation/:id/lock": "UNAUDITED",
  "/creative-revisions/:id/register": "REPLAY_SAFE", // existing current registration -> replayed: true
  "/ord/creative-registrations/:id/submitted": "UNAUDITED",
  "/ord/creative-registrations/:id/confirm": "UNAUDITED",
  "/ord/creative-registrations/:id/correct": "REPLAY_SAFE", // bound to a predecessor id; a second attempt is STALE
  "/ord/creative-registrations/:id/erir": "UNAUDITED",
  "/ord/creative-registrations/:id/lock": "UNAUDITED",
  "/distributions/:id/reports": "REPLAY_SAFE", // explicit exact-semantic replay in insertReport
  "/distributions/:id/reports/:periodKey/reconciliation": "REPLAY_SAFE", // same insertReport path, identical reconciliation mints no revision
  "/engagements/:id/reward-registry/finalize": "UNAUDITED",
  "/engagements/:id/reward-registry/correct": "UNAUDITED",
  "/engagements/:id/zero-reward-closure": "UNAUDITED",
  "/settlements": "REPLAY_SAFE", // settlementForEffectiveSnapshot -> replayed: true
  "/settlements/:id/act": "UNAUDITED",
  "/acts/:id/present": "UNAUDITED",
  "/paid-invoices": "REPLAY_SAFE", // idempotent by act_id, returns the byte-identical payload
  "/paid-invoices/:id/submission": "UNAUDITED",
  "/paid-invoices/:id/reconciliation": "UNAUDITED",
  "/payments/begin": "REPLAY_SAFE", // unique active attempt -> ATTEMPT_ALREADY_ACTIVE
  "/payment-attempts/:id/made": "UNAUDITED",
  "/payment-attempts/:id/payout-unknown": "UNAUDITED",
  "/payment-attempts/:id/confirmed-not-made": "UNAUDITED",
  "/payment-attempts/:id/npd-receipt": "UNAUDITED",
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
  "/legal-profile": "REPEATABLE", // re-accepts PROFILE_SUBMITTED, appends another LEGAL_PROFILE_SUBMITTED event
  "/legal-profile/change": "REPLAY_SAFE", // partial unique index -> ALREADY_PENDING
  "/framework/accept": "REPLAY_SAFE", // exact-parameter replay -> idempotent no-op
  "/delegation/:id/revoke": "UNAUDITED",
  "/payout-profile": "REPEATABLE", // revision + 1; the retry's fresh grant binds to the NEW revision
  "/payout-profile/revoke": "REPEATABLE", // revision + 1
  "/engagements/:id/accept": "REPLAY_SAFE", // existing acceptance -> replayed: true
  "/engagements/:id/distributions": "REPEATABLE", // fresh distribution identity per call
  "/distributions/:id/correct": "REPEATABLE", // same command as the admin route, exposed in both realms
  "/distributions/:id/removal-claim": "UNAUDITED",
  "/acts/:id/accept": "REPLAY_SAFE", // existing acceptance -> replayed: true
  "/acts/:id/dispute": "UNAUDITED",
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
    expect(repeatable(ADMIN)).toEqual([
      "/channel-policy",
      "/delegation-template-revisions",
      "/distributions/:id/correct",
      "/engagements/:id/activate",
      "/engagements/:id/creative",
      "/engagements/:id/creative/:revisionId/authorize",
      "/engagements/:id/distributions",
      "/engagements/:id/revisions",
      "/framework-agreement-revisions",
      "/ord/provider-profile",
      "/partners/:id/audience/:cityId/verify",
      "/partners/:id/legal-hold",
      "/partners/:id/npd-status",
      "/retention-policy",
    ]);
    expect(repeatable(PARTNER)).toEqual([
      "/distributions/:id/correct",
      "/engagements/:id/distributions",
      "/legal-profile",
      "/npd-receipts/submit",
      "/payout-profile",
      "/payout-profile/revoke",
    ]);
  });

  it("pins what is still UNAUDITED, which must be empty before rollout", () => {
    // This is the honest state of the audit, not a hidden gap: PR-C2 has to
    // drive both of these to zero, and CI will not let the number drift
    // upward unnoticed in the meantime.
    const unaudited = (table: Readonly<Record<string, Classification>>) =>
      Object.values(table).filter((value) => value === "UNAUDITED").length;
    expect(unaudited(ADMIN)).toBe(32);
    expect(unaudited(PARTNER)).toBe(3);
  });
});
