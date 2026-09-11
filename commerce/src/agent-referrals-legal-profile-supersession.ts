import type Database from "better-sqlite3";
import { requireObservedVersion } from "./agent-referrals-command-precondition";
import { id } from "./crypto";
import {
  agentReferralsLegalProfileRevisionById, applyAgentReferralsLegalProfile, canonicalLegalProfileEquals, currentAgentReferralsLegalProfile,
  normalizeAndValidateLegalProfile, resolveCurrentLegalProfileBinding,
  type ApplyAgentReferralsLegalProfileResult, type AssertionSource, type LegalForm, type LegalRequisites, type RawLegalRequisitesInput, type TaxMode,
} from "./agent-referrals-legal-profile";
import { getPartnerIdentity, recordPartnerIdentityEvent, type PartnerIdentityRow } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { engagementsForPartner, type EngagementRow } from "./agent-referrals-engagement";
import { currentEffectiveRewardSnapshot } from "./agent-referrals-reward-registry";
import { zeroRewardClosureForEngagement } from "./agent-referrals-zero-reward-closure";
import { settlementForEffectiveSnapshot, recoveryExposureEvidenceForEngagement } from "./agent-referrals-settlement";
import { mintSystemDerivedNpdTaxTreatment } from "./agent-referrals-tax-treatment";
// Type-only: erased at compile time, so this never becomes a runtime import
// edge back to agent-referrals-partner-identity.ts, which itself imports
// applyVerifiedLegalProfileForPartnerIdentity (a VALUE) from this module -
// a real value-level cycle in the other direction would be a problem, a
// type-only one in this direction is not.
import type { AdminPrincipal, PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * PR-D2: legal-profile supersession & binding semantics. Builds on the
 * PR-D foundation (0050's assertion_source/evidence_ref) and the immutable
 * revision chain (0043) to make a post-onboarding change of legal identity
 * an achievable, atomic operation between engagement epochs - never a live
 * substitution of contractor inside one engagement.
 *
 * Three levels of authority, never confused:
 *   current verified profile = MAX(revision)         the ONLY semantic authority
 *   partner_identity pointer = redundant checked projection of it
 *   activation pin            = immutable historical binding, never replayed
 */

export class AgentReferralsLegalProfileSupersessionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// ---------------------------------------------------------------------------
// §4: the one atomic operation that ever moves the pointer, shared by the
// original onboarding verification (verifyPartnerLegalProfile,
// agent-referrals-partner-identity.ts) and this module's own verify().
// ---------------------------------------------------------------------------

export type ApplyVerifiedLegalProfileForPartnerIdentityInput = RawLegalRequisitesInput & {
  partnerIdentityId: string;
  legalForm: LegalForm;
  taxMode: TaxMode;
  assertionSource: AssertionSource;
  evidenceRef?: string | null;
  reason: string;
};

/**
 * Precondition -> mint (+ legacy contractor_type projection, via
 * applyAgentReferralsLegalProfile) -> pointer UPDATE -> postcondition, all
 * one transaction. The precondition admits exactly two legal pre-states:
 * first-ever verification (MAX and pointer both null) or an already-
 * coherent pointer (== MAX) about to be superseded. Any other combination
 * is POINTER_DIVERGED and this never repairs it by writing over it - the
 * caller must investigate, never silently proceed.
 *
 * agentId is deliberately NOT part of the input: it is derived exclusively
 * from the loaded partnerIdentityId row, never accepted as a second,
 * independently-supplied identifier - a caller passing a mismatched
 * (partnerIdentityId, agentId) pair would otherwise mint a real revision
 * for one agent while pointing a DIFFERENT identity's pointer at it, and
 * the postcondition below re-reads the ACTUAL identity row (not a
 * synthetic { agent_id, legal_profile_revision_id } object built from the
 * caller's own inputs) specifically so that class of corruption cannot
 * pass unnoticed.
 */
export const applyVerifiedLegalProfileForPartnerIdentity = (
  db: Database.Database,
  input: ApplyVerifiedLegalProfileForPartnerIdentityInput,
): ApplyAgentReferralsLegalProfileResult => {
  const run = db.transaction((): ApplyAgentReferralsLegalProfileResult => {
    const identity = getPartnerIdentity(db, input.partnerIdentityId);
    if (!identity) throw new AgentReferralsLegalProfileSupersessionError("PARTNER_IDENTITY_NOT_FOUND", 404);
    const agentId = identity.agent_id;
    const current = currentAgentReferralsLegalProfile(db, agentId);

    const preconditionOk = (current === null && identity.legal_profile_revision_id === null)
      || (current !== null && identity.legal_profile_revision_id === current.id);
    if (!preconditionOk) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED", 500, input.partnerIdentityId);

    const result = applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: input.legalForm, tax_mode: input.taxMode,
      reason: input.reason, assertion_source: input.assertionSource, evidence_ref: input.evidenceRef,
      opf: input.opf, full_name: input.full_name, short_name: input.short_name, inn: input.inn,
      kpp: input.kpp, registration_number: input.registration_number, legal_address: input.legal_address,
    });

    // PR-F: a legal profile freshly minted with tax_mode=NPD gets its NPD
    // tax treatment atomically, in the SAME transaction - never a separate
    // admin action. Only on an actual mint (never the idempotent same-
    // semantic-profile no-op path, which reuses the EXISTING revision and
    // therefore already has whatever treatment it already had), and only
    // for NPD - any other tax_mode leaves this revision with zero treatment
    // rows until an explicit admin-asserted one is recorded, by design.
    if (result.minted && input.taxMode === "NPD") {
      mintSystemDerivedNpdTaxTreatment(db, input.partnerIdentityId, result.revision_id);
    }

    db.prepare(`UPDATE partner_identities SET legal_profile_revision_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(result.revision_id, input.partnerIdentityId);

    // Postcondition proves the REAL identity row, re-read fresh (never the
    // caller's own inputs echoed back) - the same coherence proof every
    // other caller of resolveCurrentLegalProfileBinding relies on.
    const updatedIdentity = getPartnerIdentity(db, input.partnerIdentityId)!;
    resolveCurrentLegalProfileBinding(db, updatedIdentity);

    return result;
  });
  return run.immediate();
};

// ---------------------------------------------------------------------------
// §3: blocking predicate - "does this partner have an unclosed obligation
// under the CURRENT legal identity". Order is part of the contract: first
// match wins, exhaustive default is BLOCK.
// ---------------------------------------------------------------------------

export type SupersessionBindingReason =
  | "ENGAGEMENT_NOT_CLOSED"
  | "OUTSTANDING_SETTLEMENT"
  | "POSITIVE_EFFECTIVE_UNSETTLED"
  | "UNCLASSIFIED"
  | "CURRENT_SETTLEMENT_SETTLED"
  | "ZERO_REWARD_CLOSED"
  | "RECOVERY_EXPOSURE"
  | "ZERO_EFFECTIVE"
  | "NO_ENGAGEMENT";

export type SupersessionBindingDecision =
  | { blocked: true; reason: "ENGAGEMENT_NOT_CLOSED" | "OUTSTANDING_SETTLEMENT" | "POSITIVE_EFFECTIVE_UNSETTLED" | "UNCLASSIFIED"; engagementId: string }
  | { blocked: false; reason: "CURRENT_SETTLEMENT_SETTLED" | "ZERO_REWARD_CLOSED" | "RECOVERY_EXPOSURE" | "ZERO_EFFECTIVE" | "NO_ENGAGEMENT" };

/**
 * §3, per engagement. Terminality is proven by the CURRENT effective
 * snapshot only - "was ever paid" is deliberately not a branch here (У5):
 * a post-payment RECOVERY_EXPOSURE correction mints a new E with no
 * settlement of its own by design (agent-referrals-settlement.ts never
 * mints one after MADE), so a naive "no settlement for current E => block"
 * rule would make every engagement that was ever corrected after payment
 * permanently unsupersedable. Recovery-exposure evidence pinned to the
 * CURRENT E is instead its own terminal outcome, on equal footing with a
 * zero-reward closure.
 */
const classifyEngagementForSupersession = (db: Database.Database, engagement: EngagementRow): SupersessionBindingDecision => {
  if (engagement.lifecycle_state !== "CLOSED") return { blocked: true, reason: "ENGAGEMENT_NOT_CLOSED", engagementId: engagement.id };

  // Any settlement still PREPARED or PENDING_DOCUMENT - engagement-scoped,
  // not "for the current E" - is an unfinished monetary or documentary
  // obligation under the identity about to be superseded, historical E or
  // not. PENDING_DOCUMENT is closable (recordNpdReceipt moves it to
  // SETTLED); it is a named political decision to block here, not an
  // oversight.
  const outstanding = db.prepare(`SELECT 1 FROM reward_settlements WHERE settlement_flow = 'AGENT_REFERRALS' AND engagement_id = ? AND status IN ('PREPARED', 'PENDING_DOCUMENT') LIMIT 1`)
    .get(engagement.id);
  if (outstanding) return { blocked: true, reason: "OUTSTANDING_SETTLEMENT", engagementId: engagement.id };

  const currentEffective = currentEffectiveRewardSnapshot(db, engagement.id);

  if (currentEffective) {
    const settlement = settlementForEffectiveSnapshot(db, currentEffective.id);
    if (settlement?.status === "SETTLED") return { blocked: false, reason: "CURRENT_SETTLEMENT_SETTLED" };
  }

  if (zeroRewardClosureForEngagement(db, engagement.id)) return { blocked: false, reason: "ZERO_REWARD_CLOSED" };

  if (currentEffective) {
    const hasRecoveryExposureForCurrent = recoveryExposureEvidenceForEngagement(db, engagement.id)
      .some((evidence) => evidence.effective_reward_snapshot_id === currentEffective.id);
    if (hasRecoveryExposureForCurrent) return { blocked: false, reason: "RECOVERY_EXPOSURE" };
  }

  // A CLOSED engagement with NO current E at all is not "nothing owed" -
  // the only sanctioned path to CLOSED (closeEngagementWithRewardRegistry)
  // requires resolveRewardRegistryFinalization to already report the
  // reward registry finalized, and finalizeEngagementRewardRegistry mints
  // R and E1 atomically in the same transaction (closeEngagementZeroReward
  // likewise requires both to already exist and never touches
  // lifecycle_state at all). "CLOSED, zero settlements, no zero-reward
  // closure, no E whatsoever" is therefore evidence corruption, never a
  // legitimate zero - it fails closed via the exhaustive default, not the
  // ALLOW branch below.
  if (!currentEffective) return { blocked: true, reason: "UNCLASSIFIED", engagementId: engagement.id };

  if (currentEffective.reward_total_kopecks === 0) return { blocked: false, reason: "ZERO_EFFECTIVE" };

  if (currentEffective.reward_total_kopecks > 0) return { blocked: true, reason: "POSITIVE_EFFECTIVE_UNSETTLED", engagementId: engagement.id };

  return { blocked: true, reason: "UNCLASSIFIED", engagementId: engagement.id };
};

/**
 * Partner-level aggregation: ANY blocking engagement blocks the whole
 * partner, first one found (short-circuit, no need to classify the rest).
 * A partner with zero engagements, or every engagement independently
 * terminal, is allowed.
 *
 * PR-B: "no engagements at all" reports NO_ENGAGEMENT, not ZERO_EFFECTIVE.
 * The two are different facts - ZERO_EFFECTIVE means an engagement exists
 * and its CURRENT effective snapshot is worth zero, which is a proven
 * terminal outcome; NO_ENGAGEMENT means there was never anything to prove.
 * Reporting the former for the latter made the decision's own reason field
 * (which is part of the tested contract, and the thing an operator or a log
 * reads to understand WHY a supersession was allowed) claim evidence that
 * does not exist.
 */
export const supersessionBindingDecision = (db: Database.Database, partnerIdentityId: string): SupersessionBindingDecision => {
  const engagements = engagementsForPartner(db, partnerIdentityId);
  let lastAllow: SupersessionBindingDecision = { blocked: false, reason: "NO_ENGAGEMENT" };
  for (const engagement of engagements) {
    const decision = classifyEngagementForSupersession(db, engagement);
    if (decision.blocked) return decision;
    lastAllow = decision;
  }
  return lastAllow;
};

// ---------------------------------------------------------------------------
// §1/§2: the candidate row and its lifecycle - submit / verify / reject.
// ---------------------------------------------------------------------------

export type LegalProfileChangeRequestState = "PENDING" | "VERIFIED" | "REJECTED" | "STALE";

export type LegalProfileChangeRequestRow = LegalRequisites & {
  id: string;
  partner_identity_id: string;
  legal_form: LegalForm;
  tax_mode: TaxMode;
  assertion_source: AssertionSource;
  evidence_ref: string | null;
  reason: string;
  supersedes_revision_id: string;
  created_by: string;
  created_at: string;
  state: LegalProfileChangeRequestState;
  resolved_legal_profile_revision_id: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_reason: string | null;
};

const CHANGE_REQUEST_COLUMNS = `id, partner_identity_id, legal_form, tax_mode, opf, full_name, short_name, inn, kpp, registration_number, legal_address, assertion_source, evidence_ref, reason, supersedes_revision_id, created_by, created_at,
  state, resolved_legal_profile_revision_id, resolved_at, resolved_by, resolution_reason`;

export const legalProfileChangeRequestById = (db: Database.Database, requestId: string): LegalProfileChangeRequestRow | null =>
  (db.prepare(`SELECT ${CHANGE_REQUEST_COLUMNS} FROM agent_referrals_legal_profile_change_requests WHERE id = ?`)
    .get(requestId) as LegalProfileChangeRequestRow | undefined) ?? null;

export const pendingLegalProfileChangeRequestForPartner = (db: Database.Database, partnerIdentityId: string): LegalProfileChangeRequestRow | null =>
  (db.prepare(`SELECT ${CHANGE_REQUEST_COLUMNS} FROM agent_referrals_legal_profile_change_requests WHERE partner_identity_id = ? AND state = 'PENDING'`)
    .get(partnerIdentityId) as LegalProfileChangeRequestRow | undefined) ?? null;

/**
 * The revision NUMBER a supersession must be authored against - the same MAX
 * the command itself pins, exposed so a caller can send back exactly what it
 * saw. 0 only for an identity with no verified profile at all, which
 * supersession refuses anyway.
 */
export const currentLegalProfileRevisionForPartner = (db: Database.Database, partnerIdentityId: string): number => {
  const identity = getPartnerIdentity(db, partnerIdentityId);
  if (!identity) return 0;
  return currentAgentReferralsLegalProfile(db, identity.agent_id)?.revision ?? 0;
};

/** §9: relational authorization for admin routes carrying both :id and :requestId - matches ownedEngagement's exact shape (agent-referrals-partner-projection.ts). Knowing requestId alone is never authority. */
export const ownedLegalProfileChangeRequest = (db: Database.Database, partnerIdentityId: string, requestId: string): LegalProfileChangeRequestRow => {
  const request = legalProfileChangeRequestById(db, requestId);
  if (!request) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_NOT_FOUND", 404, requestId);
  if (request.partner_identity_id !== partnerIdentityId) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_WRONG_PARTNER", 403, requestId);
  return request;
};

const eligibleForSupersession = (identity: PartnerIdentityRow): boolean =>
  identity.onboarding_state === "PARTNER_ACTIVE" && identity.destroyed_at === null;

export type SubmitLegalProfileSupersessionInput = RawLegalRequisitesInput & {
  legalForm: LegalForm;
  taxMode: TaxMode;
  reason: string;
  evidenceRef?: string | null;
  /**
   * PR-C2 STALE_BOUND: the legal-profile REVISION NUMBER the caller was
   * changing from. The number rather than the id deliberately - it is
   * monotone per agent, it is already in both realms' read models, and
   * §B-11's partner projection does not expose internal revision ids.
   */
  expectedCurrentLegalProfileRevision: number;
};

/**
 * §2: assertion_source and created_by are derived from the principal's own
 * realm, never accepted from the request body - partner-realm is always
 * PARTNER_ASSERTED (created_by = the partner's own identity), admin-realm
 * is always ADMIN_ASSERTED (created_by = the admin). supersedes_revision_id
 * is MAX at the instant of INSERT, inside this same transaction.
 */
export const submitLegalProfileSupersession = (
  db: Database.Database,
  principal: AdminPrincipal | PartnerPrincipal,
  partnerIdentityId: string,
  input: SubmitLegalProfileSupersessionInput,
): LegalProfileChangeRequestRow => {
  const run = db.transaction((): LegalProfileChangeRequestRow => {
    // Filing evidence is permitted even while SUSPENDED (§2б) - it fixes a
    // fact, it does not create authority.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "LEGAL_PROFILE_CHANGE_SUBMISSION");

    const identity = getPartnerIdentity(db, partnerIdentityId);
    if (!identity) throw new AgentReferralsLegalProfileSupersessionError("PARTNER_IDENTITY_NOT_FOUND", 404);
    // A partner-realm principal is only ever authority for its OWN
    // identity - never a caller-supplied target another partner's session
    // could point at someone else. 404, not 403, matching
    // revokeDelegationAsPartner's own precedent (agent-referrals-
    // delegation-revocation.ts): a mismatch is indistinguishable from the
    // target simply not existing, never confirming a foreign identity's
    // existence to a caller with no authority over it.
    if (principal.realm === "PARTNER" && principal.partner_identity_id !== identity.id) {
      throw new AgentReferralsLegalProfileSupersessionError("PARTNER_IDENTITY_NOT_FOUND", 404);
    }
    if (!eligibleForSupersession(identity)) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INELIGIBLE_IDENTITY", 409, identity.onboarding_state);
    }

    // Domain validation, not just DB admissibility: a rejected combination,
    // an out-of-union (legal_form, tax_mode) pairing, or a requisites tuple
    // that does not match the per-legal_form shape must resolve to a typed
    // 422 here, before the INSERT - not surface as an unhandled SqliteError
    // (no `.status`) that the global HTTP error handler falls through to
    // INTERNAL_ERROR/500 for. Same shared validator applyAgentReferralsLegalProfile
    // itself uses, so this can never drift from what the mint path actually
    // accepts.
    const { requisites } = normalizeAndValidateLegalProfile(input.legalForm, input.taxMode, input);

    const current = resolveCurrentLegalProfileBinding(db, identity);
    // PR-C2 STALE_BOUND. supersedes_revision_id is derived from MAX below,
    // which on its own makes a retry DANGEROUS rather than safe: after the
    // request A created is verified, MAX has moved, the ALREADY_PENDING
    // slot is free again, and a retried A files a SECOND request - against
    // the profile its own first attempt produced. Naming the profile the
    // caller was changing FROM is what refuses that, and it is also the
    // truthful shape of the command: a supersession is always "replace
    // THIS identity", never "replace whatever is current when you read it".
    requireObservedVersion("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_STALE", input.expectedCurrentLegalProfileRevision, current.revision);
    if (canonicalLegalProfileEquals({ legal_form: input.legalForm, tax_mode: input.taxMode, ...requisites }, current)) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_NO_CHANGE", 409, partnerIdentityId);
    }

    const assertionSource: AssertionSource = principal.realm === "ADMIN" ? "ADMIN_ASSERTED" : "PARTNER_ASSERTED";
    // For PARTNER, derived from the proven identity row, not re-trusted
    // from principal a second time - identical in value now that the
    // equality above is proven, but never a second independent read of it.
    const createdBy = principal.realm === "ADMIN" ? principal.admin_id : identity.id;
    const evidenceRef = input.evidenceRef?.trim() || null;
    if (assertionSource === "ADMIN_ASSERTED" && !evidenceRef) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_EVIDENCE_REF_REQUIRED", 422, assertionSource);
    }

    // Pre-check for a legible error; the partial unique index below is the
    // real structural backstop a genuine race still hits.
    if (pendingLegalProfileChangeRequestForPartner(db, partnerIdentityId)) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_ALREADY_PENDING", 409, partnerIdentityId);
    }

    const requestId = id();
    try {
      db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests(id, partner_identity_id, legal_form, tax_mode, opf, full_name, short_name, inn, kpp, registration_number, legal_address, assertion_source, evidence_ref, reason, supersedes_revision_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(requestId, partnerIdentityId, input.legalForm, input.taxMode,
          requisites.opf, requisites.full_name, requisites.short_name, requisites.inn, requisites.kpp, requisites.registration_number, requisites.legal_address,
          assertionSource, evidenceRef, input.reason, current.id, createdBy);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: agent_referrals_legal_profile_change_requests\.partner_identity_id/.test(error.message)) {
        throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_ALREADY_PENDING", 409, partnerIdentityId);
      }
      throw error;
    }

    recordPartnerIdentityEvent(
      db, partnerIdentityId,
      principal.realm === "ADMIN" ? "LEGAL_PROFILE_CHANGE_ASSERTED_BY_ADMIN" : "LEGAL_PROFILE_CHANGE_ASSERTED_BY_PARTNER",
      principal.realm,
      { request_id: requestId, legal_form: input.legalForm, tax_mode: input.taxMode, reason: input.reason },
    );

    return legalProfileChangeRequestById(db, requestId)!;
  });
  return run.immediate();
};

export const rejectLegalProfileSupersession = (
  db: Database.Database,
  admin: AdminPrincipal,
  requestId: string,
  reason: string,
): LegalProfileChangeRequestRow => {
  const run = db.transaction((): LegalProfileChangeRequestRow => {
    // Cleanup of already-filed evidence is permitted even while SUSPENDED
    // (§2б) - rejecting mints no authority.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "LEGAL_PROFILE_CHANGE_REJECTION");

    const request = legalProfileChangeRequestById(db, requestId);
    if (!request) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_NOT_FOUND", 404, requestId);
    if (request.state !== "PENDING") throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INVALID_STATE", 409, request.state);

    const changed = db.prepare(`UPDATE agent_referrals_legal_profile_change_requests
      SET state = 'REJECTED', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_reason = ?
      WHERE id = ? AND state = 'PENDING'`).run(admin.admin_id, reason, requestId);
    if (changed.changes !== 1) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INVALID_STATE", 409, requestId);

    recordPartnerIdentityEvent(db, request.partner_identity_id, "LEGAL_PROFILE_CHANGE_REJECTED", "ADMIN", { request_id: requestId, reason });
    return legalProfileChangeRequestById(db, requestId)!;
  });
  return run.immediate();
};

export type VerifyLegalProfileSupersessionOutcome =
  | { outcome: "VERIFIED"; revision_id: string; revision: number }
  | { outcome: "REPLAYED"; revision_id: string; revision: number }
  | { outcome: "STALE"; expected: string; actual: string }
  | { outcome: "BLOCKED"; reason: SupersessionBindingReason }
  | { outcome: "INVALID_STATE"; state: LegalProfileChangeRequestState };

/**
 * Terminal states resolve BEFORE any gate, eligibility re-check or
 * pointer-precondition - a replay of an already-completed command is not
 * new authority, so it must not retroactively become a 409 because the
 * feature suspended or the identity was destroyed AFTER the original
 * success. Precedent: acceptEngagement finds an existing
 * engagement_acceptances row and returns replayed:true before ever calling
 * assertAgentReferralsOperationPermitted (agent-referrals-engagement.ts).
 *
 * STALE is committed, never thrown: throwing would roll back the very
 * fact this branch exists to record, and leave the request PENDING forever
 * (occupying the partial-unique-index slot) since nothing else ever moves
 * it out of PENDING for this request again.
 */
export const verifyLegalProfileSupersession = (
  db: Database.Database,
  admin: AdminPrincipal,
  requestId: string,
  reason: string,
): VerifyLegalProfileSupersessionOutcome => {
  const run = db.transaction((): VerifyLegalProfileSupersessionOutcome => {
    const request = legalProfileChangeRequestById(db, requestId);
    if (!request) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_NOT_FOUND", 404, requestId);

    if (request.state === "VERIFIED") {
      const revision = agentReferralsLegalProfileRevisionById(db, request.resolved_legal_profile_revision_id!);
      if (!revision) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED", 500, requestId);
      return { outcome: "REPLAYED", revision_id: revision.id, revision: revision.revision };
    }
    if (request.state === "REJECTED" || request.state === "STALE") {
      return { outcome: "INVALID_STATE", state: request.state };
    }

    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "LEGAL_PROFILE_CHANGE_VERIFICATION");

    const identity = getPartnerIdentity(db, request.partner_identity_id);
    if (!identity) throw new AgentReferralsLegalProfileSupersessionError("PARTNER_IDENTITY_NOT_FOUND", 404, request.partner_identity_id);
    // Re-checked, not merely trusted from submit time: the identity could
    // have been destroyed, or (structurally impossible today, but never
    // assumed) lost PARTNER_ACTIVE, in the interval between submit and verify.
    if (!eligibleForSupersession(identity)) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_INELIGIBLE_IDENTITY", 409, identity.onboarding_state);
    }

    // Precondition: pointer == MAX, proven fresh under the write lock -
    // POINTER_DIVERGED here is a genuine defect and rolls back rather than
    // silently repairing the pointer.
    const current = resolveCurrentLegalProfileBinding(db, identity);

    if (request.supersedes_revision_id !== current.id) {
      db.prepare(`UPDATE agent_referrals_legal_profile_change_requests
        SET state = 'STALE', resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_reason = ?
        WHERE id = ? AND state = 'PENDING'`)
        .run(admin.admin_id, `expected supersedes_revision_id ${request.supersedes_revision_id}, current is ${current.id}`, requestId);
      recordPartnerIdentityEvent(db, identity.id, "LEGAL_PROFILE_CHANGE_STALE", "ADMIN", {
        request_id: requestId, expected_supersedes_revision_id: request.supersedes_revision_id, actual_current_revision_id: current.id,
      });
      return { outcome: "STALE", expected: request.supersedes_revision_id, actual: current.id };
    }

    // Re-derived, not merely trusted from submit time (state may have
    // changed between the two) - same rationale as the eligibility recheck.
    if (canonicalLegalProfileEquals(request, current)) {
      throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_NO_CHANGE", 409, requestId);
    }

    const decision = supersessionBindingDecision(db, identity.id);
    if (decision.blocked) return { outcome: "BLOCKED", reason: decision.reason };

    const result = applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId: identity.id,
      legalForm: request.legal_form, taxMode: request.tax_mode,
      assertionSource: request.assertion_source, evidenceRef: request.evidence_ref, reason,
      opf: request.opf, full_name: request.full_name, short_name: request.short_name, inn: request.inn,
      kpp: request.kpp, registration_number: request.registration_number, legal_address: request.legal_address,
    });

    const changed = db.prepare(`UPDATE agent_referrals_legal_profile_change_requests
      SET state = 'VERIFIED', resolved_legal_profile_revision_id = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
      WHERE id = ? AND state = 'PENDING'`).run(result.revision_id, admin.admin_id, requestId);
    if (changed.changes !== 1) throw new AgentReferralsLegalProfileSupersessionError("AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_CONFLICT", 409, requestId);

    recordPartnerIdentityEvent(db, identity.id, "LEGAL_PROFILE_CHANGE_VERIFIED", "ADMIN", { request_id: requestId, legal_profile_revision_id: result.revision_id, reason });

    return { outcome: "VERIFIED", revision_id: result.revision_id, revision: result.revision };
  });
  return run.immediate();
};
