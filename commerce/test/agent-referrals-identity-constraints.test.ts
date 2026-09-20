import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { admin, fresh, readyPartner } from "./support/agent-referrals-settlement-fixtures";
import { mintRetentionPolicyRevision } from "../src/agent-referrals-identity-retention";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile } from "../src/agent-referrals-partner-identity";

/**
 * Constraints of the live schema around who a partner legally is: the events
 * that record their identity, the legal profile and tax treatment the payouts
 * are made under, the framework they accepted, and the policies that govern
 * how long any of it is kept.
 *
 * These rows are the answer to "on what authority was this person paid". They
 * are append-only for the same reason a ledger is: an edit does not correct
 * history, it replaces it with a version nobody agreed to.
 */
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const query = <T>(db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  db.prepare(sql).get(...args) as T;
const rowOf = (db: Database.Database, sql: string, ...args: (string | number | null)[]) =>
  query<Record<string, unknown>>(db, sql, ...args);

const insertVariant = (db: Database.Database, table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
  const next = { ...source, ...changes, id: randomUUID() };
  const columns = Object.keys(next);
  return () => db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`).run(next);
};

const setup = () => {
  const { db } = fresh();
  open.push(db);
  return { db, partner: readyPartner(db, "NPD") };
};

describe("identity history is append-only", () => {
  it.each([
    ["partner_identity_events", "PARTNER_IDENTITY_EVENT_IMMUTABLE", "event_kind = 'rewritten'"],
    ["partner_audience_verification_events", "PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE", "evidence_ref = 'rewritten'"],
  ])("refuses to edit or erase a row of %s", (table, code, assignment) => {
    const { db, partner } = setup();
    const row = rowOf(db, `SELECT * FROM ${table} WHERE partner_identity_id = ? LIMIT 1`, partner.partnerIdentityId);
    expect(row).toBeTruthy();

    expect(() => db.prepare(`UPDATE ${table} SET ${assignment} WHERE id = ?`).run(row.id)).toThrow(new RegExp(code));
    expect(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id)).toThrow(new RegExp(code));
  });
});

describe("the legal basis a partner is paid under is frozen", () => {
  it("refuses to edit or erase a legal profile revision", () => {
    // The revision is what the framework acceptance, the settlement snapshot
    // and every act made out to this partner all point at. Editing it changes
    // documents that were already issued.
    const { db, partner } = setup();
    const revision = rowOf(db, "SELECT * FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? LIMIT 1", partner.agentId);

    expect(() => db.prepare("UPDATE agent_referrals_legal_profile_revisions SET legal_form = 'INDIVIDUAL_ENTREPRENEUR' WHERE id = ?").run(revision.id))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM agent_referrals_legal_profile_revisions WHERE id = ?").run(revision.id))
      .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
  });

  it("refuses to edit or erase a tax treatment revision", () => {
    const { db, partner } = setup();
    const revision = rowOf(db, "SELECT * FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ? LIMIT 1", partner.partnerIdentityId);

    expect(() => db.prepare("UPDATE agent_referrals_tax_treatment_revisions SET tax_system = 'OSN' WHERE id = ?").run(revision.id))
      .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM agent_referrals_tax_treatment_revisions WHERE id = ?").run(revision.id))
      .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE/);
  });

  it("refuses a tax treatment that belongs to another partner's legal profile", () => {
    // The tax system is derived from the legal profile. A treatment pinned to
    // someone else's profile is a payout taxed on a stranger's basis.
    const { db, partner } = setup();
    const other = readyPartner(db, "NPD");
    const revision = rowOf(db, "SELECT * FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ? LIMIT 1", partner.partnerIdentityId);
    const foreignProfile = query<{ id: string }>(db, "SELECT id FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? LIMIT 1", other.agentId);

    expect(insertVariant(db, "agent_referrals_tax_treatment_revisions", revision, { legal_profile_revision_id: foreignProfile.id }))
      .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
  });

  it("refuses a patent regime for a partner who is not an entrepreneur", () => {
    // The third condition of the guard, and the one an application error hides:
    // the domain refuses PSN for a non-entrepreneur before the database is
    // asked. This reaches the database directly, which is where the rule has to
    // hold when the domain is not the writer.
    const { db } = setup();
    const entrepreneur = readyPartner(db, "OTHER");
    const template = rowOf(db, "SELECT * FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ? LIMIT 1", entrepreneur.partnerIdentityId);

    // A real company: not NPD, so the mode condition is satisfied, and not an
    // entrepreneur, so only the patent condition can refuse it.
    const agentId = randomUUID();
    db.prepare(`INSERT INTO partners(id, slug, display_name, email)
      VALUES (?, ?, 'Romashka', ?)`).run(agentId, `company-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const { partner_identity_id: companyIdentityId } = provisionPartnerOwner(db, admin, agentId, "company@example.test", "test");
    submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: companyIdentityId, partner_session_id: "n/a" }, "LEGAL_ENTITY", "OTHER",
      { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" }, 0);
    verifyPartnerLegalProfile(db, admin, companyIdentityId, "verified");
    const companyProfile = query<{ id: string; legal_form: string }>(db,
      "SELECT id, legal_form FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1", agentId);
    expect(companyProfile.legal_form).toBe("LEGAL_ENTITY");

    // A structurally valid patent tuple, so the CHECK is satisfied and only
    // the relational guard is left to have an opinion.
    const patent = { tax_system: "PSN", vat_treatment: "NO_VAT", no_vat_basis: "PSN" };
    expect(insertVariant(db, "agent_referrals_tax_treatment_revisions", template, {
      ...patent, partner_identity_id: companyIdentityId, legal_profile_revision_id: companyProfile.id,
    })).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);

    // The positive control: the same tuple is accepted for an entrepreneur, so
    // the case is about the legal form and not about the patent regime. It is
    // asserted by an admin rather than derived, because only one derived
    // treatment may exist per legal profile.
    expect(insertVariant(db, "agent_referrals_tax_treatment_revisions", template, {
      ...patent, assertion_source: "ADMIN_ASSERTED", sequence: Number(template.sequence) + 1,
    })).not.toThrow();
  });

  it("refuses a tax system the legal profile's mode does not permit", () => {
    // The profile says NPD; a treatment claiming anything else is a different
    // tax regime asserted over the same person.
    const { db, partner } = setup();
    const revision = rowOf(db, "SELECT * FROM agent_referrals_tax_treatment_revisions WHERE partner_identity_id = ? LIMIT 1", partner.partnerIdentityId);
    expect(revision.tax_system).toBe("NPD");

    expect(insertVariant(db, "agent_referrals_tax_treatment_revisions", revision, { tax_system: "USN" }))
      .toThrow(/AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT/);
  });
});

describe("a framework acceptance belongs to one partner throughout", () => {
  it("refuses an acceptance of an issuance made out to someone else", () => {
    const { db, partner } = setup();
    const other = readyPartner(db, "NPD");
    const acceptance = rowOf(db, "SELECT * FROM framework_acceptances WHERE partner_identity_id = ? LIMIT 1", partner.partnerIdentityId);
    const foreignIssuance = query<{ id: string }>(db, "SELECT id FROM framework_issuances WHERE partner_identity_id = ? LIMIT 1", other.partnerIdentityId);

    expect(insertVariant(db, "framework_acceptances", acceptance, { issuance_id: foreignIssuance.id }))
      .toThrow(/FRAMEWORK_ACCEPTANCE_ISSUANCE_PARTNER_MISMATCH/);
  });

  it("refuses an acceptance citing another partner's legal profile", () => {
    const { db, partner } = setup();
    const other = readyPartner(db, "NPD");
    const acceptance = rowOf(db, "SELECT * FROM framework_acceptances WHERE partner_identity_id = ? LIMIT 1", partner.partnerIdentityId);
    const foreignProfile = query<{ id: string }>(db, "SELECT id FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? LIMIT 1", other.agentId);

    expect(insertVariant(db, "framework_acceptances", acceptance, { legal_profile_revision_id: foreignProfile.id }))
      .toThrow(/FRAMEWORK_ACCEPTANCE_LEGAL_PROFILE_PARTNER_MISMATCH/);
  });
});

describe("the policies that govern retention and channels are revisions, not settings", () => {
  it("refuses to edit or erase a retention policy revision", () => {
    // Retention is a legal commitment about personal data. Changing a revision
    // retroactively changes what the partner was told.
    const { db } = setup();
    const policy = mintRetentionPolicyRevision(db, admin, "initial policy");

    expect(() => db.prepare("UPDATE partner_identity_retention_policies SET reason = 'rewritten' WHERE id = ?").run(policy.id))
      .toThrow(/PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM partner_identity_retention_policies WHERE id = ?").run(policy.id))
      .toThrow(/PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE/);
  });

  it("refuses to edit or erase an ad channel policy revision", () => {
    // What a partner may advertise on, at the version they agreed to. The
    // guard covers deletion as well, because a channel classification that can
    // be erased is one a later report can silently contradict.
    const { db } = setup();
    const policy = rowOf(db, "SELECT * FROM ad_channel_policy LIMIT 1");
    expect(policy).toBeTruthy();

    expect(() => db.prepare("UPDATE ad_channel_policy SET reason = 'rewritten' WHERE id = ?").run(policy.id))
      .toThrow(/AD_CHANNEL_POLICY_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM ad_channel_policy WHERE id = ?").run(policy.id))
      .toThrow(/AD_CHANNEL_POLICY_REVISION_IMMUTABLE/);
  });
});
