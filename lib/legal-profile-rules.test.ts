import { describe, expect, it } from "vitest";
import {
  LEGAL_FORMS, LEGAL_PROFILE_PROJECTION, REQUISITE_FIELDS, REQUISITE_SHAPE, TAX_MODES,
  requisiteRule, resolveProjectedContractorType, taxModesForLegalForm,
} from "./legal-profile-rules";

/**
 * The conformance test (commerce/test/agent-referrals-legal-profile-
 * conformance.test.ts) proves these tables match the DATABASE. This one
 * proves the two DERIVED helpers the React forms call match the tables they
 * are derived from - a wrong `taxModesForLegalForm` would quietly offer a
 * tax mode the matrix rejects (or hide one it allows) without any server-side
 * check ever firing, because the form would simply never submit that pair.
 */
describe("legal-profile rules: derived helpers agree with the tables", () => {
  it("taxModesForLegalForm offers exactly the modes the projection table admits", () => {
    for (const legalForm of LEGAL_FORMS) {
      const offered = taxModesForLegalForm(legalForm);
      const admitted = TAX_MODES.filter((taxMode) => resolveProjectedContractorType(legalForm, taxMode) !== null);
      expect(offered, legalForm).toEqual(admitted);
      expect(offered.length, `${legalForm} must admit at least one tax mode`).toBeGreaterThan(0);
    }
  });

  it("taxModesForLegalForm returns nothing for a value outside the union", () => {
    // The forms hold `legal_form` as a plain string (react-hook-form), so an
    // unexpected value must degrade to "no options", never to a crash.
    expect(taxModesForLegalForm("NOT_A_LEGAL_FORM" as never)).toEqual([]);
  });

  it("requisiteRule agrees with REQUISITE_SHAPE for every cell", () => {
    for (const legalForm of LEGAL_FORMS) {
      for (const field of REQUISITE_FIELDS) {
        expect(requisiteRule(legalForm, field), `${legalForm}.${field}`).toBe(REQUISITE_SHAPE[legalForm][field]);
      }
    }
  });

  it("pins the two deliberately rejected combinations", () => {
    // Absent cells are decisions, not omissions: NPD is individual-only in
    // Russian tax law, and an individual who is not on NPD is not a
    // contractor this system can represent at all.
    expect(resolveProjectedContractorType("INDIVIDUAL", "OTHER")).toBeNull();
    expect(resolveProjectedContractorType("LEGAL_ENTITY", "NPD")).toBeNull();
    expect(Object.keys(LEGAL_PROFILE_PROJECTION)).toEqual([...LEGAL_FORMS]);
  });
});
