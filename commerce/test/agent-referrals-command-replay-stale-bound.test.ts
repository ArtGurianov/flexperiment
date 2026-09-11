import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, FAR_FUTURE } from "./support/agent-referrals-settlement-fixtures";
import {
  mintEngagementRevision, currentEngagementRevision, suspendEngagement, getEngagement, activateEngagement,
  verifyAudienceForPartnerCity, revokeAudienceVerificationForPartnerCity,
} from "../src/agent-referrals-engagement";
import { currentAudienceVerification } from "../src/agent-referrals-audience-verification";
import { mintCreativeRevision, currentCreativeRevision, authorizeCreative, lastCreativeAuthorization, revokeCreativeAuthorization } from "../src/agent-referrals-creative";
import {
  reportDistribution, correctDistribution, currentDistributionRevision, distributionProjection,
  requireRemoval, claimRemoval,
} from "../src/agent-referrals-distribution";
import { setAgentReferralsChannelPolicy, currentAgentReferralsChannelPolicyRevision, resolveAgentReferralsChannelPolicyNow } from "../src/agent-referrals-channel-policy";
import { mintFrameworkAgreementRevision, currentFrameworkAgreementRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintOrdProviderProfile, currentOrdProviderProfile } from "../src/agent-referrals-ord-provider-profile";
import {
  openOrdProviderOperation, currentOrdProviderOperation, recordOrdProviderOperationSubmitted,
  confirmOrdProviderOperation, ordProviderOperationById,
} from "../src/agent-referrals-ord-provider-operation";
import { submitPartnerLegalProfile, provisionPartnerOwner } from "../src/agent-referrals-partner-identity";
import { getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { submitLegalProfileSupersession, currentLegalProfileRevisionForPartner } from "../src/agent-referrals-legal-profile-supersession";
import { suspendAgentReferrals, reactivateAgentReferrals, agentReferralsFeatureState, activateAgentReferrals } from "../src/agent-referrals-feature-state";

/**
 * PR-C2: the regression suite behind every STALE_BOUND classification in
 * commerce/test/agent-referrals-command-replay-registry.test.ts.
 *
 * Every case has the SAME three-step shape, because the obligation does:
 *
 *     A commits, its response is lost
 *     a legal B* occurs - chosen to be the strongest attack on that pin
 *     the ORIGINAL A is retried, byte for byte
 *
 * and asserts the same three things, because "it threw" proves nothing:
 *
 *   1. no row created by B was overwritten
 *   2. no new row derived from A exists after B
 *   3. the current authority is still B's
 *
 * plus the per-class assertion - here, that the refusal is the named stale
 * code rather than an incidental 500 or a constraint error.
 *
 * The B* in each case is deliberately the one that RESTORES the surface
 * condition the old, weaker classification relied on: a reactivation after a
 * suspension, a re-verification after a revocation, a revert back to the
 * content A itself wrote. Those are exactly the sequences under which a
 * state gate or a current-row equality check silently lets a stale retry
 * through.
 */

const expectStale = (run: () => unknown, code: string) => {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect((thrown as { code?: string } | undefined)?.code, `expected ${code}, got ${String(thrown)}`).toBe(code);
};

const activeEngagement = (db: Database.Database) => {
  const p1 = readyPartner(db);
  const occurrenceId = seedOccurrence(db, p1.cityId);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
  return { p1, occurrenceId, engagementId };
};

const creativeFields = (copy: string) => ({
  format_kind: "post" as const, media_ref: "m1", copy_text: copy, cta_text: "cta",
  mandatory_labeling_text: "Реклама. ООО Ромашка", creative_target_url: "https://example.test/x",
});

const distributionReport = (evidence: string) => ({
  channel_key: "telegram", resource_kind: "channel" as const, resource_identifier: "@ch",
  distribution_resource_url: "https://t.me/ch/1", published_at: new Date().toISOString(), ended_at: null,
  evidence_ref: evidence,
});

describe("STALE_BOUND: a retry that arrives after a legal B* is refused, not applied", () => {
  it("engagement revisions: B mints revision 3, the retried A does not reinstate its own terms as current", () => {
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);
    const pinA = currentEngagementRevision(db, engagementId)!.id;

    const a = mintEngagementRevision(db, admin, engagementId, nearTermTerms(2000), "A: repriced", pinA);
    const b = mintEngagementRevision(db, admin, engagementId, nearTermTerms(3000), "B: repriced again", a.id);

    expectStale(
      () => mintEngagementRevision(db, admin, engagementId, nearTermTerms(2000), "A: repriced", pinA),
      "AGENT_REFERRALS_ENGAGEMENT_REVISION_STALE",
    );

    const rows = db.prepare("SELECT id, customer_discount_value FROM engagement_revisions WHERE engagement_id = ? ORDER BY revision").all(engagementId) as { id: string; customer_discount_value: number }[];
    expect(rows.map((r) => r.id)).toEqual([pinA, a.id, b.id]);                       // 2: no new A-derived row
    expect(rows[2].customer_discount_value).toBe(3000);                              // 1: B's row untouched
    expect(currentEngagementRevision(db, engagementId)!.id).toBe(b.id);              // 3: authority is B's
  });

  it("engagement revisions: even a REVERT to A's exact terms does not let a stale retry through", () => {
    // The A -> B -> A case the old current-row equality check could not see.
    // Reverting is legitimate, and after it the candidate equals the current
    // row again - so content alone cannot tell the revert from the retry.
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);
    const pinA = currentEngagementRevision(db, engagementId)!.id;
    const termsA = nearTermTerms(2000);

    const a = mintEngagementRevision(db, admin, engagementId, termsA, "A", pinA);
    const b = mintEngagementRevision(db, admin, engagementId, nearTermTerms(3000), "B", a.id);
    const revert = mintEngagementRevision(db, admin, engagementId, termsA, "B2: revert", b.id);

    // The retry's content now equals the current row - the no-change branch
    // answers, and answering means returning the CURRENT revision without
    // writing anything, never resurrecting A's own row.
    const retried = mintEngagementRevision(db, admin, engagementId, termsA, "A", pinA);
    expect(retried.id).toBe(revert.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM engagement_revisions WHERE engagement_id = ?").get(engagementId) as { n: number }).n).toBe(4);
    expect(currentEngagementRevision(db, engagementId)!.id).toBe(revert.id);
  });

  it("engagement suspension: a reactivation re-opens the ACTIVE gate, and the retried suspend is refused", () => {
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);
    const pinA = getEngagement(db, engagementId)!.lifecycle_revision;
    const activeRevisionId = currentEngagementRevision(db, engagementId)!.id;

    suspendEngagement(db, admin, engagementId, "A: suspend", pinA);
    // B: the reactivation the old "requires ACTIVE" classification assumed
    // could never happen.
    activateEngagement(db, admin, engagementId, activeRevisionId);
    const afterB = getEngagement(db, engagementId)!;
    expect(afterB.lifecycle_state).toBe("ACTIVE");
    const promoAfterB = db.prepare("SELECT id, revoked_at FROM engagement_promo_authorizations WHERE engagement_id = ? AND revoked_at IS NULL").get(engagementId) as { id: string } | undefined;
    expect(promoAfterB).toBeTruthy();

    expectStale(() => suspendEngagement(db, admin, engagementId, "A: suspend", pinA), "AGENT_REFERRALS_ENGAGEMENT_LIFECYCLE_STALE");

    const afterRetry = getEngagement(db, engagementId)!;
    expect(afterRetry.lifecycle_state).toBe("ACTIVE");                               // 3
    expect(afterRetry.lifecycle_revision).toBe(afterB.lifecycle_revision);           // 2
    // 1: B's promo authorization was not revoked by the retry.
    expect(db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(promoAfterB!.id)).toEqual({ revoked_at: null });
  });

  it("audience verification: a re-verification after the revoke does not get revoked again by the retry", () => {
    const { db } = fresh();
    const { p1, engagementId } = activeEngagement(db);
    const pinA = currentAudienceVerification(db, p1.partnerIdentityId, p1.cityId)!.aggregate_revision;

    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "A: revoke", "ev-a", pinA);
    // B: the operator verifies the audience again - ordinary work, and it
    // puts a VERIFIED row back at the head of the aggregate.
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, FAR_FUTURE, "B: re-verified", "ev-b");
    const afterB = currentAudienceVerification(db, p1.partnerIdentityId, p1.cityId)!;
    expect(afterB.event_kind).toBe("VERIFIED");
    const eventsAfterB = (db.prepare("SELECT COUNT(*) AS n FROM partner_audience_verification_events WHERE partner_identity_id = ?").get(p1.partnerIdentityId) as { n: number }).n;

    expectStale(
      () => revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "A: revoke", "ev-a", pinA),
      "AGENT_REFERRALS_AUDIENCE_VERIFICATION_STALE",
    );

    expect(currentAudienceVerification(db, p1.partnerIdentityId, p1.cityId)!.id).toBe(afterB.id);   // 1 and 3
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_audience_verification_events WHERE partner_identity_id = ?").get(p1.partnerIdentityId) as { n: number }).n).toBe(eventsAfterB); // 2
    // A's own cascade legitimately suspended the engagement, and a
    // re-verification does not reactivate anything by itself - so the
    // engagement is still SUSPENDED here. What matters is that the RETRY
    // cascaded nothing further: no second suspension event.
    expect(getEngagement(db, engagementId)!.lifecycle_state).toBe("SUSPENDED");
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE event_kind = 'ENGAGEMENT_SUSPENDED'").get() as { n: number }).n).toBe(1);
  });

  it("creative authorization: revoking is legal, so the retry is pinned to the chain head rather than the live row", () => {
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);
    const creative = mintCreativeRevision(db, admin, engagementId, creativeFields("copy"), null);

    const a = authorizeCreative(db, admin, engagementId, creative.id, null);
    // B: revoke. The LIVE authorization is now null again - exactly the
    // value A's pin was authored against, which is why the pin is the chain
    // head and not the live row.
    revokeCreativeAuthorization(db, admin, a.id, "B: revoked");

    expectStale(() => authorizeCreative(db, admin, engagementId, creative.id, null), "AGENT_REFERRALS_CREATIVE_AUTHORIZATION_STALE");

    const rows = db.prepare("SELECT id, revoked_at, revoked_reason FROM engagement_creative_authorizations WHERE engagement_id = ?").all(engagementId) as { id: string; revoked_at: string | null; revoked_reason: string | null }[];
    expect(rows.map((r) => r.id)).toEqual([a.id]);                                   // 2: no second authorization
    expect(rows[0].revoked_reason).toBe("B: revoked");                               // 1: B's write intact
    expect(lastCreativeAuthorization(db, engagementId)!.id).toBe(a.id);              // 3
    expect(db.prepare("SELECT id FROM engagement_creative_authorizations WHERE engagement_id = ? AND revoked_at IS NULL").get(engagementId)).toBeUndefined();
  });

  it("distribution lifecycle: required -> claimed -> retried require is refused, because the cycle restores the state A saw", () => {
    const { db } = fresh();
    const { p1, engagementId } = activeEngagement(db);
    const { distribution_id: distributionId } = reportDistribution(db, admin, engagementId, distributionReport("ev-1"));
    // Put the removal lifecycle into a known state first.
    requireRemoval(db, admin, distributionId, "seed", distributionProjection(db, distributionId).event_sequence);
    claimRemoval(db, p1.partner, distributionId, "ev-claim-seed", distributionProjection(db, distributionId).event_sequence);

    const pinA = distributionProjection(db, distributionId).event_sequence;
    requireRemoval(db, admin, distributionId, "A: take it down", pinA);
    // B: the partner claims the take-down. REMOVAL_REQUIRED is legal again
    // from REMOVAL_CLAIMED, so the state A was authored against is back.
    claimRemoval(db, p1.partner, distributionId, "ev-claim-b", distributionProjection(db, distributionId).event_sequence);
    const afterB = distributionProjection(db, distributionId);
    expect(afterB.removal_state).toBe("REMOVAL_CLAIMED");

    expectStale(() => requireRemoval(db, admin, distributionId, "A: take it down", pinA), "AGENT_REFERRALS_DISTRIBUTION_EVENT_STALE");

    const after = distributionProjection(db, distributionId);
    expect(after.removal_state).toBe("REMOVAL_CLAIMED");                             // 3: B's claim still stands
    expect(after.event_sequence).toBe(afterB.event_sequence);                        // 2: no new event
    expect((db.prepare("SELECT COUNT(*) AS n FROM engagement_distribution_events WHERE distribution_id = ? AND event_kind = 'REMOVAL_REQUIRED' AND reason = 'A: take it down'").get(distributionId) as { n: number }).n).toBe(1);
  });

  it("distribution corrections: a retried correction does not reinstate facts a later correction replaced", () => {
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);
    const { distribution_id: distributionId } = reportDistribution(db, admin, engagementId, distributionReport("ev-1"));
    const pinA = currentDistributionRevision(db, distributionId)!.id;

    const a = correctDistribution(db, admin, distributionId, distributionReport("ev-a"), "A: fixed evidence", pinA);
    const b = correctDistribution(db, admin, distributionId, distributionReport("ev-b"), "B: fixed again", a.revision.id);

    expectStale(
      () => correctDistribution(db, admin, distributionId, distributionReport("ev-a"), "A: fixed evidence", pinA),
      "AGENT_REFERRALS_DISTRIBUTION_REVISION_STALE",
    );

    const revisions = db.prepare("SELECT id, evidence_ref FROM engagement_distribution_revisions WHERE distribution_id = ? ORDER BY revision").all(distributionId) as { id: string; evidence_ref: string }[];
    expect(revisions.map((r) => r.id)).toEqual([pinA, a.revision.id, b.revision.id]); // 2
    expect(revisions[2].evidence_ref).toBe("ev-b");                                   // 1
    expect(currentDistributionRevision(db, distributionId)!.id).toBe(b.revision.id);  // 3
  });

  it("channel policy: a retry does not put A's status back over a later decision", () => {
    const { db } = fresh();
    readyPartner(db);
    const effectiveFrom = "2021-01-01T00:00:00.000Z";
    const pinA = currentAgentReferralsChannelPolicyRevision(db, "telegram");

    const a = setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "BLOCKED", effective_from: effectiveFrom, reason: "A", expected_policy_revision: pinA });
    const b = setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "REVIEW_REQUIRED", effective_from: effectiveFrom, reason: "B", expected_policy_revision: a.policy_revision });

    expectStale(
      () => setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "BLOCKED", effective_from: effectiveFrom, reason: "A", expected_policy_revision: pinA }),
      "AGENT_REFERRALS_CHANNEL_POLICY_STALE",
    );

    expect(currentAgentReferralsChannelPolicyRevision(db, "telegram")).toBe(b.policy_revision);   // 2 and 3
    expect(resolveAgentReferralsChannelPolicyNow(db, "telegram").status).toBe("REVIEW_REQUIRED"); // 1
  });

  it("global content chains: framework agreement and ORD provider profile", () => {
    const { db } = fresh();
    const clauses = (suffix: string) => Object.fromEntries(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.map((k) => [k, `${k} ${suffix}`])) as Record<string, string>;

    const a = mintFrameworkAgreementRevision(db, clauses("A"), null);
    const b = mintFrameworkAgreementRevision(db, clauses("B"), a.id);
    expectStale(() => mintFrameworkAgreementRevision(db, clauses("A"), null), "AGENT_REFERRALS_CONTENT_REVISION_STALE");
    expect(currentFrameworkAgreementRevision(db)!.id).toBe(b.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM framework_agreement_revisions").get() as { n: number }).n).toBe(2);

    const pa = mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "A" }, "A", null);
    const pb = mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "B" }, "B", pa.id);
    expectStale(() => mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "A" }, "A", null), "AGENT_REFERRALS_CONTENT_REVISION_STALE");
    expect(currentOrdProviderProfile(db, "CONTRACT")!.id).toBe(pb.id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ord_provider_profile_revisions WHERE profile_kind = 'CONTRACT'").get() as { n: number }).n).toBe(2);
  });

  it("ORD provider operation: confirming re-opens the state `open` may act on, and the retried open does not mint a correction", () => {
    const { db } = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "x" }, "initial", null);

    const a = openOrdProviderOperation(db, "admin-1", "CONTRACT", null);
    // B: submit and confirm. lock_state is now CORRECTION_ONLY - which is
    // precisely the state openOrdProviderOperation is allowed to reopen
    // from, so the old "idempotent while DRAFT" reasoning would let the
    // retry mint a whole extra revision.
    recordOrdProviderOperationSubmitted(db, a.operation.id, "vk-1", "ev-1");
    confirmOrdProviderOperation(db, a.operation.id);
    expect(ordProviderOperationById(db, a.operation.id)!.lock_state).toBe("CORRECTION_ONLY");

    expectStale(() => openOrdProviderOperation(db, "admin-1", "CONTRACT", null), "AGENT_REFERRALS_ORD_PROVIDER_OPERATION_STALE");

    expect((db.prepare("SELECT COUNT(*) AS n FROM ord_provider_operations WHERE operation_kind = 'CONTRACT'").get() as { n: number }).n).toBe(1);
    expect(currentOrdProviderOperation(db, "CONTRACT")!.id).toBe(a.operation.id);
    expect(ordProviderOperationById(db, a.operation.id)!.local_state).toBe("CONFIRMED");
  });

  it("ORD submission is MONOTONIC, not pinned: the observed id cannot be replaced, and evidence_ref is first-writer-wins", () => {
    // Classified STALE_BOUND in the first pass and corrected here: 0048's
    // ord_provider_operations_observed_id_immutable_guard already makes a
    // non-null vk_external_id unchangeable, so no legal B* exists to pin
    // against. What WAS reachable is an evidence_ref overwrite, which the
    // first-writer-wins branch now refuses by name.
    const { db } = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "x" }, "initial", null);
    const { operation } = openOrdProviderOperation(db, "admin-1", "CONTRACT", null);

    recordOrdProviderOperationSubmitted(db, operation.id, "vk-1", "ev-a");
    // An exact restatement is a replay - it writes nothing.
    expect(recordOrdProviderOperationSubmitted(db, operation.id, "vk-1", "ev-a").evidence_ref).toBe("ev-a");
    // A different evidence_ref for the same submission is a named conflict,
    // never a silent overwrite of what is already on file.
    expectStale(
      () => recordOrdProviderOperationSubmitted(db, operation.id, "vk-1", "ev-b"),
      "AGENT_REFERRALS_ORD_PROVIDER_OPERATION_SUBMISSION_CONFLICT",
    );
    // And a different external id is refused structurally, by the same code.
    expectStale(
      () => recordOrdProviderOperationSubmitted(db, operation.id, "vk-2", "ev-a"),
      "AGENT_REFERRALS_ORD_PROVIDER_OPERATION_SUBMISSION_CONFLICT",
    );

    const after = ordProviderOperationById(db, operation.id)!;
    expect(after.vk_external_id).toBe("vk-1");
    expect(after.evidence_ref).toBe("ev-a");
  });

  it("partner legal-profile draft: a retried submission does not overwrite a later draft", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    // A fresh identity, still in the draft phase - readyPartner's own is
    // already verified and therefore locked.
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-2', 'PERCENT', 1000)`)
      .run(agentId, `draft-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const { partner_identity_id: identityId } = provisionPartnerOwner(db, admin, agentId, `${agentId.slice(0, 8)}@example.test`, "test");
    const principal = { realm: "PARTNER" as const, partner_identity_id: identityId, partner_session_id: "n/a" };
    void p1;

    submitPartnerLegalProfile(db, principal, "INDIVIDUAL", "NPD", { full_name: "Draft A", inn: "123456789012" }, 0);
    const pinA = 0;
    // B: the partner edits the draft - the same form, one more save.
    submitPartnerLegalProfile(db, principal, "INDIVIDUAL", "NPD", { full_name: "Draft B", inn: "210987654321" }, 1);
    const afterB = getPartnerIdentity(db, identityId)!;
    expect(afterB.submitted_full_name).toBe("Draft B");

    expectStale(
      () => submitPartnerLegalProfile(db, principal, "INDIVIDUAL", "NPD", { full_name: "Draft A", inn: "123456789012" }, pinA),
      "AGENT_REFERRALS_LEGAL_PROFILE_DRAFT_STALE",
    );

    const after = getPartnerIdentity(db, identityId)!;
    expect(after.submitted_full_name).toBe("Draft B");                               // 1 and 3
    expect(after.submitted_inn).toBe("210987654321");
    expect(after.legal_profile_draft_revision).toBe(afterB.legal_profile_draft_revision); // 2
  });

  it("legal-profile supersession: a retry after the first request was verified does not file a second one", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const pinA = currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId);

    const requisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
    const a = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, {
      legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...requisites, reason: "A: became org", evidenceRef: "ev.pdf",
      expectedCurrentLegalProfileRevision: pinA,
    });
    // B: an admin resolves it. The ALREADY_PENDING slot is free again and
    // MAX has moved - the two facts the old classification leaned on.
    db.prepare("UPDATE agent_referrals_legal_profile_change_requests SET state = 'REJECTED', resolved_at = CURRENT_TIMESTAMP, resolved_by = 'admin-1', resolution_reason = 'B: rejected' WHERE id = ?").run(a.id);

    expectStale(
      () => submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, {
        legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...requisites, reason: "A: became org", evidenceRef: "ev.pdf",
        expectedCurrentLegalProfileRevision: pinA - 1,
      }),
      "AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_STALE",
    );

    const rows = db.prepare("SELECT id, state FROM agent_referrals_legal_profile_change_requests WHERE partner_identity_id = ?").all(p1.partnerIdentityId) as { id: string; state: string }[];
    expect(rows.map((r) => r.id)).toEqual([a.id]);                                   // 2
    expect(rows[0].state).toBe("REJECTED");                                          // 1 and 3
  });

  it("feature state: the CAS in the body is the pin, and a reactivation does not let a retried suspend through", () => {
    const { db } = fresh();
    readyPartner(db);
    const pinA = agentReferralsFeatureState(db).revision;

    suspendAgentReferrals(db, { expected_revision: pinA, owner_id: "test-owner", reason: "A: suspend" });
    reactivateAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "B: back" });
    const afterB = agentReferralsFeatureState(db);
    expect(afterB.state).toBe("ACTIVE");

    let thrown: unknown;
    try { suspendAgentReferrals(db, { expected_revision: pinA, owner_id: "test-owner", reason: "A: suspend" }); } catch (error) { thrown = error; }
    expect((thrown as { code?: string }).code).toBe("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT");

    expect(agentReferralsFeatureState(db)).toEqual(afterB);
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events WHERE reason = 'A: suspend'").get() as { n: number }).n).toBe(1);
  });

  it("creative revisions: a retry does not reinstate superseded material as the engagement's current creative", () => {
    const { db } = fresh();
    const { engagementId } = activeEngagement(db);

    const a = mintCreativeRevision(db, admin, engagementId, creativeFields("copy A"), null);
    const b = mintCreativeRevision(db, admin, engagementId, creativeFields("copy B"), a.id);

    expectStale(() => mintCreativeRevision(db, admin, engagementId, creativeFields("copy A"), null), "AGENT_REFERRALS_CREATIVE_REVISION_STALE");

    const rows = db.prepare("SELECT id, copy_text FROM engagement_creative_revisions WHERE engagement_id = ? ORDER BY revision").all(engagementId) as { id: string; copy_text: string }[];
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[1].copy_text).toBe("copy B");
    expect(currentCreativeRevision(db, engagementId)!.id).toBe(b.id);
  });
});
