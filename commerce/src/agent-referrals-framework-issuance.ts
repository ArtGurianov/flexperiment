import type Database from "better-sqlite3";
import { classifyLegalProfileChange, currentAgentReferralsLegalProfile, agentReferralsLegalProfileRevisionById } from "./agent-referrals-legal-profile";

/**
 * PR2 of the reissuance/evidence program: the resolvers every caller that
 * needs "the required issuance" or "the effective acceptance" for a
 * partner must go through - never a bare, unqualified lookup by
 * partner_identity_id alone (the schema's original single-row-per-partner shape
 * made that safe; it no longer is).
 *
 * Resolution is derived, never a stored pointer, exactly PR3's own
 * MAX(revision) idiom for agent_referrals_legal_profile_revisions:
 *
 *   required issuance    = MAX(sequence) in framework_issuances for the partner
 *   effective acceptance = framework_acceptances JOIN framework_issuances
 *                             ON issuance.id = acceptance.issuance_id
 *                           ORDER BY issuance.sequence DESC LIMIT 1
 *
 * UNIQUE(partner_identity_id, issuance_id) on framework_acceptances is what
 * makes ordering acceptances by their issuance's sequence a total order -
 * there is exactly one ordinal in this subsystem, on the offer stream.
 */

export type FrameworkIssuanceRow = {
  id: string;
  partner_identity_id: string;
  sequence: number;
  framework_agreement_revision_id: string;
  delegation_template_revision_id: string;
  issued_by_admin_id: string;
  reason: string;
  issued_at: string;
};

const ISSUANCE_COLUMNS = "id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason, issued_at";

/** The latest (and only meaningful) issuance for a partner - never a stored pointer. Null for a partner never issued anything. */
export const requiredFrameworkIssuance = (db: Database.Database, partnerIdentityId: string): FrameworkIssuanceRow | null =>
  (db.prepare(`SELECT ${ISSUANCE_COLUMNS} FROM framework_issuances WHERE partner_identity_id = ? ORDER BY sequence DESC LIMIT 1`)
.get(partnerIdentityId) as FrameworkIssuanceRow | undefined) ?? null;

export const frameworkIssuanceById = (db: Database.Database, issuanceId: string): FrameworkIssuanceRow | null =>
  (db.prepare(`SELECT ${ISSUANCE_COLUMNS} FROM framework_issuances WHERE id = ?`).get(issuanceId) as FrameworkIssuanceRow | undefined) ?? null;

export const allFrameworkIssuancesForPartner = (db: Database.Database, partnerIdentityId: string): FrameworkIssuanceRow[] =>
  db.prepare(`SELECT ${ISSUANCE_COLUMNS} FROM framework_issuances WHERE partner_identity_id = ? ORDER BY sequence ASC`).all(partnerIdentityId) as FrameworkIssuanceRow[];

export type FrameworkAcceptanceRow = {
  id: string;
  partner_identity_id: string;
  issuance_id: string;
  legal_profile_revision_id: string;
  step_up_grant_id: string;
  created_at: string;
};

export type EffectiveFrameworkAcceptance = { readonly acceptance: FrameworkAcceptanceRow; readonly issuance: FrameworkIssuanceRow };

/**
 * The effective acceptance: the accepted issuance with the HIGHEST
 * sequence, never "any" acceptance and never the first one found. This is
 * the fix for the historical defect at engagement.ts:387 - an unqualified
 * `SELECT id FROM framework_acceptances WHERE partner_identity_id = ?`
 * picked an arbitrary row once a second acceptance became possible.
 */
export const effectiveFrameworkAcceptance = (db: Database.Database, partnerIdentityId: string): EffectiveFrameworkAcceptance | null => {
  const row = db.prepare(`SELECT
      fa.id AS a_id, fa.partner_identity_id AS a_partner_identity_id, fa.issuance_id AS a_issuance_id,
      fa.legal_profile_revision_id AS a_legal_profile_revision_id, fa.step_up_grant_id AS a_step_up_grant_id, fa.created_at AS a_created_at,
      fi.id AS i_id, fi.partner_identity_id AS i_partner_identity_id, fi.sequence AS i_sequence,
      fi.framework_agreement_revision_id AS i_framework_agreement_revision_id, fi.delegation_template_revision_id AS i_delegation_template_revision_id,
      fi.issued_by_admin_id AS i_issued_by_admin_id, fi.reason AS i_reason, fi.issued_at AS i_issued_at
    FROM framework_acceptances fa
    JOIN framework_issuances fi ON fi.id = fa.issuance_id
    WHERE fa.partner_identity_id = ?
    ORDER BY fi.sequence DESC LIMIT 1`).get(partnerIdentityId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    acceptance: {
      id: row.a_id as string, partner_identity_id: row.a_partner_identity_id as string, issuance_id: row.a_issuance_id as string,
      legal_profile_revision_id: row.a_legal_profile_revision_id as string, step_up_grant_id: row.a_step_up_grant_id as string, created_at: row.a_created_at as string,
    },
    issuance: {
      id: row.i_id as string, partner_identity_id: row.i_partner_identity_id as string, sequence: row.i_sequence as number,
      framework_agreement_revision_id: row.i_framework_agreement_revision_id as string, delegation_template_revision_id: row.i_delegation_template_revision_id as string,
      issued_by_admin_id: row.i_issued_by_admin_id as string, reason: row.i_reason as string, issued_at: row.i_issued_at as string,
    },
  };
};

export const frameworkAcceptanceByPartnerAndIssuance = (db: Database.Database, partnerIdentityId: string, issuanceId: string): FrameworkAcceptanceRow | null =>
  (db.prepare(`SELECT id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id, created_at
    FROM framework_acceptances WHERE partner_identity_id = ? AND issuance_id = ?`)
.get(partnerIdentityId, issuanceId) as FrameworkAcceptanceRow | undefined) ?? null;

export type AgreementStatus = "NOT_ISSUED" | "INITIAL_ACCEPTANCE_REQUIRED" | "CURRENT" | "REISSUANCE_REQUIRED" | "REACCEPTANCE_REQUIRED";

/**
 * The allowlist engagement activation reads (agreement_status === "CURRENT",
 * nothing else - a denylist of the two intermediate states would leave a
 * future sixth status, or a projection bug, able to silently re-open
 * activation).
 *
 * Order matters and is part of the contract: an explicit new offer
 * (REACCEPTANCE_REQUIRED) is checked BEFORE the profile classifier, so an
 * immutable admin act (issuing a new revision) can never be undone by a
 * partner-side profile edit that happens to restore old semantics -
 * MAX(sequence) stays the whole authority over the offer stream.
 *
 * The profile baseline is the EFFECTIVE ACCEPTANCE's own pinned revision,
 * never the previous revision - the question is "does the current
 * contractual identity differ from what was actually accepted", not "what
 * changed in the last change request" (comparing adjacent revisions would
 * silently under-report: accept rev7 -> rev8 changes tax_mode -> rev9
 * changes only the address would read as NOTICE_ONLY against rev8 and
 * wrongly report CURRENT).
 */
export const agreementStatusForPartner = (db: Database.Database, agentId: string, partnerIdentityId: string): AgreementStatus => {
  const required = requiredFrameworkIssuance(db, partnerIdentityId);
  if (!required) return "NOT_ISSUED";

  const effective = effectiveFrameworkAcceptance(db, partnerIdentityId);
  if (!effective) return "INITIAL_ACCEPTANCE_REQUIRED";

  if (required.sequence > effective.issuance.sequence) return "REACCEPTANCE_REQUIRED";

  const acceptedProfile = agentReferralsLegalProfileRevisionById(db, effective.acceptance.legal_profile_revision_id);
  const currentProfile = currentAgentReferralsLegalProfile(db, agentId);
  // Structural defect if reached: an effective acceptance always names a
  // real legal-profile revision it was pinned against, and a partner that
  // has one has a MAX by construction.
  if (!acceptedProfile || !currentProfile) throw new Error("AGENT_REFERRALS_AGREEMENT_STATUS_LEGAL_PROFILE_MISSING");

  const effect = classifyLegalProfileChange(acceptedProfile, currentProfile);
  switch (effect) {
    case "NOTICE_ONLY":
      return "CURRENT";
    case "CONTRACTUAL_REISSUANCE_REQUIRED":
      return "REISSUANCE_REQUIRED";
    // applyAgentReferralsLegalProfile rejects both before persistence. If
    // corruption or a future writer nevertheless makes either visible here,
    // this resolver is activation authority and must never fail open to
    // CURRENT.
    case "NEW_PARTNER_IDENTITY_REQUIRED":
    case "IDENTITY_INCONSISTENT":
      throw new Error(`AGENT_REFERRALS_AGREEMENT_STATUS_IDENTITY_INVALID:${effect}`);
  }
};
