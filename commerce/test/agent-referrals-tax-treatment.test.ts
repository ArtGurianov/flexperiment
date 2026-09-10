import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { suspendAgentReferrals, agentReferralsFeatureState, activateAgentReferrals } from "../src/agent-referrals-feature-state";
import {
  mintSystemDerivedNpdTaxTreatment, recordVerifiedTaxTreatment, resolveTaxTreatmentForLegalProfileAt, taxTreatmentRevisionsForLegalProfile,
  validateTaxTreatmentTuple, TaxTreatmentError,
} from "../src/agent-referrals-tax-treatment";
import { submitLegalProfileSupersession, verifyLegalProfileSupersession } from "../src/agent-referrals-legal-profile-supersession";
import { currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";
import { destroyPartnerIdentity, mintRetentionPolicyRevision } from "../src/agent-referrals-identity-retention";
import { fresh, admin, readyPartner } from "./support/agent-referrals-settlement-fixtures";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/**
 * PR-F: tax/VAT treatment authority. A SEPARATE temporal chain from the
 * legal-profile revision chain - see agent-referrals-tax-treatment.ts's own
 * header for the full rationale. These tests exercise the domain layer
 * directly (resolution, the admin command, the atomic NPD hook); DB-level
 * matrix/relational/immutability enforcement is proven independently in
 * agent-referrals-tax-treatment-ord-canonicalization-migration.test.ts.
 */

describe("agent-referrals tax treatment", () => {
  describe("automatic NPD mint (atomic with the legal-profile mint)", () => {
    it("readyPartner(NPD) already has a SYSTEM_DERIVED NPD tax treatment for its one legal-profile revision", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      const treatment = resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, new Date().toISOString());
      expect(treatment).toMatchObject({ tax_system: "NPD", vat_treatment: "NO_VAT", no_vat_basis: "NPD", assertion_source: "SYSTEM_DERIVED", evidence_ref: null, created_by_admin_id: null });
    });

    it("mintSystemDerivedNpdTaxTreatment is idempotent-shaped: each call mints its own sequence, never reused across legal-profile revisions", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      const before = taxTreatmentRevisionsForLegalProfile(db, legalProfile.id);
      expect(before).toHaveLength(1);
      // A second direct mint for the SAME revision is a distinct row
      // (never deduplicated at this layer) - the atomic hook itself only
      // calls this once per genuine mint (gated on `result.minted`), so
      // this white-box call proves the function's own shape, not a
      // sanctioned double-mint scenario.
      mintSystemDerivedNpdTaxTreatment(db, p1.partnerIdentityId, legalProfile.id);
      const after = taxTreatmentRevisionsForLegalProfile(db, legalProfile.id);
      expect(after).toHaveLength(2);
      expect(after[1].sequence).toBe(before[0].sequence + 1);
    });

    it("D2 supersession to LEGAL_ENTITY/OTHER never auto-mints a treatment for the new revision - it starts with zero treatment rows of its own", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      const outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
      expect(outcome).toMatchObject({ outcome: "VERIFIED" });
      const newLegalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      expect(newLegalProfile.legal_form).toBe("LEGAL_ENTITY");
      expect(taxTreatmentRevisionsForLegalProfile(db, newLegalProfile.id)).toEqual([]);
      expect(resolveTaxTreatmentForLegalProfileAt(db, newLegalProfile.id, new Date().toISOString())).toBeNull();
    });
  });

  describe("resolveTaxTreatmentForLegalProfileAt: temporal resolution", () => {
    it("resolves the latest treatment whose effective_from <= the given instant, never simply MAX(sequence)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      // Supersede to LEGAL_ENTITY/OTHER so this legal profile can carry
      // ADMIN_ASSERTED, temporally-distinct treatments.
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      verifyLegalProfileSupersession(db, admin, request.id, "verify");
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;

      const t1 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev1.pdf", reason: "exempt from Jan",
      });
      const t2 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-07-01", evidenceRef: "ev2.pdf", reason: "5% from Jul",
      });

      expect(resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, "2026-06-30T23:59:59.000Z")?.id).toBe(t1.id);
      expect(resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, "2026-07-01T00:00:00.000Z")?.id).toBe(t2.id);
      expect(resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, "2027-01-01T00:00:00.000Z")?.id).toBe(t2.id);
      expect(resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, "2020-01-01T00:00:00.000Z")).toBeNull();
    });
  });

  describe("validateTaxTreatmentTuple: application-level mirror of the DB matrix CHECK", () => {
    it("accepts every matrix-legal tuple the migration test also proves at the DB layer", () => {
      expect(() => validateTaxTreatmentTuple("NPD", "NO_VAT", "NPD")).not.toThrow();
      expect(() => validateTaxTreatmentTuple("AUSN", "NO_VAT", "AUSN")).not.toThrow();
      expect(() => validateTaxTreatmentTuple("USN", "NO_VAT", "USN_EXEMPT")).not.toThrow();
      for (const vat of ["VAT_5", "VAT_7", "VAT_22"] as const) expect(() => validateTaxTreatmentTuple("USN", vat, null)).not.toThrow();
      for (const sys of ["OSNO", "PSN", "ESHN", "OTHER"] as const) {
        expect(() => validateTaxTreatmentTuple(sys, "VAT_22", null)).not.toThrow();
        expect(() => validateTaxTreatmentTuple(sys, "NO_VAT", "OTHER_CONFIRMED")).not.toThrow();
      }
    });

    it("rejects a rejected tuple with the matrix-rejected code", () => {
      expect(() => validateTaxTreatmentTuple("OSNO", "VAT_5", null)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED/);
    });

    it("rejects NO_VAT with a missing basis, and a real rate with a present basis", () => {
      expect(() => validateTaxTreatmentTuple("USN", "NO_VAT", null)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_REQUIRED/);
      expect(() => validateTaxTreatmentTuple("USN", "VAT_5", "USN_EXEMPT")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_FORBIDDEN/);
    });
  });

  describe("recordVerifiedTaxTreatment: the one admin command for non-NPD facts", () => {
    it("refuses NPD as the asserted tax_system - NPD is SYSTEM_DERIVED only, never a caller-asserted fact", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "NPD", vatTreatment: "NO_VAT", noVatBasis: "NPD", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      })).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED/);
    });

    it("refuses a blank evidence_ref, a blank reason, and a blank effective_from", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const base = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, evidenceRef: "   " })).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EVIDENCE_REF_REQUIRED/);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, reason: "" })).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REASON_REQUIRED/);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, effectiveFrom: "" })).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_REQUIRED/);
    });

    it("refuses an invalid tuple as a typed 422 before any INSERT, mirroring validateTaxTreatmentTuple", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "OSNO", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      })).toThrow(TaxTreatmentError);
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      expect(taxTreatmentRevisionsForLegalProfile(db, legalProfile.id)).toHaveLength(1); // only readyPartner's own fixture treatment, no partial row
    });

    it("refuses for a destroyed identity, and refuses under SUSPENDED (TAX_TREATMENT_VERIFICATION is NEW_AUTHORITY)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      mintRetentionPolicyRevision(db, admin, "policy");
      destroyPartnerIdentity(db, admin, p1.partnerIdentityId, "erasure");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      })).toThrow(/PARTNER_IDENTITY_NOT_FOUND/);

      const { db: db2 } = fresh(); open.push(db2);
      const p2 = readyPartner(db2, "OTHER");
      suspendAgentReferrals(db2, { expected_revision: agentReferralsFeatureState(db2).revision, owner_id: "test-owner", reason: "suspend" });
      expect(() => recordVerifiedTaxTreatment(db2, admin, p2.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      })).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
    });

    it("always targets the CURRENT legal-profile revision, resolved server-side - never a stale one held from before a supersession", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const oldLegalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      verifyLegalProfileSupersession(db, admin, request.id, "verify");
      const newLegalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      expect(newLegalProfile.id).not.toBe(oldLegalProfile.id);

      const treatment = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "usn exempt",
      });
      expect(treatment.legal_profile_revision_id).toBe(newLegalProfile.id);
      expect(treatment.legal_profile_revision_id).not.toBe(oldLegalProfile.id);
    });

    it("sequence is append-only per partner, incrementing across every new treatment regardless of which legal-profile revision it names", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      verifyLegalProfileSupersession(db, admin, request.id, "verify");

      const t1 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev1.pdf", reason: "x",
      });
      const t2 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-07-01", evidenceRef: "ev2.pdf", reason: "y",
      });
      // sequence 1 was already consumed by readyPartner's own automatic NPD mint on the ORIGINAL revision.
      expect(t1.sequence).toBe(2);
      expect(t2.sequence).toBe(3);
    });
  });
});
