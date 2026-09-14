import { describe, expect, it } from "vitest";
import { buildAgreementSemanticView, FRAMEWORK_AGREEMENT_CLAUSE_ORDER, DELEGATION_TEMPLATE_CLAUSE_ORDER, sameAgreementPartyFacts, type BuildAgreementSemanticViewInput } from "./AgreementRenderer";

/**
 * Golden test over the renderer's SEMANTIC section output (parties /
 * ordered clauses / evidence) - never DOM or markup, the same reason a
 * rendered-snapshot hash was rejected for the underlying evidence itself:
 * presentation must stay fully refactorable.
 */

const clausesJson = (order: readonly string[], prefix: string) => ({ clauses: order.map((key) => [key, `${prefix}: ${key}`]) });

const baseInput: BuildAgreementSemanticViewInput = {
  issuance_sequence: 2,
  issued_at: "2026-01-01T00:00:00.000Z",
  framework_agreement: { revision: 3, content_hash: "fw-hash-3", content: clausesJson(FRAMEWORK_AGREEMENT_CLAUSE_ORDER, "fw-v3") },
  delegation_template: { revision: 2, content_hash: "dt-hash-2", content: clausesJson(DELEGATION_TEMPLATE_CLAUSE_ORDER, "dt-v2") },
  accepted: false,
  accepted_at: null,
  party_profile: {
    legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER",
    opf: null, full_name: "Ivanov Ivan Ivanovich", short_name: null, inn: "123456789012", kpp: null,
    registration_number: "123456789012345", legal_address: null, revision: 4,
  },
  notice_only_divergence_since_acceptance: false,
};

describe("buildAgreementSemanticView", () => {
  it("unaccepted document: historical=false, party is the CURRENT MAX profile passed in, evidence carries the required issuance's own numbers", () => {
    const view = buildAgreementSemanticView(baseInput);
    expect(view.historical).toBe(false);
    expect(view.party).toEqual({
      full_name: "Ivanov Ivan Ivanovich", short_name: null, inn: "123456789012", kpp: null,
      registration_number: "123456789012345", legal_address: null, opf: null,
      legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", legal_profile_revision: 4,
    });
    expect(view.evidence).toEqual({
      issuance_sequence: 2,
      framework_agreement_revision: 3, framework_agreement_content_hash: "fw-hash-3",
      delegation_template_revision: 2, delegation_template_content_hash: "dt-hash-2",
      legal_profile_revision: 4,
      issued_at: "2026-01-01T00:00:00.000Z", accepted_at: null,
    });
    expect(view.noticeOnlyProfileDivergence).toBe(false);
  });

  it("the framework clauses are in the plan's exact order, every one of the 15 keys present with its own label and its own text pulled from content_json", () => {
    const view = buildAgreementSemanticView(baseInput);
    expect(view.framework_clauses.map((c) => c.key)).toEqual([...FRAMEWORK_AGREEMENT_CLAUSE_ORDER]);
    for (const clause of view.framework_clauses) {
      expect(clause.label.length).toBeGreaterThan(0);
      expect(clause.text).toBe(`fw-v3: ${clause.key}`);
    }
  });

  it("the delegation clauses are the 2-key subset, in order, with their own text", () => {
    const view = buildAgreementSemanticView(baseInput);
    expect(view.delegation_clauses.map((c) => c.key)).toEqual([...DELEGATION_TEMPLATE_CLAUSE_ORDER]);
    for (const clause of view.delegation_clauses) {
      expect(clause.text).toBe(`dt-v2: ${clause.key}`);
    }
  });

  it("a missing clause key in content_json renders as empty text, never throws - a malformed/incomplete server payload must not crash the renderer", () => {
    const view = buildAgreementSemanticView({ ...baseInput, framework_agreement: { ...baseInput.framework_agreement, content: { clauses: [] } } });
    expect(view.framework_clauses).toHaveLength(15);
    expect(view.framework_clauses.every((c) => c.text === "")).toBe(true);
  });

  it("accepted historical document: historical=true, party is the ACCEPTED profile (never current MAX), evidence.accepted_at is set", () => {
    const view = buildAgreementSemanticView({
      ...baseInput, accepted: true, accepted_at: "2026-02-01T00:00:00.000Z",
      party_profile: { ...baseInput.party_profile, full_name: "Ivanov Ivan Ivanovich (as signed)", revision: 2 },
    });
    expect(view.historical).toBe(true);
    expect(view.party.full_name).toBe("Ivanov Ivan Ivanovich (as signed)");
    expect(view.party.legal_profile_revision).toBe(2);
    expect(view.evidence.legal_profile_revision).toBe(2);
    expect(view.evidence.accepted_at).toBe("2026-02-01T00:00:00.000Z");
  });

  it("NOTICE_ONLY divergence is surfaced only when accepted=true - never on an unaccepted document, which has nothing to diverge from yet", () => {
    const unaccepted = buildAgreementSemanticView({ ...baseInput, notice_only_divergence_since_acceptance: true });
    expect(unaccepted.noticeOnlyProfileDivergence).toBe(false);

    const accepted = buildAgreementSemanticView({ ...baseInput, accepted: true, accepted_at: "2026-02-01T00:00:00.000Z", notice_only_divergence_since_acceptance: true });
    expect(accepted.noticeOnlyProfileDivergence).toBe(true);
  });

  it("two calls with semantically identical input produce a deep-equal view - the renderer is pure", () => {
    const a = buildAgreementSemanticView(baseInput);
    const b = buildAgreementSemanticView({ ...baseInput });
    expect(a).toEqual(b);
  });

  it("compares only displayed agreement-party facts, never projection metadata", () => {
    const accepted = baseInput.party_profile;
    const current = { ...accepted, revision: 9, created_at: "2026-03-01T00:00:00.000Z", projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR" };
    expect(sameAgreementPartyFacts(current, accepted)).toBe(true);
    expect(sameAgreementPartyFacts({ ...current, legal_address: "Tomsk" }, accepted)).toBe(false);
  });
});
