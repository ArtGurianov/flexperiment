import type Database from "better-sqlite3";
import { id, now } from "./crypto";
import { getPartnerIdentity, recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { resolveCurrentLegalProfileBinding } from "./agent-referrals-legal-profile";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * PR-F: tax/VAT treatment authority. A SEPARATE temporal chain from the
 * legal-profile revision chain (PR-D/D2/PR-E) - WHO the contractor is
 * (legal_profile_revision) and HOW their income is taxed
 * (tax_treatment_revision) are two different facts that change on
 * different schedules and different authority. A legal-profile supersession
 * never carries a treatment forward; a treatment correction never implies a
 * legal-profile change. See 0053's own migration header for the full
 * rationale.
 *
 * Deliberately no general Russian tax engine and no income-threshold
 * inference: NPD is the one tax_system this module derives automatically
 * (atomically with the legal-profile mint that produced tax_mode=NPD,
 * see agent-referrals-legal-profile-supersession.ts's own hook). Every
 * other tax_system/vat_treatment tuple is an explicit, evidenced admin
 * assertion this module only proves internally consistent - never a
 * computed legal/business conclusion.
 */

export class TaxTreatmentError extends Error {
  constructor(readonly code: string, readonly status = 422, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type TaxSystem = "NPD" | "USN" | "AUSN" | "OSNO" | "PSN" | "ESHN" | "OTHER";
export type VatTreatment = "NO_VAT" | "VAT_5" | "VAT_7" | "VAT_22";
export type NoVatBasis = "NPD" | "AUSN" | "PSN" | "USN_EXEMPT" | "OTHER_CONFIRMED";
export type TaxTreatmentAssertionSource = "SYSTEM_DERIVED" | "ADMIN_ASSERTED";

export type TaxTreatmentRevisionRow = {
  id: string;
  partner_identity_id: string;
  legal_profile_revision_id: string;
  sequence: number;
  tax_system: TaxSystem;
  vat_treatment: VatTreatment;
  no_vat_basis: NoVatBasis | null;
  effective_from: string;
  assertion_source: TaxTreatmentAssertionSource;
  evidence_ref: string | null;
  reason: string;
  created_by_admin_id: string | null;
  created_at: string;
};

const COLUMNS = `id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, reason, created_by_admin_id, created_at`;

export const taxTreatmentRevisionById = (db: Database.Database, treatmentId: string): TaxTreatmentRevisionRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM agent_referrals_tax_treatment_revisions WHERE id = ?`).get(treatmentId) as TaxTreatmentRevisionRow | undefined) ?? null;

/**
 * The applicable tax treatment for an EXACT legal-profile revision, AS OF a
 * given instant - never simply MAX(sequence). A legal-profile revision that
 * has never had any treatment recorded against it (a fresh D2 supersession
 * still awaiting an explicit non-NPD assertion, say) resolves to null, not
 * an error - callers that require one (settlement preparation) raise their
 * own domain error naming the gap.
 */
export const resolveTaxTreatmentForLegalProfileAt = (db: Database.Database, legalProfileRevisionId: string, atInstant: string): TaxTreatmentRevisionRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM agent_referrals_tax_treatment_revisions
    WHERE legal_profile_revision_id = ? AND effective_from <= ?
    ORDER BY effective_from DESC, sequence DESC LIMIT 1`)
    .get(legalProfileRevisionId, atInstant) as TaxTreatmentRevisionRow | undefined) ?? null;

export const taxTreatmentRevisionsForLegalProfile = (db: Database.Database, legalProfileRevisionId: string): TaxTreatmentRevisionRow[] =>
  db.prepare(`SELECT ${COLUMNS} FROM agent_referrals_tax_treatment_revisions WHERE legal_profile_revision_id = ? ORDER BY effective_from ASC, sequence ASC`)
    .all(legalProfileRevisionId) as TaxTreatmentRevisionRow[];

/**
 * Application-level mirror of 0053's own tax_system x vat_treatment x
 * no_vat_basis CHECK - proven identical by a dedicated test, same
 * discipline as resolveProjectedContractorType's own role for the
 * legal_form x tax_mode matrix. A caller that skips this and lets the DB
 * CHECK reject the row instead gets a raw SqliteError (no `.status`), i.e.
 * an internal 500 for what is actually a 422.
 */
export const validateTaxTreatmentTuple = (taxSystem: TaxSystem, vatTreatment: VatTreatment, noVatBasis: NoVatBasis | null): void => {
  if (vatTreatment === "NO_VAT" && noVatBasis === null) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_REQUIRED", 422);
  if (vatTreatment !== "NO_VAT" && noVatBasis !== null) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_FORBIDDEN", 422, noVatBasis);

  // PSN (patent system) is its own branch, not grouped with OSNO/ESHN/OTHER
  // (review round 1, P1.4): it is always NO_VAT/PSN, never a real rate -
  // ФНС describes PSN as an individual-entrepreneur-only regime, and income
  // taxed under it is exempt from VAT with only narrow statutory exceptions
  // this schema does not model. The legal_form = INDIVIDUAL_ENTREPRENEUR
  // requirement is proven relationally (against the joined legal-profile
  // revision, which this pure function has no access to) - see
  // recordVerifiedTaxTreatment's own explicit check and 0053's relational-
  // consistency trigger, both named PSN_REQUIRES_INDIVIDUAL_ENTREPRENEUR /
  // AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT respectively.
  const valid =
    (taxSystem === "NPD" && vatTreatment === "NO_VAT" && noVatBasis === "NPD")
    || (taxSystem === "AUSN" && vatTreatment === "NO_VAT" && noVatBasis === "AUSN")
    || (taxSystem === "PSN" && vatTreatment === "NO_VAT" && noVatBasis === "PSN")
    || (taxSystem === "USN" && ((vatTreatment === "NO_VAT" && noVatBasis === "USN_EXEMPT") || vatTreatment === "VAT_5" || vatTreatment === "VAT_7" || vatTreatment === "VAT_22"))
    || ((taxSystem === "OSNO" || taxSystem === "ESHN" || taxSystem === "OTHER")
      && (vatTreatment === "VAT_22" || (vatTreatment === "NO_VAT" && noVatBasis === "OTHER_CONFIRMED")));
  if (!valid) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED", 422, `${taxSystem}/${vatTreatment}/${noVatBasis ?? "null"}`);
};

const EFFECTIVE_FROM_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * ONE canonical sortable format, never a caller-chosen string (review
 * round 1, P1.1) - mirrors 0053's own strftime()-based CHECK exactly: a UTC
 * instant, millisecond precision, always Z-suffixed (Date.prototype
 * .toISOString()'s own shape).
 *
 * Review round 2, P1: `new Date(raw)` alone is NOT a normalization - it is
 * JS's own calendar-rollover behavior (`new Date("2026-02-30")` silently
 * becomes March 2nd), which would let an admin's asserted business date
 * drift to a DIFFERENT date without any error. This is exactly the kind of
 * silent corruption 0053's own effective_from CHECK exists to catch at the
 * DB layer - the domain mirror must refuse it just as strictly, before a
 * transaction ever opens. Exactly two shapes are accepted, each proven by
 * an EXACT round-trip rather than "whatever Date can parse":
 *   - a bare "YYYY-MM-DD" calendar date (the one shape <input type="date">
 *     sends) - every component must survive a UTC round-trip unchanged, or
 *     the date never existed (Feb 30, Apr 31, ...) and is refused, never
 *     silently rolled forward;
 *   - an already-canonical instant, proven by `raw === new
 *     Date(raw).toISOString()` - accepted verbatim (never re-derived to a
 *     DIFFERENT instant), so mintSystemDerivedNpdTaxTreatment's own
 *     `now()` (already exactly this shape) passes through unchanged.
 * Every other shape (a non-canonical instant, an offset-bearing timestamp,
 * a loosely-parsed string) is refused with a typed 422 rather than
 * silently canonicalized to a different moment.
 */
export const normalizeTaxEffectiveFrom = (raw: string): string => {
  const dateOnly = EFFECTIVE_FROM_DATE_ONLY.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const year = Number(y), month = Number(m), day = Number(d);
    const asUtcMidnight = new Date(Date.UTC(year, month - 1, day));
    if (asUtcMidnight.getUTCFullYear() !== year || asUtcMidnight.getUTCMonth() !== month - 1 || asUtcMidnight.getUTCDate() !== day) {
      throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID", 422, raw);
    }
    return asUtcMidnight.toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== raw) {
    throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID", 422, raw);
  }
  return raw;
};

const nextSequenceForPartner = (db: Database.Database, partnerIdentityId: string): number =>
  ((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ?").get(partnerIdentityId) as { max: number }).max) + 1;

/**
 * The ONE sanctioned NPD mint path - called atomically from
 * applyVerifiedLegalProfileForPartnerIdentity (agent-referrals-legal-
 * profile-supersession.ts) whenever a legal profile is newly minted with
 * tax_mode=NPD, never called directly from an HTTP route. No evidence_ref,
 * no admin actor: NPD's VAT treatment is a matter of law (NPD payers are
 * not VAT payers for ordinary domestic partner-service income), not a
 * per-partner fact requiring separate proof.
 */
export const mintSystemDerivedNpdTaxTreatment = (
  db: Database.Database,
  partnerIdentityId: string,
  legalProfileRevisionId: string,
): TaxTreatmentRevisionRow => {
  const treatmentId = id();
  const sequence = nextSequenceForPartner(db, partnerIdentityId);
  db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions
      (id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, reason)
    VALUES (?, ?, ?, ?, 'NPD', 'NO_VAT', 'NPD', ?, 'SYSTEM_DERIVED', 'automatic NPD tax treatment, minted with the legal-profile revision')`)
    .run(treatmentId, partnerIdentityId, legalProfileRevisionId, sequence, normalizeTaxEffectiveFrom(now()));
  return taxTreatmentRevisionById(db, treatmentId)!;
};

export type RecordVerifiedTaxTreatmentInput = {
  taxSystem: TaxSystem;
  vatTreatment: VatTreatment;
  noVatBasis: NoVatBasis | null;
  effectiveFrom: string;
  evidenceRef: string;
  reason: string;
};

/**
 * The one admin command that records a NON-NPD tax treatment. Always
 * targets the partner's CURRENT legal-profile revision, resolved server-
 * side (resolveCurrentLegalProfileBinding, imported lazily below to avoid a
 * module cycle with agent-referrals-legal-profile-supersession.ts) - a
 * caller never supplies legal_profile_revision_id directly, so a stale or
 * foreign revision id can never even be represented at this boundary. No
 * partner-realm self-service path exists for this in PR-F (unlike D2's
 * legal-profile supersession candidate lifecycle): a VAT/tax-system fact is
 * financially significant enough that PR-F requires it always be an
 * explicit, evidenced ADMIN_ASSERTED fact.
 */
export const recordVerifiedTaxTreatment = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  input: RecordVerifiedTaxTreatmentInput,
): TaxTreatmentRevisionRow => {
  const run = db.transaction((): TaxTreatmentRevisionRow => {
    const identity = getPartnerIdentity(db, partnerIdentityId);
    if (!identity) throw new TaxTreatmentError("PARTNER_IDENTITY_NOT_FOUND", 404);

    if (input.taxSystem === "NPD") throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED", 422);
    const evidenceRef = input.evidenceRef?.trim();
    if (!evidenceRef) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_EVIDENCE_REF_REQUIRED", 422);
    const reason = input.reason?.trim();
    if (!reason) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_REASON_REQUIRED", 422);
    if (!input.effectiveFrom?.trim()) throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_REQUIRED", 422);
    const effectiveFrom = normalizeTaxEffectiveFrom(input.effectiveFrom);
    validateTaxTreatmentTuple(input.taxSystem, input.vatTreatment, input.noVatBasis);

    // Proves pointer == MAX first (the same coherence proof every other
    // legal-profile-consuming caller in this codebase relies on) - the
    // treatment is always minted against the CURRENT revision, never a
    // caller-named one. Resolved regardless of destroyed_at: destruction
    // never clears this pointer (agent-referrals-identity-retention.ts),
    // and the replay check right below needs it even for an identity
    // destroyed AFTER the original command it might be replaying.
    const currentLegalProfile = resolveCurrentLegalProfileBinding(db, identity);

    // Idempotent HTTP retry (review round 1, P2.2), made provenance-safe
    // and correctly ordered (review round 2, P1 x2):
    //
    // - Provenance-complete: compares EVERY persisted command fact - the
    //   tax tuple, effective_from, AND evidence_ref/reason/actor - not
    //   just tax semantics. A corrected evidence_ref or a different
    //   reason is a genuinely new assertion revision even when the
    //   tax_system/vat_treatment conclusion happens to be unchanged
    //   (review round 2 caught a test that had locked in the WRONG
    //   semantics here - two DIFFERENT evidence_ref/reason values were
    //   being silently collapsed into one row).
    // - Ordered BEFORE the suspension and destroyed-identity gates below,
    //   mirroring D2's own REPLAYED-before-NEW_AUTHORITY precedent: a
    //   retried POST that already succeeded once reflects authority that
    //   was already proven and consumed AT THE TIME of the original call.
    //   The feature suspending afterward, or this identity being
    //   destroyed afterward, must never turn that already-durable command
    //   into a failure on retry - only a GENUINELY NEW mutation (no
    //   matching row) is subject to either gate.
    const mostRecent = db.prepare(`SELECT ${COLUMNS} FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ? ORDER BY sequence DESC LIMIT 1`)
      .get(partnerIdentityId) as TaxTreatmentRevisionRow | undefined;
    if (mostRecent && mostRecent.legal_profile_revision_id === currentLegalProfile.id
      && mostRecent.tax_system === input.taxSystem && mostRecent.vat_treatment === input.vatTreatment && mostRecent.no_vat_basis === input.noVatBasis
      && mostRecent.effective_from === effectiveFrom
      && mostRecent.evidence_ref === evidenceRef && mostRecent.reason === reason && mostRecent.created_by_admin_id === admin.admin_id) {
      return mostRecent;
    }

    // Everything below only runs for a genuinely NEW mutation.
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "TAX_TREATMENT_VERIFICATION");
    if (identity.destroyed_at !== null) throw new TaxTreatmentError("PARTNER_IDENTITY_NOT_FOUND", 404);

    // NPD boundary (review round 2, new P1): the CURRENT legal profile
    // itself being NPD means its tax treatment is exclusively
    // SYSTEM_DERIVED (mintSystemDerivedNpdTaxTreatment) - an admin
    // asserting ANY tax_system here (even a structurally valid one, like
    // USN) for an NPD profile is not a real admin decision this module
    // ever sanctions. Without this, such a request passed every check
    // above and only failed at 0053's own relational-consistency trigger
    // ((lp.tax_mode = 'NPD') = (NEW.tax_system = 'NPD')) as a raw
    // SqliteError/500 instead of a typed 422.
    if (currentLegalProfile.tax_mode === "NPD") {
      throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED", 422);
    }

    // PSN (review round 1, P1.4): an individual-entrepreneur-only regime -
    // mirrors 0053's own relational-consistency trigger, checked here too
    // for a typed 422 instead of a raw SqliteError.
    if (input.taxSystem === "PSN" && currentLegalProfile.legal_form !== "INDIVIDUAL_ENTREPRENEUR") {
      throw new TaxTreatmentError("AGENT_REFERRALS_TAX_TREATMENT_PSN_REQUIRES_INDIVIDUAL_ENTREPRENEUR", 422, currentLegalProfile.legal_form);
    }

    const treatmentId = id();
    const sequence = nextSequenceForPartner(db, partnerIdentityId);
    db.prepare(`INSERT INTO agent_referrals_tax_treatment_revisions
        (id, partner_identity_id, legal_profile_revision_id, sequence, tax_system, vat_treatment, no_vat_basis, effective_from, assertion_source, evidence_ref, created_by_admin_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ADMIN_ASSERTED', ?, ?, ?)`)
      .run(treatmentId, partnerIdentityId, currentLegalProfile.id, sequence, input.taxSystem, input.vatTreatment, input.noVatBasis, effectiveFrom, evidenceRef, admin.admin_id, reason);

    recordPartnerIdentityEvent(db, partnerIdentityId, "TAX_TREATMENT_RECORDED", "ADMIN", {
      tax_treatment_id: treatmentId, legal_profile_revision_id: currentLegalProfile.id, tax_system: input.taxSystem, vat_treatment: input.vatTreatment, reason,
    });

    return taxTreatmentRevisionById(db, treatmentId)!;
  });
  return run.immediate();
};
