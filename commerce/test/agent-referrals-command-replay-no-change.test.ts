import { describe, expect, it } from "vitest";
import { admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate } from "./support/agent-referrals-settlement-fixtures";
import { mintEngagementRevision, currentEngagementRevision } from "../src/agent-referrals-engagement";
import { reportDistribution, correctDistribution, distributionProjection, currentDistributionRevision } from "../src/agent-referrals-distribution";
import { mintCreativeRevision, authorizeCreative, currentCreativeRevision, lastCreativeAuthorization } from "../src/agent-referrals-creative";
import { mintOrdProviderProfile } from "../src/agent-referrals-ord-provider-profile";
import {
  mintFrameworkAgreementRevision, mintDelegationTemplateRevision,
  FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES,
} from "../src/agent-referrals-framework-delegation";
import { setAgentReferralsChannelPolicy } from "../src/agent-referrals-channel-policy";

/**
 * PR-C2 step 2a: the content-addressed half of the repeatable class.
 *
 * These commands appended a new revision on every call, so a lost response
 * plus one more click renumbered the chain - and in two cases superseded
 * evidence something else already pointed at. Each now returns the existing
 * revision when the content is identical, which is both the right semantics
 * (an identical revision is not a second decision) and what makes a retry
 * harmless.
 *
 * Every case asserts the SAME row comes back and that the chain did not
 * grow - "it did not throw" would prove nothing here.
 */
describe("identical content does not mint a second revision", () => {
  it("engagement revision: re-minting the same terms against the same occurrence material returns the current revision", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
    const before = db.prepare("SELECT COUNT(*) AS n FROM engagement_revisions WHERE engagement_id = ?").get(engagementId) as { n: number };

    // ONE terms object, reused: nearTermTerms() derives its publication
    // window from Date.now(), so calling it twice would legitimately be two
    // different revisions - and the test would be asserting nothing.
    const terms = nearTermTerms(2000);
    const first = mintEngagementRevision(db, admin, engagementId, terms, "repriced", currentEngagementRevision(db, engagementId)?.id ?? null);
    const replay = mintEngagementRevision(db, admin, engagementId, terms, "retry after a lost response", currentEngagementRevision(db, engagementId)?.id ?? null);
    expect(replay.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_revisions WHERE engagement_id = ?").get(engagementId))
      .toEqual({ n: before.n + 1 });

    // Genuinely different terms still mint: the branch is a no-change check,
    // not a lock.
    const changed = mintEngagementRevision(db, admin, engagementId, nearTermTerms(3000), "really repriced", currentEngagementRevision(db, engagementId)?.id ?? null);
    expect(changed.id).not.toBe(first.id);
  });

  it("distribution correction: restating the current revision returns it instead of renumbering the chain", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
    const report = {
      channel_key: "telegram", resource_kind: "channel" as const, resource_identifier: "@ch",
      distribution_resource_url: "https://t.me/ch/1", published_at: new Date().toISOString(), ended_at: null,
      evidence_ref: "ev-1",
    };
    const { distribution_id: distributionId } = reportDistribution(db, admin, engagementId, report);
    const corrected = correctDistribution(db, admin, distributionId, { ...report, evidence_ref: "ev-2" }, "fixed the evidence", currentDistributionRevision(db, distributionId)!.id);
    const countEvents = () => (db.prepare("SELECT COUNT(*) AS n FROM engagement_distribution_events WHERE distribution_id = ?").get(distributionId) as { n: number }).n;
    const eventsAfterCorrection = countEvents();

    const replay = correctDistribution(db, admin, distributionId, { ...report, evidence_ref: "ev-2" }, "retry after a lost response", currentDistributionRevision(db, distributionId)!.id);

    expect(replay.revision.id).toBe(corrected.revision.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId))
      .toEqual({ n: 2 });
    // And no classification events either: the old path appended a fresh
    // classification on every call, so the count is compared against the
    // state right before the replay rather than against a guessed absolute.
    expect(countEvents()).toBe(eventsAfterCorrection);
  });

  it("creative revision and its authorization: identical content returns the current row, and the live authority is not churned", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
    const material = {
      format_kind: "post" as const, media_ref: "m1", copy_text: "c", cta_text: "cta",
      mandatory_labeling_text: "Реклама. ООО Ромашка", creative_target_url: "https://example.test/x",
    };

    const first = mintCreativeRevision(db, admin, engagementId, material, currentCreativeRevision(db, engagementId)?.id ?? null);
    expect(mintCreativeRevision(db, admin, engagementId, material, currentCreativeRevision(db, engagementId)?.id ?? null).id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_creative_revisions WHERE engagement_id = ?").get(engagementId)).toEqual({ n: 1 });

    const authorization = authorizeCreative(db, admin, engagementId, first.id, lastCreativeAuthorization(db, engagementId)?.id ?? null);
    const replayedAuthorization = authorizeCreative(db, admin, engagementId, first.id, lastCreativeAuthorization(db, engagementId)?.id ?? null);
    expect(replayedAuthorization.id).toBe(authorization.id);
    // The old path revoked the live authorization and minted a replacement,
    // so a retry left a revoked row behind for authority nothing superseded.
    expect(db.prepare("SELECT COUNT(*) AS n FROM engagement_creative_authorizations WHERE engagement_id = ?").get(engagementId)).toEqual({ n: 1 });
    expect(db.prepare("SELECT revoked_at FROM engagement_creative_authorizations WHERE id = ?").get(authorization.id)).toEqual({ revoked_at: null });
  });

  it("global content chains: ORD provider profile, framework agreement and delegation template", () => {
    const { db } = fresh();
    const profile = mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "x" }, "initial", null);
    // The retry carries the SAME stale pin the first attempt did - the
    // no-change branch answers before the pin is consulted, which is what
    // keeps an ordinary lost-response retry a success rather than a 409.
    expect(mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "x" }, "retry", null).id).toBe(profile.id);
    expect(mintOrdProviderProfile(db, "admin-1", "CONTRACT", { contract: "y" }, "genuine change", profile.id).id).not.toBe(profile.id);

    const agreement = mintFrameworkAgreementRevision(db, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.reduce((acc, key) => ({ ...acc, [key]: `${key} text` }), {} as Record<string, string>), null);
    expect(mintFrameworkAgreementRevision(db, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES.reduce((acc, key) => ({ ...acc, [key]: `${key} text` }), {} as Record<string, string>), null).id).toBe(agreement.id);

    const template = mintDelegationTemplateRevision(db, DELEGATION_TEMPLATE_REQUIRED_CLAUSES.reduce((acc, key) => ({ ...acc, [key]: `${key} text` }), {} as Record<string, string>), null);
    expect(mintDelegationTemplateRevision(db, DELEGATION_TEMPLATE_REQUIRED_CLAUSES.reduce((acc, key) => ({ ...acc, [key]: `${key} text` }), {} as Record<string, string>), null).id).toBe(template.id);
  });

  it("channel policy: the same status from the same instant does not renumber the chain", () => {
    const { db } = fresh();
    const effectiveFrom = new Date().toISOString();
    // telegram is seeded at policy_revision 1 by 0043, so that is what this
    // command is authored against.
    const first = setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "BLOCKED", effective_from: effectiveFrom, reason: "policy", expected_policy_revision: 1 });
    // telegram is seeded ALLOWED at revision 1 by 0043, so the count is
    // compared across the replay rather than against an absolute.
    const countRows = () => (db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy WHERE channel_key = 'telegram'").get() as { n: number }).n;
    const rowsAfterFirst = countRows();
    const replay = setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "BLOCKED", effective_from: effectiveFrom, reason: "retry", expected_policy_revision: 1 });
    expect(replay.policy_revision).toBe(first.policy_revision);
    expect(countRows()).toBe(rowsAfterFirst);

    const changed = setAgentReferralsChannelPolicy(db, { channel_key: "telegram", status: "REVIEW_REQUIRED", effective_from: effectiveFrom, reason: "escalated", expected_policy_revision: first.policy_revision });
    expect(changed.policy_revision).toBe(first.policy_revision + 1);
  });
});
