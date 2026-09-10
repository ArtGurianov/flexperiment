import { describe, expect, it } from "vitest";
import {
  canonicalizeOrdParticipantV1, canonicalizeSettlementTaxV1,
  ORD_PARTICIPANT_CANONICALIZATION_VERSION, SETTLEMENT_TAX_CANONICALIZATION_VERSION,
} from "../src/agent-referrals-ord-canonical";
import type { AgentReferralsLegalProfileRevision } from "../src/agent-referrals-legal-profile";
import type { TaxTreatmentRevisionRow } from "../src/agent-referrals-tax-treatment";

/**
 * PR-F: pure canonicalizer tests - no DB, no side effects. These prove the
 * shape/determinism/version-pinning contract agent-referrals-settlement.ts
 * and agent-referrals-ord-paid-invoice.ts both rely on for their own
 * immutable-snapshot discipline.
 */

const baseProfile: AgentReferralsLegalProfileRevision = {
  id: "lp-1", agent_id: "agent-1", revision: 1, legal_form: "INDIVIDUAL", tax_mode: "NPD", projected_contractor_type: "SELF_EMPLOYED",
  opf: null, full_name: "Ivanov Ivan Ivanovich", short_name: null, inn: "123456789012", kpp: null, registration_number: null, legal_address: null,
  supersedes_revision_id: null, reason: "seed", assertion_source: "PARTNER_ASSERTED", evidence_ref: null, created_at: "2026-01-01T00:00:00.000Z",
};

const legalEntityProfile: AgentReferralsLegalProfileRevision = {
  ...baseProfile, id: "lp-2", legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION",
  opf: "OOO", full_name: "Romashka LLC", short_name: "OOO Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
};

const ieProfile: AgentReferralsLegalProfileRevision = {
  ...baseProfile, id: "lp-3", legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR",
  registration_number: "123456789012345",
};

describe("canonicalizeOrdParticipantV1", () => {
  it("INDIVIDUAL -> NATURAL_PERSON with exactly full_name/inn, version pinned", () => {
    const result = canonicalizeOrdParticipantV1(baseProfile);
    expect(result.version).toBe(ORD_PARTICIPANT_CANONICALIZATION_VERSION);
    expect(result.value).toEqual({ version: "ORD_PARTICIPANT_V1", participant_kind: "NATURAL_PERSON", legal_form: "INDIVIDUAL", full_name: "Ivanov Ivan Ivanovich", inn: "123456789012" });
    expect(result.canonical_hash).toHaveLength(64);
  });

  it("INDIVIDUAL_ENTREPRENEUR -> includes registration_number, no opf/kpp/legal_address", () => {
    const result = canonicalizeOrdParticipantV1(ieProfile);
    expect(result.value).toEqual({
      version: "ORD_PARTICIPANT_V1", participant_kind: "INDIVIDUAL_ENTREPRENEUR", legal_form: "INDIVIDUAL_ENTREPRENEUR",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
  });

  it("LEGAL_ENTITY -> the full requisites tuple", () => {
    const result = canonicalizeOrdParticipantV1(legalEntityProfile);
    expect(result.value).toEqual({
      version: "ORD_PARTICIPANT_V1", participant_kind: "LEGAL_ENTITY", legal_form: "LEGAL_ENTITY",
      opf: "OOO", full_name: "Romashka LLC", short_name: "OOO Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    });
  });

  it("never includes tax_mode - the participant object answers WHO, never HOW they are taxed", () => {
    const result = canonicalizeOrdParticipantV1(baseProfile);
    expect(result.canonical_json).not.toContain("tax_mode");
    expect("tax_mode" in result.value).toBe(false);
  });

  it("is deterministic: the same profile canonicalizes to the exact same hash every time", () => {
    const a = canonicalizeOrdParticipantV1(legalEntityProfile);
    const b = canonicalizeOrdParticipantV1(legalEntityProfile);
    expect(a.canonical_hash).toBe(b.canonical_hash);
    expect(a.canonical_json).toBe(b.canonical_json);
  });

  it("a semantically different profile (different INN) produces a different hash", () => {
    const a = canonicalizeOrdParticipantV1(baseProfile);
    const b = canonicalizeOrdParticipantV1({ ...baseProfile, inn: "999999999999" });
    expect(a.canonical_hash).not.toBe(b.canonical_hash);
  });

  it("provenance fields (assertion_source, evidence_ref, reason, created_at, revision, id) never leak into the canonical value", () => {
    const result = canonicalizeOrdParticipantV1(baseProfile);
    for (const forbidden of ["assertion_source", "evidence_ref", "reason", "created_at", "revision", "supersedes_revision_id"]) {
      expect(result.canonical_json).not.toContain(forbidden);
    }
  });
});

const npdTreatment: TaxTreatmentRevisionRow = {
  id: "tt-1", partner_identity_id: "p1", legal_profile_revision_id: "lp-1", sequence: 1,
  tax_system: "NPD", vat_treatment: "NO_VAT", no_vat_basis: "NPD", effective_from: "2026-01-01",
  assertion_source: "SYSTEM_DERIVED", evidence_ref: null, reason: "auto", created_by_admin_id: null, created_at: "2026-01-01T00:00:00.000Z",
};

const usnTreatment: TaxTreatmentRevisionRow = {
  ...npdTreatment, id: "tt-2", legal_profile_revision_id: "lp-2", tax_system: "USN", vat_treatment: "VAT_5", no_vat_basis: null,
  assertion_source: "ADMIN_ASSERTED", evidence_ref: "ev.pdf", created_by_admin_id: "admin-1",
};

describe("canonicalizeSettlementTaxV1", () => {
  it("NPD treatment -> npd_receipt_required true", () => {
    const result = canonicalizeSettlementTaxV1(npdTreatment);
    expect(result.version).toBe(SETTLEMENT_TAX_CANONICALIZATION_VERSION);
    expect(result.value).toEqual({
      version: "SETTLEMENT_TAX_V1", legal_profile_revision_id: "lp-1", tax_treatment_revision_id: "tt-1",
      tax_system: "NPD", vat_treatment: "NO_VAT", no_vat_basis: "NPD", npd_receipt_required: true,
    });
  });

  it("non-NPD treatment -> npd_receipt_required false", () => {
    const result = canonicalizeSettlementTaxV1(usnTreatment);
    expect(result.value.npd_receipt_required).toBe(false);
    expect(result.value.tax_system).toBe("USN");
  });

  it("never leaks provenance (assertion_source/evidence_ref/reason/created_by_admin_id/created_at/sequence/partner_identity_id)", () => {
    const result = canonicalizeSettlementTaxV1(usnTreatment);
    for (const forbidden of ["assertion_source", "evidence_ref", "reason", "created_by_admin_id", "created_at", "sequence", "partner_identity_id"]) {
      expect(result.canonical_json).not.toContain(forbidden);
    }
  });

  it("is deterministic and content-sensitive, same as the participant canonicalizer", () => {
    const a = canonicalizeSettlementTaxV1(usnTreatment);
    const b = canonicalizeSettlementTaxV1(usnTreatment);
    expect(a.canonical_hash).toBe(b.canonical_hash);
    const c = canonicalizeSettlementTaxV1({ ...usnTreatment, vat_treatment: "VAT_22" });
    expect(a.canonical_hash).not.toBe(c.canonical_hash);
  });
});
