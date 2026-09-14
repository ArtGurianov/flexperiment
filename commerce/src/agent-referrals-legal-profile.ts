import type Database from "better-sqlite3";
import { id } from "./crypto";
import {
  INN_LENGTH, KPP_LENGTH, REGISTRATION_NUMBER_LENGTH, REQUISITE_FIELDS, REQUISITE_SHAPE,
  resolveProjectedContractorType as resolveProjectedContractorTypeRule,
  type LegalForm, type ProjectedContractorType, type TaxMode,
} from "../../lib/legal-profile-rules";

/**
 * Agent Referrals immutable legal-profile revisions are the sole legal
 * identity authority. Operational agents deliberately carry no mirrored
 * legal identity or writable contractor projection.
 *
 * The four allowed / two rejected legal_form x tax_mode combinations are
 * enforced twice: here, before any write, and structurally by the combined
 * CHECK constraint on agent_referrals_legal_profile_revisions in
 * 0043_agent_referrals_foundation.sql. A bypass of this function still
 * cannot write a rejected combination or a projection inconsistent with it.
 */

// PR-B: the shape itself lives in lib/legal-profile-rules.ts, the one
// representation the domain AND both React surfaces import (the DB's own
// CHECKs are the deliberate separate representation, held to it by
// agent-referrals-legal-profile-conformance.test.ts). Re-exported here so
// every existing `from "./agent-referrals-legal-profile"` import keeps
// working - this module remains the domain's front door for the concept.
export type { LegalForm, TaxMode, ProjectedContractorType };

/**
 * PARTNER_ASSERTED: the partner's own onboarding submission, verified by an
 * admin (verifyPartnerLegalProfile) - the only production mint path today.
 * ADMIN_ASSERTED: an admin acting on external evidence; not yet reachable
 * from any route. See 0050_agent_referrals_legal_profile_provenance_rebuild.sql.
 */
export type AssertionSource = "PARTNER_ASSERTED" | "ADMIN_ASSERTED";

/**
 * The one shared lookup every caller that will eventually reach the 0043
 * CHECK constraint must call FIRST, domain-side - not just
 * applyAgentReferralsLegalProfile's own mint path. Returns null for both a
 * legitimate-enum-but-rejected pairing (INDIVIDUAL+OTHER) and a value
 * outside the LegalForm/TaxMode union entirely (an unchecked `as LegalForm`
 * cast at an HTTP boundary, say) - plain object indexing doesn't
 * distinguish the two, and neither does a caller need to. A caller that
 * skips this and lets the DB CHECK reject the row instead gets a raw
 * SqliteError the global HTTP error handler does not recognize (no
 * `.status`), i.e. an internal 500 for what is actually a 422.
 */
export const resolveProjectedContractorType = (legalForm: LegalForm, taxMode: TaxMode): ProjectedContractorType | null =>
  resolveProjectedContractorTypeRule(legalForm, taxMode);

export class AgentReferralsLegalProfileError extends Error {
  constructor(readonly code: string, readonly status = 422, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * PR-E: the unified legal requisites tuple, every field an asserted fact -
 * never derived from another (full_name is never built from opf+short_name
 * or vice versa). TEXT throughout, including every identifier (inn/kpp/
 * registration_number): these are never arithmetic values, and a leading
 * zero is significant. Mirrors 0052's own per-legal_form shape/format CHECKs
 * exactly - see that migration for the authoritative matrix this type and
 * normalizeAndValidateLegalProfile below both reproduce.
 *
 * legal_address deliberately has no INDIVIDUAL/INDIVIDUAL_ENTREPRENEUR
 * counterpart in PR-E: collecting a natural person's address is real PII
 * with no concrete document/provider consumer yet, not schema symmetry for
 * its own sake.
 */
export type LegalRequisites = {
  opf: string | null;
  full_name: string;
  short_name: string | null;
  inn: string;
  kpp: string | null;
  registration_number: string | null;
  legal_address: string | null;
};

/** Every field optional/nullable at the input boundary - normalizeAndValidateLegalProfile is what proves the per-legal_form shape. */
export type RawLegalRequisitesInput = {
  opf?: string | null;
  full_name: string;
  short_name?: string | null;
  inn: string;
  kpp?: string | null;
  registration_number?: string | null;
  legal_address?: string | null;
};

const isBlank = (value: string): boolean => value.trim().length === 0;

/** "" (after trim) is never accepted as "provided" for an optional field - collapses to null, matching the DB CHECKs' own whitespace-aware trim() discipline. */
const normalizeOptional = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const requireDigits = (value: string, length: number, field: string, legalForm: LegalForm): void => {
  if (value.length !== length || !/^[0-9]+$/.test(value)) {
    throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_INVALID_FORMAT", 422, `${field} must be exactly ${length} digits for ${legalForm}`);
  }
};

/**
 * The one shared validator every caller that will eventually reach 0052's
 * CHECK constraints must call FIRST, domain-side - not just
 * applyAgentReferralsLegalProfile's own mint path (mirrors
 * resolveProjectedContractorType's own role for the legal_form x tax_mode
 * matrix, extended to the full requisites tuple). Normalizes (trims,
 * collapses blank-optional to null) AND validates in one pass, returning the
 * exact tuple ready for INSERT; throws AgentReferralsLegalProfileError
 * (422) naming the offending field on any violation. A caller that skips
 * this and lets the DB CHECK reject the row instead gets a raw SqliteError
 * the global HTTP error handler does not recognize (no `.status`), i.e. an
 * internal 500 for what is actually a 422 - the same hazard
 * resolveProjectedContractorType's own doc comment describes.
 */
export const normalizeAndValidateLegalProfile = (
  legalForm: LegalForm,
  taxMode: TaxMode,
  raw: RawLegalRequisitesInput,
): { projectedContractorType: ProjectedContractorType; requisites: LegalRequisites } => {
  const projectedContractorType = resolveProjectedContractorType(legalForm, taxMode);
  if (!projectedContractorType) {
    throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION", 422, `${legalForm}+${taxMode}`);
  }

  const fullName = raw.full_name.trim();
  if (isBlank(fullName)) throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_REQUIRED", 422, "full_name");
  const inn = raw.inn.trim();
  if (isBlank(inn)) throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_REQUIRED", 422, "inn");
  requireDigits(inn, INN_LENGTH[legalForm], "inn", legalForm);

  const shape = REQUISITE_SHAPE[legalForm];
  const normalized: Record<"opf" | "short_name" | "kpp" | "registration_number" | "legal_address", string | null> = {
    opf: normalizeOptional(raw.opf), short_name: normalizeOptional(raw.short_name), kpp: normalizeOptional(raw.kpp),
    registration_number: normalizeOptional(raw.registration_number), legal_address: normalizeOptional(raw.legal_address),
  };
  for (const field of REQUISITE_FIELDS) {
    const rule = shape[field];
    const value = normalized[field];
    if (rule === "REQUIRED" && value === null) {
      throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_REQUIRED", 422, field);
    }
    if (rule === "FORBIDDEN" && value !== null) {
      throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_REQUISITE_FORBIDDEN", 422, field);
    }
  }
  if (normalized.kpp !== null) requireDigits(normalized.kpp, KPP_LENGTH, "kpp", legalForm);
  if (normalized.registration_number !== null) {
    requireDigits(normalized.registration_number, REGISTRATION_NUMBER_LENGTH[legalForm]!, "registration_number", legalForm);
  }

  return {
    projectedContractorType,
    requisites: { opf: normalized.opf, full_name: fullName, short_name: normalized.short_name, inn, kpp: normalized.kpp, registration_number: normalized.registration_number, legal_address: normalized.legal_address },
  };
};

/**
 * Semantic identity equality for a legal profile: legal_form/tax_mode plus
 * the full requisites tuple, NEVER provenance (assertion_source,
 * evidence_ref, reason, created_by, timestamps, ids). Used both by
 * applyAgentReferralsLegalProfile's own idempotent-no-op check below and by
 * agent-referrals-legal-profile-supersession.ts's NO_CHANGE refusal - one
 * function, not duplicated per call site, so PR-E's requisites extension
 * only had to change this once. Provenance is deliberately excluded: a
 * re-proof of the exact same facts must never mint a new authority, even
 * under a different assertion_source/evidence_ref/reason - otherwise a
 * repeated submission could be used to artificially mint new legal
 * authority with nothing about the identity actually changed.
 */
export const canonicalLegalProfileEquals = (
  a: { legal_form: LegalForm; tax_mode: TaxMode } & LegalRequisites,
  b: { legal_form: LegalForm; tax_mode: TaxMode } & LegalRequisites,
): boolean =>
  a.legal_form === b.legal_form && a.tax_mode === b.tax_mode
  && a.opf === b.opf && a.full_name === b.full_name && a.short_name === b.short_name
  && a.inn === b.inn && a.kpp === b.kpp && a.registration_number === b.registration_number && a.legal_address === b.legal_address;

/**
 * PR2 of the reissuance/evidence program: classifies a legal-profile change
 * by its effect on the framework/delegation agreement contour, never by
 * whether it changed anything at all (canonicalLegalProfileEquals above
 * already answers that). The comparison is ALWAYS baseline-vs-current,
 * never adjacent-revision - see agreementStatusForPartner in
 * agent-referrals-framework-issuance.ts for why comparing adjacent
 * revisions is a silent bug here.
 *
 *   NOTICE_ONLY                      cosmetic/contact-detail fact, no
 *                                     reissuance, no reacceptance
 *   CONTRACTUAL_REISSUANCE_REQUIRED  same party, different contractual
 *                                     terms an admin must reissue over
 *   NEW_PARTNER_IDENTITY_REQUIRED    the INN changed - a different legal
 *                                     party, never representable as a
 *                                     revision of this one
 *   IDENTITY_INCONSISTENT            same INN, but a fact that cannot
 *                                     legitimately change for the same
 *                                     party under an unchanged INN
 *
 * The contracting party is identified by INN, stated directly rather than
 * inferred: crossing the natural-person/organization boundary always
 * changes the INN (12 digits vs 10 - see INN_LENGTH), so NEW_PARTNER_
 * IDENTITY_REQUIRED already covers that crossing without this classifier
 * depending on it - see the boundary test in
 * agent-referrals-legal-profile.test.ts.
 */
export type LegalProfileChangeEffect =
  | "NOTICE_ONLY"
  | "CONTRACTUAL_REISSUANCE_REQUIRED"
  | "IDENTITY_INCONSISTENT"
  | "NEW_PARTNER_IDENTITY_REQUIRED";

const LEGAL_PROFILE_CHANGE_EFFECT_SEVERITY: Readonly<Record<LegalProfileChangeEffect, number>> = {
  NOTICE_ONLY: 0,
  CONTRACTUAL_REISSUANCE_REQUIRED: 1,
  IDENTITY_INCONSISTENT: 2,
  NEW_PARTNER_IDENTITY_REQUIRED: 3,
};

export type ComparableLegalProfile = { legal_form: LegalForm; tax_mode: TaxMode; projected_contractor_type: ProjectedContractorType } & LegalRequisites;

/**
 * Exhaustive by construction: TypeScript enforces every field of
 * ComparableLegalProfile has an entry (AGENT_REFERRALS_OPERATION_POLICY's
 * own idiom, agent-referrals-suspension-policy.ts) - a new requisite field
 * does not compile in until someone decides its effect here.
 * registration_number's entry is the DEFAULT for its change; the
 * LEGAL_ENTITY/unchanged-INN exception is applied by
 * classifyLegalProfileChange below, never folded into this map.
 */
const LEGAL_PROFILE_FIELD_EFFECT: Readonly<Record<keyof ComparableLegalProfile, LegalProfileChangeEffect>> = {
  inn: "NEW_PARTNER_IDENTITY_REQUIRED",
  legal_form: "CONTRACTUAL_REISSUANCE_REQUIRED",
  tax_mode: "CONTRACTUAL_REISSUANCE_REQUIRED",
  projected_contractor_type: "CONTRACTUAL_REISSUANCE_REQUIRED",
  registration_number: "CONTRACTUAL_REISSUANCE_REQUIRED",
  opf: "CONTRACTUAL_REISSUANCE_REQUIRED",
  full_name: "NOTICE_ONLY",
  short_name: "NOTICE_ONLY",
  kpp: "NOTICE_ONLY",
  legal_address: "NOTICE_ONLY",
};

/**
 * baseline = what was actually accepted (or, at mint time, the profile
 * about to be superseded); current = the profile change under evaluation.
 * Returns the MOST SEVERE effect among every field that actually differs -
 * never the first match, never the last - so a change that touches both an
 * identity field and a notice-only field is never under-classified.
 */
export const classifyLegalProfileChange = (baseline: ComparableLegalProfile, current: ComparableLegalProfile): LegalProfileChangeEffect => {
  let worst: LegalProfileChangeEffect = "NOTICE_ONLY";
  const consider = (effect: LegalProfileChangeEffect) => {
    if (LEGAL_PROFILE_CHANGE_EFFECT_SEVERITY[effect] > LEGAL_PROFILE_CHANGE_EFFECT_SEVERITY[worst]) worst = effect;
  };

  for (const field of Object.keys(LEGAL_PROFILE_FIELD_EFFECT) as (keyof ComparableLegalProfile)[]) {
    if (field === "registration_number") continue; // exception handled below
    if (baseline[field] !== current[field]) consider(LEGAL_PROFILE_FIELD_EFFECT[field]);
  }

  if (baseline.registration_number !== current.registration_number) {
    // ОГРНИП is reassigned when an ИП deregisters and re-registers - same
    // person, same INN, new registration fact the document names, so
    // reissuance rather than a notice. For a LEGAL_ENTITY both ОГРН and ИНН
    // are permanent, so the same INN with a different ОГРН is not a
    // legitimate same-party transition.
    if (baseline.legal_form === "LEGAL_ENTITY" && current.legal_form === "LEGAL_ENTITY" && baseline.inn === current.inn) {
      consider("IDENTITY_INCONSISTENT");
    } else {
      consider("CONTRACTUAL_REISSUANCE_REQUIRED");
    }
  }

  return worst;
};

export type AgentReferralsLegalProfileRevision = {
  id: string;
  agent_id: string;
  revision: number;
  legal_form: LegalForm;
  tax_mode: TaxMode;
  projected_contractor_type: ProjectedContractorType;
  opf: string | null;
  full_name: string;
  short_name: string | null;
  inn: string;
  kpp: string | null;
  registration_number: string | null;
  legal_address: string | null;
  supersedes_revision_id: string | null;
  reason: string;
  assertion_source: AssertionSource;
  evidence_ref: string | null;
  created_at: string;
};

const REVISION_COLUMNS = "id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, short_name, inn, kpp, registration_number, legal_address, supersedes_revision_id, reason, assertion_source, evidence_ref, created_at";

/** The latest (and only meaningful) revision for an agent - never a stored pointer. See the migration's comment for why. */
export const currentAgentReferralsLegalProfile = (db: Database.Database, agentId: string): AgentReferralsLegalProfileRevision | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS}
    FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY revision DESC LIMIT 1`).get(agentId) as
    AgentReferralsLegalProfileRevision | undefined) ?? null;

export const allAgentReferralsLegalProfileRevisions = (db: Database.Database, agentId: string): AgentReferralsLegalProfileRevision[] =>
  db.prepare(`SELECT ${REVISION_COLUMNS}
    FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY revision ASC`).all(agentId) as AgentReferralsLegalProfileRevision[];

/** A single revision by its own id, independent of whether it is anyone's current one - resolveActivatedLegalProfileBinding's own reader. */
export const agentReferralsLegalProfileRevisionById = (db: Database.Database, revisionId: string): AgentReferralsLegalProfileRevision | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM agent_referrals_legal_profile_revisions WHERE id = ?`)
    .get(revisionId) as AgentReferralsLegalProfileRevision | undefined) ?? null;

/**
 * MAX(revision) is the sole semantic authority; partner_identities.legal_
 * profile_revision_id is a redundant, checked projection of it (the D2
 * plan's three-level-authority model). No caller may compare anything
 * against the pointer directly - every caller that needs "the current
 * profile" goes through here, which proves pointer == MAX first and
 * returns MAX, never the pointer's own row read independently.
 *
 * Two legal pre-states exist for (MAX, pointer): both null (no profile
 * minted yet) or both naming the same row. Any other combination -
 * including "MAX exists but pointer is null/different" - is
 * POINTER_DIVERGED, a structural defect this never silently repairs.
 */
export const resolveCurrentLegalProfileBinding = (
  db: Database.Database,
  partnerIdentity: { agent_id: string; legal_profile_revision_id: string | null },
): AgentReferralsLegalProfileRevision => {
  const current = currentAgentReferralsLegalProfile(db, partnerIdentity.agent_id);
  if (!current || partnerIdentity.legal_profile_revision_id !== current.id) {
    throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED", 500, partnerIdentity.legal_profile_revision_id ?? "null");
  }
  return current;
};

export type ApplyAgentReferralsLegalProfileInput = RawLegalRequisitesInput & {
  agent_id: string;
  legal_form: LegalForm;
  tax_mode: TaxMode;
  reason: string;
  assertion_source: AssertionSource;
  /** Optional for PARTNER_ASSERTED; required (and non-blank) for ADMIN_ASSERTED - enforced both here and by the table's own CHECK. */
  evidence_ref?: string | null;
};

export type ApplyAgentReferralsLegalProfileResult = {
  revision_id: string;
  revision: number;
  projected_contractor_type: ProjectedContractorType;
  minted: boolean;
};

/**
 * Atomic: insert the new revision if the semantic profile actually changed.
 * The rejected-combination check happens BEFORE the transaction opens, so a
 * rejection leaves no partial evidence of any kind.
 */
export const applyAgentReferralsLegalProfile = (
  db: Database.Database,
  input: ApplyAgentReferralsLegalProfileInput,
): ApplyAgentReferralsLegalProfileResult => {
  const { projectedContractorType: projected, requisites } = normalizeAndValidateLegalProfile(input.legal_form, input.tax_mode, input);
  // Mirrors the table's own CHECK (assertion_source = 'PARTNER_ASSERTED' OR
  // (assertion_source = 'ADMIN_ASSERTED' AND evidence_ref IS NOT NULL)) as an
  // application-level error before any transaction opens, same as the
  // requisites validation above - the DB CHECK remains the structural
  // backstop, this is only for a caller-legible error.
  if (input.assertion_source === "ADMIN_ASSERTED" && !input.evidence_ref?.trim()) {
    throw new AgentReferralsLegalProfileError("AGENT_REFERRALS_LEGAL_PROFILE_EVIDENCE_REF_REQUIRED", 422, input.assertion_source);
  }
  const evidenceRef = input.evidence_ref?.trim() || null;

  const run = db.transaction((): ApplyAgentReferralsLegalProfileResult => {
    const current = currentAgentReferralsLegalProfile(db, input.agent_id);

    // Same semantic profile as already current: idempotent no-op, mints no
    // new revision. The existing revision's own provenance is kept -
    // immutable evidence is never rewritten by a later resubmission, even
    // one asserted from a different source.
    if (current && canonicalLegalProfileEquals(current, { legal_form: input.legal_form, tax_mode: input.tax_mode, ...requisites })) {
      return { revision_id: current.id, revision: current.revision, projected_contractor_type: current.projected_contractor_type, minted: false };
    }

    // Fail-closed on party change: this is the sole mint path (initial
    // onboarding verification and every later supersession verify() both
    // funnel through here), so this is the one place that can refuse a
    // revision the framework/delegation agreement contour could never
    // legitimately represent as a continuation of the same party.
    if (current) {
      const effect = classifyLegalProfileChange(
        current,
        { legal_form: input.legal_form, tax_mode: input.tax_mode, projected_contractor_type: projected, ...requisites },
      );
      if (effect === "NEW_PARTNER_IDENTITY_REQUIRED") {
        throw new AgentReferralsLegalProfileError("LEGAL_PROFILE_PARTY_CHANGE_REQUIRES_NEW_IDENTITY", 422, `${current.inn}->${requisites.inn}`);
      }
      if (effect === "IDENTITY_INCONSISTENT") {
        throw new AgentReferralsLegalProfileError("LEGAL_PROFILE_IDENTITY_INCONSISTENT", 422, `${current.registration_number ?? "null"}->${requisites.registration_number ?? "null"}`);
      }
    }

    const nextRevision = (current?.revision ?? 0) + 1;
    const revisionId = id();
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, short_name, inn, kpp, registration_number, legal_address, supersedes_revision_id, reason, assertion_source, evidence_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, input.agent_id, nextRevision, input.legal_form, input.tax_mode, projected,
        requisites.opf, requisites.full_name, requisites.short_name, requisites.inn, requisites.kpp, requisites.registration_number, requisites.legal_address,
        current?.id ?? null, input.reason, input.assertion_source, evidenceRef);

    return { revision_id: revisionId, revision: nextRevision, projected_contractor_type: projected, minted: true };
  });
  return run.immediate();
};
