import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { suspendAgentReferrals, agentReferralsFeatureState } from "../src/agent-referrals-feature-state";
import {
  mintSystemDerivedNpdTaxTreatment, recordVerifiedTaxTreatment, resolveTaxTreatmentForLegalProfileAt, taxTreatmentRevisionsForLegalProfile,
  validateTaxTreatmentTuple, normalizeTaxEffectiveFrom, TaxTreatmentError,
} from "../src/agent-referrals-tax-treatment";
import { submitLegalProfileSupersession, verifyLegalProfileSupersession } from "../src/agent-referrals-legal-profile-supersession";
import { currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";
import { destroyPartnerIdentity, mintRetentionPolicyRevision } from "../src/agent-referrals-identity-retention";
import { fresh, admin, readyPartner } from "./support/agent-referrals-settlement-fixtures";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** A fresh, valid Idempotency-Key for a call that isn't itself testing idempotency semantics. */
const freshKey = () => randomUUID();

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

    it("mintSystemDerivedNpdTaxTreatment refuses a second SYSTEM_DERIVED mint for the same legal-profile revision (P2.1 unique index)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      const before = taxTreatmentRevisionsForLegalProfile(db, legalProfile.id);
      expect(before).toHaveLength(1);
      // The atomic hook only calls this once per genuine mint (gated on
      // `result.minted`); this white-box call proves the DB-level
      // uniqueness constraint actually rejects a duplicate mint attempt
      // rather than silently accumulating extra authority rows for the
      // same legal-profile revision.
      expect(() => mintSystemDerivedNpdTaxTreatment(db, p1.partnerIdentityId, legalProfile.id)).toThrow(/UNIQUE constraint failed/);
      const after = taxTreatmentRevisionsForLegalProfile(db, legalProfile.id);
      expect(after).toHaveLength(1);
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
      }, freshKey());
      const t2 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-07-01", evidenceRef: "ev2.pdf", reason: "5% from Jul",
      }, freshKey());

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
      expect(() => validateTaxTreatmentTuple("PSN", "NO_VAT", "PSN")).not.toThrow();
      expect(() => validateTaxTreatmentTuple("USN", "NO_VAT", "USN_EXEMPT")).not.toThrow();
      for (const vat of ["VAT_5", "VAT_7", "VAT_22"] as const) expect(() => validateTaxTreatmentTuple("USN", vat, null)).not.toThrow();
      for (const sys of ["OSNO", "ESHN", "OTHER"] as const) {
        expect(() => validateTaxTreatmentTuple(sys, "VAT_22", null)).not.toThrow();
        expect(() => validateTaxTreatmentTuple(sys, "NO_VAT", "OTHER_CONFIRMED")).not.toThrow();
      }
    });

    it("PSN is always NO_VAT/PSN, never groupable with OSNO/ESHN/OTHER (P1.4)", () => {
      expect(() => validateTaxTreatmentTuple("PSN", "VAT_22", null)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED/);
      expect(() => validateTaxTreatmentTuple("PSN", "NO_VAT", "OTHER_CONFIRMED")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED/);
    });

    it("rejects a rejected tuple with the matrix-rejected code", () => {
      expect(() => validateTaxTreatmentTuple("OSNO", "VAT_5", null)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_MATRIX_REJECTED/);
    });

    it("rejects NO_VAT with a missing basis, and a real rate with a present basis", () => {
      expect(() => validateTaxTreatmentTuple("USN", "NO_VAT", null)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_REQUIRED/);
      expect(() => validateTaxTreatmentTuple("USN", "VAT_5", "USN_EXEMPT")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NO_VAT_BASIS_FORBIDDEN/);
    });
  });

  describe("normalizeTaxEffectiveFrom: strict grammar, never a silent calendar-rollover rewrite (review round 2, P1)", () => {
    it("accepts a bare YYYY-MM-DD calendar date, normalized to UTC midnight", () => {
      expect(normalizeTaxEffectiveFrom("2026-01-01")).toBe("2026-01-01T00:00:00.000Z");
      expect(normalizeTaxEffectiveFrom("2026-12-31")).toBe("2026-12-31T00:00:00.000Z");
      expect(normalizeTaxEffectiveFrom("2024-02-29")).toBe("2024-02-29T00:00:00.000Z"); // genuine leap day
    });

    it("accepts an already-canonical instant unchanged (never re-derives a DIFFERENT moment)", () => {
      expect(normalizeTaxEffectiveFrom("2026-01-01T12:34:56.789Z")).toBe("2026-01-01T12:34:56.789Z");
    });

    it("rejects a calendar date that never existed, rather than silently rolling it over to a DIFFERENT date", () => {
      // new Date("2026-02-30") would otherwise silently become March 2nd -
      // exactly the asserted-date corruption this grammar exists to catch.
      expect(() => normalizeTaxEffectiveFrom("2026-02-30")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID/);
      expect(() => normalizeTaxEffectiveFrom("2026-04-31")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID/);
      expect(() => normalizeTaxEffectiveFrom("2023-02-29")).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID/); // not a leap year
    });

    it.each(["2026-1-01", "zzz", "2026/07/01", "2026-07-01+03:00", "2026-01-01T00:00:00Z", "2026-01-01 00:00:00"])(
      "rejects every other non-canonical shape %s, never coercing it to a nearby instant",
      (raw) => {
        expect(() => normalizeTaxEffectiveFrom(raw)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID/);
      },
    );
  });

  describe("recordVerifiedTaxTreatment: the one admin command for non-NPD facts", () => {
    it("refuses NPD as the asserted tax_system - NPD is SYSTEM_DERIVED only, never a caller-asserted fact", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "NPD", vatTreatment: "NO_VAT", noVatBasis: "NPD", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED/);
    });

    it("refuses a blank evidence_ref, a blank reason, and a blank effective_from", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const base = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, evidenceRef: "   " }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EVIDENCE_REF_REQUIRED/);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, reason: "" }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REASON_REQUIRED/);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, { ...base, effectiveFrom: "" }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_REQUIRED/);
    });

    it("refuses an invalid tuple as a typed 422 before any INSERT, mirroring validateTaxTreatmentTuple", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "OSNO", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(TaxTreatmentError);
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
      }, freshKey())).toThrow(/PARTNER_IDENTITY_NOT_FOUND/);

      const { db: db2 } = fresh(); open.push(db2);
      const p2 = readyPartner(db2, "OTHER");
      suspendAgentReferrals(db2, { expected_revision: agentReferralsFeatureState(db2).revision, owner_id: "test-owner", reason: "suspend" });
      expect(() => recordVerifiedTaxTreatment(db2, admin, p2.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
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
      }, freshKey());
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
      }, freshKey());
      const t2 = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "VAT_5", noVatBasis: null, effectiveFrom: "2026-07-01", evidenceRef: "ev2.pdf", reason: "y",
      }, freshKey());
      // sequence 1 was already consumed by readyPartner's own automatic NPD mint on the ORIGINAL revision.
      expect(t1.sequence).toBe(2);
      expect(t2.sequence).toBe(3);
    });

    it("refuses PSN for a legal profile whose legal_form is not INDIVIDUAL_ENTREPRENEUR (P1.4)", () => {
      const { db } = fresh(); open.push(db);
      // readyPartner("NPD") is legal_form INDIVIDUAL/tax_mode NPD - the NEW
      // NPD-boundary check (review round 2) would fire first and mask this
      // one, so this needs a non-IE, non-NPD profile: supersede to
      // LEGAL_ENTITY/OTHER.
      const p1 = readyPartner(db, "NPD");
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      verifyLegalProfileSupersession(db, admin, request.id, "verify");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "PSN", vatTreatment: "NO_VAT", noVatBasis: "PSN", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_PSN_REQUIRES_INDIVIDUAL_ENTREPRENEUR/);
    });

    it("refuses ANY admin-asserted tax_system for a legal profile whose OWN tax_mode is NPD, as a typed 422 (review round 2, new P1)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_NPD_IS_SYSTEM_DERIVED/);
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      // only the automatic SYSTEM_DERIVED NPD mint - no partial row from the rejected attempt
      expect(taxTreatmentRevisionsForLegalProfile(db, legalProfile.id)).toHaveLength(1);
    });

    it("accepts PSN for a legal profile whose legal_form IS INDIVIDUAL_ENTREPRENEUR", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER"); // readyPartner's OTHER fixture is INDIVIDUAL_ENTREPRENEUR
      const treatment = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "PSN", vatTreatment: "NO_VAT", noVatBasis: "PSN", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "patent",
      }, freshKey());
      expect(treatment).toMatchObject({ tax_system: "PSN", vat_treatment: "NO_VAT", no_vat_basis: "PSN" });
    });

    it("normalizes effective_from to canonical millisecond-precision UTC ISO, whatever shape the caller sends (P1.1)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const treatment = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey());
      expect(treatment.effective_from).toBe("2026-01-01T00:00:00.000Z");
    });

    it("refuses an unparseable effective_from as a typed 422, before any INSERT (P1.1)", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "not-a-date", evidenceRef: "ev.pdf", reason: "x",
      }, freshKey())).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_EFFECTIVE_FROM_INVALID/);
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      expect(taxTreatmentRevisionsForLegalProfile(db, legalProfile.id)).toHaveLength(1); // only readyPartner's own fixture treatment
    });

    it("refuses an idempotency key shorter than 16 characters or longer than 200", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, "short")).toThrow(/IDEMPOTENCY_KEY_INVALID/);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, "x".repeat(201))).toThrow(/IDEMPOTENCY_KEY_INVALID/);
    });
  });

  describe("recordVerifiedTaxTreatment: durable command idempotency (review round 3, P1)", () => {
    it("a TRUE replay (same key) returns the exact original row, mints no new sequence", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const key = freshKey();
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      const first = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      const replay = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      expect(replay).toEqual(first);
      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      // readyPartner("OTHER") already seeds its own fixture treatment - 2
      // total: fixture + first, the replay must not add a third.
      expect(taxTreatmentRevisionsForLegalProfile(db, legalProfile.id)).toHaveLength(2);
    });

    it("the SAME key with a DIFFERENT body is IDEMPOTENCY_CONFLICT, never silently accepted or silently replayed", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const key = freshKey();
      recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "NO_VAT", noVatBasis: "USN_EXEMPT", effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, key);
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, {
        taxSystem: "USN", vatTreatment: "VAT_22", noVatBasis: null, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x",
      }, key)).toThrow(/IDEMPOTENCY_CONFLICT/);
    });

    it("a DIFFERENT key with byte-identical facts is a genuinely NEW assertion revision, never confused with a replay of the first", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      const first = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, freshKey());
      const second = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, freshKey());
      expect(second.id).not.toBe(first.id);
      expect(second.sequence).toBe(first.sequence + 1);
    });

    it("THE REVIEW'S OWN SCENARIO: retrying an original command after an intervening DIFFERENT legitimate command replays the ORIGINAL row and never clobbers the intervening one as the current authority", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const keyA = freshKey();
      const inputA = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "A.pdf", reason: "A" };
      const A = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, inputA, keyA);

      // A genuine SECOND command lands (network response for A was lost,
      // but A itself is durable - the operator or a colleague issues a
      // real correction B with its OWN key).
      const inputB = { taxSystem: "USN" as const, vatTreatment: "VAT_22" as const, noVatBasis: null, effectiveFrom: "2026-01-01", evidenceRef: "B.pdf", reason: "B" };
      const B = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, inputB, freshKey());
      expect(B.sequence).toBeGreaterThan(A.sequence);

      // The original client, unaware B ever happened, retries A with its
      // ORIGINAL key. The old mostRecent-tuple-match design (round 2) would
      // have misclassified this as a NEW mutation (mostRecent is now B, not
      // A) and minted a stray row reasserting A's facts - silently
      // rolling back B as the effective_from = Jan 1 authority. The durable
      // key must instead return A's own row, unchanged, and mint nothing.
      const retryA = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, inputA, keyA);
      expect(retryA).toEqual(A);

      const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      const all = taxTreatmentRevisionsForLegalProfile(db, legalProfile.id);
      // fixture + A + B, no fourth row from the retry.
      expect(all).toHaveLength(3);
      // B, not a reasserted A, remains the current temporal authority.
      const currentTreatment = resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, new Date().toISOString());
      expect(currentTreatment?.id).toBe(B.id);
    });

    it("THE REVIEW'S OWN SCENARIO: retrying an original command after an intervening legal-profile supersession still replays the ORIGINAL row against the ORIGINAL legal profile, never re-asserted against the new one", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "NPD");
      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      const request1 = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", ...legalEntityRequisites, reason: "became org", evidenceRef: "ev.pdf" });
      verifyLegalProfileSupersession(db, admin, request1.id, "verify");
      const l1 = currentAgentReferralsLegalProfile(db, p1.agentId)!;

      const key = freshKey();
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "usn exempt" };
      const A = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      expect(A.legal_profile_revision_id).toBe(l1.id);

      // Legal identity changes again (a genuinely new legal-profile
      // revision) - the OLD round-2 mostRecent-tuple-match compared
      // against the CURRENT profile and would have re-asserted A as a
      // NEW mutation against l2 on retry. The durable key must instead
      // still resolve to A's own original row, pinned to l1.
      const request2 = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "LEGAL_ENTITY", taxMode: "OTHER", opf: "OOO", full_name: "Vasya Romashka LLC v2", inn: "1234567890", kpp: "123456789", registration_number: "9999999999999", legal_address: "Moscow", reason: "re-registered", evidenceRef: "ev2.pdf" });
      const outcome2 = verifyLegalProfileSupersession(db, admin, request2.id, "verify");
      expect(outcome2).toMatchObject({ outcome: "VERIFIED" });
      const l2 = currentAgentReferralsLegalProfile(db, p1.agentId)!;
      expect(l2.id).not.toBe(l1.id);

      const retryA = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      expect(retryA).toEqual(A);
      expect(retryA.legal_profile_revision_id).toBe(l1.id);
      expect(taxTreatmentRevisionsForLegalProfile(db, l2.id)).toEqual([]);
    });

    it("a TRUE replay (same key) succeeds even after the feature has since been SUSPENDED - replay is checked before the suspension gate", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const key = freshKey();
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      const first = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);

      suspendAgentReferrals(db, { expected_revision: agentReferralsFeatureState(db).revision, owner_id: "test-owner", reason: "suspend" });

      const replay = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      expect(replay).toEqual(first);

      // A genuinely NEW key, by contrast, is still correctly blocked.
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, freshKey())).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
    });

    it("a TRUE replay (same key) succeeds even after this identity has since been destroyed - destruction never turns an already-durable command into a retry failure", () => {
      const { db } = fresh(); open.push(db);
      const p1 = readyPartner(db, "OTHER");
      const key = freshKey();
      const input = { taxSystem: "USN" as const, vatTreatment: "NO_VAT" as const, noVatBasis: "USN_EXEMPT" as const, effectiveFrom: "2026-01-01", evidenceRef: "ev.pdf", reason: "x" };
      const first = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);

      mintRetentionPolicyRevision(db, admin, "policy");
      destroyPartnerIdentity(db, admin, p1.partnerIdentityId, "erasure");

      const replay = recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, key);
      expect(replay).toEqual(first);

      // A genuinely NEW key is still correctly refused post-destruction.
      expect(() => recordVerifiedTaxTreatment(db, admin, p1.partnerIdentityId, input, freshKey())).toThrow(/PARTNER_IDENTITY_NOT_FOUND/);
    });
  });
});
