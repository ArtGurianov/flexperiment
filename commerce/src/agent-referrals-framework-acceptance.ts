import type Database from "better-sqlite3";
import { id } from "./crypto";
import { getPartnerIdentity, recordPartnerIdentityEvent, transitionOnboardingStateInTransaction } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { consumeStepUpGrantInTransaction } from "./agent-referrals-step-up";
import { requiredFrameworkIssuance, frameworkAcceptanceByPartnerAndIssuance } from "./agent-referrals-framework-issuance";
import { currentAgentReferralsLegalProfile } from "./agent-referrals-legal-profile";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * One atomic idempotent command: framework_acceptances,
 * ord_reporting_delegations, partner-realm audit evidence, an email_outbox
 * confirmation record, and (only on the FIRST-ever acceptance) the
 * onboarding transition to FRAMEWORK_ACCEPTED either all commit together
 * or none does.
 *
 * PR2 of the reissuance/evidence program: the caller pins the exact
 * (issuance, legal-profile revision) pair it composed the step-up resource
 * against - canonicalV2({ issuance_id, legal_profile_revision_id }) - and
 * this transaction RE-CHECKS both are still current before consuming the
 * grant: a required issuance that moved (a newer one issued between
 * step-up and accept) or a legal profile that changed in that same window
 * must never be silently accepted as if nothing moved. Both fail 409,
 * never a silent divergent acceptance.
 *
 * The idempotent-replay short-circuit is now keyed by (partner, issuance_id)
 * - never the old revision-id pair - because a partner may legitimately
 * accept a SECOND, later issuance; UNIQUE(partner_identity_id, issuance_id)
 * on framework_acceptances is what makes this a correct idempotency key
 * without a second "did anything change" branch.
 *
 * Global SUSPENDED/DORMANT blocks new framework acceptance (plan section
 * B-8), checked inside this same transaction, after the idempotent-replay
 * short-circuit - a replay is re-confirming evidence that already existed
 * before suspension, not new authority, so it must not spuriously fail a
 * legitimate retry racing a suspension.
 */

export class FrameworkAcceptanceError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AcceptFrameworkResult = {
  framework_acceptance_id: string;
  ord_reporting_delegation_id: string;
  replayed: boolean;
};

export const acceptFrameworkAndDelegation = (
  db: Database.Database,
  partner: PartnerPrincipal,
  stepUpGrantId: string,
  issuanceId: string,
  legalProfileRevisionId: string,
): AcceptFrameworkResult => {
  const run = db.transaction((): AcceptFrameworkResult => {
    const identity = getPartnerIdentity(db, partner.partner_identity_id);
    if (!identity) throw new FrameworkAcceptanceError("PARTNER_IDENTITY_NOT_FOUND", 404);

    const required = requiredFrameworkIssuance(db, partner.partner_identity_id);
    if (!required) throw new FrameworkAcceptanceError("AGENT_REFERRALS_FRAMEWORK_NOT_ISSUED", 409);

    // Exact-parameter replay: same partner, same (required) issuance,
    // already accepted - idempotent no-op, no new writes, no suspension
    // gate (this is not new authority).
    const existingAcceptance = frameworkAcceptanceByPartnerAndIssuance(db, partner.partner_identity_id, required.id);
    if (existingAcceptance) {
      const delegation = db.prepare("SELECT id FROM ord_reporting_delegations WHERE framework_acceptance_id = ?").get(existingAcceptance.id) as { id: string };
      return { framework_acceptance_id: existingAcceptance.id, ord_reporting_delegation_id: delegation.id, replayed: true };
    }

    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "FRAMEWORK_ACCEPTANCE");

    // The required issuance must still be the one the caller composed the
    // step-up resource against - a newer issuance minted between step-up
    // and this call must never be silently substituted in.
    if (required.id !== issuanceId) throw new FrameworkAcceptanceError("AGENT_REFERRALS_AGREEMENT_ISSUANCE_SUPERSEDED", 409, required.id);

    // Likewise the current legal profile must still be the exact revision
    // the caller composed the step-up resource against.
    const currentProfile = currentAgentReferralsLegalProfile(db, identity.agent_id);
    if (!currentProfile || currentProfile.id !== legalProfileRevisionId) {
      throw new FrameworkAcceptanceError("AGENT_REFERRALS_LEGAL_PROFILE_CHANGED", 409, currentProfile?.id ?? "null");
    }

    consumeStepUpGrantInTransaction(db, partner, stepUpGrantId, "FRAMEWORK_ACCEPTANCE", {
      issuance_id: issuanceId,
      legal_profile_revision_id: legalProfileRevisionId,
    });

    const acceptanceId = id();
    db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id)
      VALUES (?, ?, ?, ?, ?)`)
      .run(acceptanceId, partner.partner_identity_id, required.id, legalProfileRevisionId, stepUpGrantId);

    const delegationId = id();
    db.prepare(`INSERT INTO ord_reporting_delegations(id, partner_identity_id, framework_acceptance_id, delegation_template_revision_id, ord_reporting_mode)
      VALUES (?, ?, ?, ?, 'FLEXPERIMENT_DELEGATED')`)
      .run(delegationId, partner.partner_identity_id, acceptanceId, required.delegation_template_revision_id);

    recordPartnerIdentityEvent(db, partner.partner_identity_id, "FRAMEWORK_ACCEPTED", "PARTNER", {
      framework_acceptance_id: acceptanceId, ord_reporting_delegation_id: delegationId, issuance_id: required.id,
    });

    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES (?, 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION', ?, ?, 'agent-referrals-framework-confirmation', ?, ?)`)
      .run(id(), identity.email, identity.email_hash, JSON.stringify({ framework_acceptance_id: acceptanceId }), `agent-referrals-framework-confirmation:${acceptanceId}`);

    // PARTNER_ACTIVE is never moved backwards, and the onboarding state
    // machine has no self-loop or backward edge for FRAMEWORK_ACCEPTED/
    // PARTNER_ACTIVE - so a REISSUANCE/REACCEPTANCE round for an already-
    // active partner records evidence only, exactly like
    // acceptEngagement's own later-acceptance branch.
    if (identity.onboarding_state === "FRAMEWORK_ISSUED") {
      transitionOnboardingStateInTransaction(db, partner.partner_identity_id, "FRAMEWORK_ACCEPTED", identity.onboarding_revision, "PARTNER", "framework accepted");
    }

    return { framework_acceptance_id: acceptanceId, ord_reporting_delegation_id: delegationId, replayed: false };
  });
  return run.immediate();
};
