import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  applyAgentReferralsLegalProfile, classifyLegalProfileChange,
  type ComparableLegalProfile,
} from "../src/agent-referrals-legal-profile";
import { INN_LENGTH } from "../../lib/legal-profile-rules";

/**
 * PR2 of the reissuance/evidence program: classifyLegalProfileChange is the
 * one place that decides whether a legal-profile change is a routine
 * notice, a contractual reissuance, a new partner identity, or an
 * inconsistency to refuse outright. Pure-function tests first (no DB), then
 * the mint-time fail-closed integration.
 */

const base: ComparableLegalProfile = {
  legal_form: "INDIVIDUAL", tax_mode: "NPD", projected_contractor_type: "SELF_EMPLOYED",
  opf: null, full_name: "Ivanov Ivan Ivanovich", short_name: null, inn: "123456789012", kpp: null, registration_number: null, legal_address: null,
};

describe("classifyLegalProfileChange", () => {
  it("no change at all: NOTICE_ONLY (the vacuous case)", () => {
    expect(classifyLegalProfileChange(base, base)).toBe("NOTICE_ONLY");
  });

  it("самозанятый -> ИП, same INN, ОГРНИП appears: CONTRACTUAL_REISSUANCE_REQUIRED, never a new identity", () => {
    const current: ComparableLegalProfile = {
      ...base, legal_form: "INDIVIDUAL_ENTREPRENEUR", projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR", registration_number: "123456789012345",
    };
    expect(classifyLegalProfileChange(base, current)).toBe("CONTRACTUAL_REISSUANCE_REQUIRED");
  });

  it("ИП -> ИП, same INN, registration_number changes: CONTRACTUAL_REISSUANCE_REQUIRED (the case an old catch-all would swallow as identity-inconsistent)", () => {
    const ip: ComparableLegalProfile = { ...base, legal_form: "INDIVIDUAL_ENTREPRENEUR", projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR", registration_number: "123456789012345" };
    const current: ComparableLegalProfile = { ...ip, registration_number: "999999999999999" };
    expect(classifyLegalProfileChange(ip, current)).toBe("CONTRACTUAL_REISSUANCE_REQUIRED");
  });

  it("LEGAL_ENTITY, same INN, registration_number changes: refused as IDENTITY_INCONSISTENT", () => {
    const org: ComparableLegalProfile = {
      legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    };
    const current: ComparableLegalProfile = { ...org, registration_number: "9999999999999" };
    expect(classifyLegalProfileChange(org, current)).toBe("IDENTITY_INCONSISTENT");
  });

  it("opf ООО -> АО: CONTRACTUAL_REISSUANCE_REQUIRED (reorganization, same party)", () => {
    const org: ComparableLegalProfile = {
      legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    };
    const current: ComparableLegalProfile = { ...org, opf: "AO" };
    expect(classifyLegalProfileChange(org, current)).toBe("CONTRACTUAL_REISSUANCE_REQUIRED");
  });

  it("legal_address / kpp only: NOTICE_ONLY", () => {
    const org: ComparableLegalProfile = {
      legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    };
    const current: ComparableLegalProfile = { ...org, kpp: "987654321", legal_address: "Saint Petersburg" };
    expect(classifyLegalProfileChange(org, current)).toBe("NOTICE_ONLY");
  });

  it("full_name / short_name only: NOTICE_ONLY", () => {
    const current: ComparableLegalProfile = { ...base, full_name: "Ivanov Ivan Petrovich" };
    expect(classifyLegalProfileChange(base, current)).toBe("NOTICE_ONLY");
  });

  it("inn change alone: NEW_PARTNER_IDENTITY_REQUIRED", () => {
    const current: ComparableLegalProfile = { ...base, inn: "999999999999" };
    expect(classifyLegalProfileChange(base, current)).toBe("NEW_PARTNER_IDENTITY_REQUIRED");
  });

  it("boundary test: crossing natural-person -> organization always changes the INN (12 digits vs 10), independent of the DB CHECK", () => {
    expect(INN_LENGTH.INDIVIDUAL).toBe(12);
    expect(INN_LENGTH.INDIVIDUAL_ENTREPRENEUR).toBe(12);
    expect(INN_LENGTH.LEGAL_ENTITY).toBe(10);
    // A crossing necessarily supplies an INN of a different length, hence a
    // different INN string - classifyLegalProfileChange needs no separate
    // legal_form-crossing rule because of this, but the invariant itself
    // must hold independent of (never derived from) that CHECK.
    expect(INN_LENGTH.INDIVIDUAL).not.toBe(INN_LENGTH.LEGAL_ENTITY);
  });

  it("any change crossing to LEGAL_ENTITY: NEW_PARTNER_IDENTITY_REQUIRED (via the INN rule, not a bespoke crossing rule)", () => {
    const current: ComparableLegalProfile = {
      legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", projected_contractor_type: "ORGANIZATION",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    };
    expect(classifyLegalProfileChange(base, current)).toBe("NEW_PARTNER_IDENTITY_REQUIRED");
  });

  it("a change that touches both an identity field and a notice-only field is never under-classified: worst effect wins", () => {
    const current: ComparableLegalProfile = { ...base, inn: "999999999999", full_name: "Someone Else Entirely" };
    expect(classifyLegalProfileChange(base, current)).toBe("NEW_PARTNER_IDENTITY_REQUIRED");
  });

  it("tax_mode change alone: CONTRACTUAL_REISSUANCE_REQUIRED", () => {
    const ip: ComparableLegalProfile = { ...base, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "NPD", projected_contractor_type: "INDIVIDUAL_ENTREPRENEUR", registration_number: "123456789012345" };
    const current: ComparableLegalProfile = { ...ip, tax_mode: "OTHER" };
    expect(classifyLegalProfileChange(ip, current)).toBe("CONTRACTUAL_REISSUANCE_REQUIRED");
  });
});

describe("applyAgentReferralsLegalProfile: fail-closed on party change at mint time", () => {
  const open: Database.Database[] = [];
  afterEach(() => { while (open.length) open.pop()!.close(); });
  const fresh = () => {
    const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-legal-profile-classification-")), "commerce.sqlite");
    const db = openDatabase(file);
    migrate(db);
    open.push(db);
    return db;
  };
  const seedAgent = (db: Database.Database) => {
    const agentId = randomUUID();
    db.prepare(`INSERT INTO partners(id, slug, display_name, email)
      VALUES (?, ?, 'Agent', ?)`).run(agentId, `agent-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    return agentId;
  };

  it("refuses an INN-changing revision with LEGAL_PROFILE_PARTY_CHANGE_REQUIRES_NEW_IDENTITY, and mints nothing", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "initial", assertion_source: "PARTNER_ASSERTED",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012",
    });
    expect(() => applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "different person", assertion_source: "ADMIN_ASSERTED", evidence_ref: "ev.pdf",
      full_name: "Petrov Petr Petrovich", inn: "999999999999",
    })).toThrow(/LEGAL_PROFILE_PARTY_CHANGE_REQUIRES_NEW_IDENTITY/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions WHERE agent_id = ?").get(agentId)).toEqual({ n: 1 });
  });

  it("refuses a same-INN LEGAL_ENTITY registration_number change with LEGAL_PROFILE_IDENTITY_INCONSISTENT, and mints nothing", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "initial", assertion_source: "PARTNER_ASSERTED",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    });
    expect(() => applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "ogrn changed, same inn", assertion_source: "ADMIN_ASSERTED", evidence_ref: "egrul.pdf",
      opf: "OOO", full_name: "Romashka LLC", short_name: "Romashka", inn: "1234567890", kpp: "123456789", registration_number: "9999999999999", legal_address: "Moscow",
    })).toThrow(/LEGAL_PROFILE_IDENTITY_INCONSISTENT/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions WHERE agent_id = ?").get(agentId)).toEqual({ n: 1 });
  });

  it("a legitimate CONTRACTUAL_REISSUANCE_REQUIRED change (tax_mode) still mints normally", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "NPD", reason: "initial", assertion_source: "PARTNER_ASSERTED",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    const result = applyAgentReferralsLegalProfile(db, {
      agent_id: agentId, legal_form: "INDIVIDUAL_ENTREPRENEUR", tax_mode: "OTHER", reason: "left NPD", assertion_source: "ADMIN_ASSERTED", evidence_ref: "ev.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(result.minted).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions WHERE agent_id = ?").get(agentId)).toEqual({ n: 2 });
  });
});
