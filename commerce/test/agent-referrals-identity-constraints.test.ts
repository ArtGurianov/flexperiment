import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { admin, fresh, readyPartner } from "./support/agent-referrals-settlement-fixtures";
import { mintRetentionPolicyRevision } from "../src/agent-referrals-identity-retention";

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

  it("refuses to edit an ad channel policy revision", () => {
    // What a partner may advertise on, at the version they agreed to.
    const { db } = setup();
    const policy = rowOf(db, "SELECT * FROM ad_channel_policy LIMIT 1");
    expect(policy).toBeTruthy();

    expect(() => db.prepare("UPDATE ad_channel_policy SET reason = 'rewritten' WHERE id = ?").run(policy.id))
      .toThrow(/AD_CHANNEL_POLICY_REVISION_IMMUTABLE/);
  });
});
