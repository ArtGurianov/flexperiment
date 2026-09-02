import type Database from "better-sqlite3";
import { id } from "./crypto";
import { getPartnerIdentity, recordPartnerIdentityEvent, transitionOnboardingStateInTransaction } from "./agent-referrals-onboarding";
import { consumeStepUpGrantInTransaction } from "./agent-referrals-step-up";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * One atomic idempotent command: framework_acceptances,
 * ord_reporting_delegations, partner-realm audit evidence, an email_outbox
 * confirmation record, and the onboarding transition to FRAMEWORK_ACCEPTED
 * either all commit together or none does. No separate delegation-
 * acceptance screen/command exists anywhere in this module.
 *
 * Both exact template authorities are pinned by the caller - this function
 * never reads "current" framework/delegation revisions itself. That is
 * exactly what makes the UNIQUE(partner_identity_id,
 * framework_agreement_revision_id, delegation_template_revision_id)
 * constraint on framework_acceptances a correct idempotency key: identical
 * parameters on a retry hit the same row, and a genuinely different
 * revision is a different key entirely, never conflated with a replay.
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
  frameworkAgreementRevisionId: string,
  delegationTemplateRevisionId: string,
): AcceptFrameworkResult => {
  const run = db.transaction((): AcceptFrameworkResult => {
    const identity = getPartnerIdentity(db, partner.partner_identity_id);
    if (!identity) throw new FrameworkAcceptanceError("PARTNER_IDENTITY_NOT_FOUND", 404);

    // Exact-parameter replay: same partner, same exact pair, already
    // accepted - idempotent no-op, no new writes of any kind.
    const existingAcceptance = db.prepare(`SELECT id FROM framework_acceptances
      WHERE partner_identity_id = ? AND framework_agreement_revision_id = ? AND delegation_template_revision_id = ?`)
      .get(partner.partner_identity_id, frameworkAgreementRevisionId, delegationTemplateRevisionId) as { id: string } | undefined;
    if (existingAcceptance) {
      const delegation = db.prepare("SELECT id FROM ord_reporting_delegations WHERE framework_acceptance_id = ?").get(existingAcceptance.id) as { id: string };
      return { framework_acceptance_id: existingAcceptance.id, ord_reporting_delegation_id: delegation.id, replayed: true };
    }

    // A different revision while already FRAMEWORK_ACCEPTED is NOT an
    // idempotent replay - refused outright, never silently treated as a
    // fresh acceptance (onboarding only accepts once).
    if (identity.onboarding_state === "FRAMEWORK_ACCEPTED" || identity.onboarding_state === "PARTNER_ACTIVE") {
      throw new FrameworkAcceptanceError("AGENT_REFERRALS_FRAMEWORK_ACCEPTANCE_REVISION_CHANGED", 409);
    }
    if (identity.onboarding_state !== "FRAMEWORK_ISSUED") {
      throw new FrameworkAcceptanceError("AGENT_REFERRALS_FRAMEWORK_NOT_ISSUED", 409, identity.onboarding_state);
    }

    consumeStepUpGrantInTransaction(db, partner, stepUpGrantId, "FRAMEWORK_ACCEPTANCE", {
      framework_agreement_revision_id: frameworkAgreementRevisionId,
      delegation_template_revision_id: delegationTemplateRevisionId,
    });

    const acceptanceId = id();
    db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, framework_agreement_revision_id, delegation_template_revision_id, step_up_grant_id)
      VALUES (?, ?, ?, ?, ?)`)
      .run(acceptanceId, partner.partner_identity_id, frameworkAgreementRevisionId, delegationTemplateRevisionId, stepUpGrantId);

    const delegationId = id();
    db.prepare(`INSERT INTO ord_reporting_delegations(id, partner_identity_id, framework_acceptance_id, delegation_template_revision_id, ord_reporting_mode)
      VALUES (?, ?, ?, ?, 'FLEXPERIMENT_DELEGATED')`)
      .run(delegationId, partner.partner_identity_id, acceptanceId, delegationTemplateRevisionId);

    recordPartnerIdentityEvent(db, partner.partner_identity_id, "FRAMEWORK_ACCEPTED", "PARTNER", {
      framework_acceptance_id: acceptanceId, ord_reporting_delegation_id: delegationId,
    });

    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES (?, 'AGENT_REFERRALS_FRAMEWORK_CONFIRMATION', ?, ?, 'agent-referrals-framework-confirmation', ?, ?)`)
      .run(id(), identity.email, identity.email_hash, JSON.stringify({ framework_acceptance_id: acceptanceId }), `agent-referrals-framework-confirmation:${acceptanceId}`);

    transitionOnboardingStateInTransaction(db, partner.partner_identity_id, "FRAMEWORK_ACCEPTED", identity.onboarding_revision, "PARTNER", "framework accepted");

    return { framework_acceptance_id: acceptanceId, ord_reporting_delegation_id: delegationId, replayed: false };
  });
  return run.immediate();
};
