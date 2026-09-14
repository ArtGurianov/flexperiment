import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyOrdinaryMigration } from "../src/db";

/**
 * 0060 rebuilds framework_issuances/framework_acceptances/
 * ord_reporting_delegations for reissuance (PR2 of the reissuance/evidence
 * program). It is an ORDINARY migration (not FK-off - every table it
 * rebuilds is proven empty by its own zero-data guard, so there is nothing
 * for `foreign_key_check` to find). Every test drives the REAL migrate
 * primitive against the REAL, committed migration file.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0060_agent_referrals_framework_reissuance.sql";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
const BEFORE_0060 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0060").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** Built once: every migration up to (not including) 0060, on disk, copied per test - same rationale/precedent as the 0042 rebuild suite. */
const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "framework-reissuance-migration-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0060) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0059 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "framework-reissuance-migration-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const apply0060 = (db: Database.Database) => applyOrdinaryMigration(db, MIGRATION_FILE, MIGRATION_SQL);

const objectNames = (db: Database.Database): Set<string> =>
  new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as { name: string }[]).map((r) => r.name));

/** Seeds the minimum ancestry a framework_issuances/framework_acceptances row needs: an agent, a partner identity, template revisions, a step-up grant. */
const seedAncestry = (db: Database.Database) => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, email, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', ?, 'PERCENT', 1000)`).run(agentId, `agent-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const partnerIdentityId = randomUUID();
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'hash', 'admin-1')`)
    .run(partnerIdentityId, agentId);
  const legalProfileId = randomUUID();
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
    VALUES (?, ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'test', 'PARTNER_ASSERTED')`)
    .run(legalProfileId, agentId);
  const fwId = randomUUID();
  const fwRevision = (db.prepare("SELECT COALESCE(MAX(revision), 0) AS m FROM framework_agreement_revisions").get() as { m: number }).m + 1;
  db.prepare(`INSERT INTO framework_agreement_revisions(id, revision, content_json, content_hash) VALUES (?, ?, '{}', ?)`).run(fwId, fwRevision, `hash-fw-${fwId}`);
  const dtId = randomUUID();
  const dtRevision = (db.prepare("SELECT COALESCE(MAX(revision), 0) AS m FROM delegation_template_revisions").get() as { m: number }).m + 1;
  db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash) VALUES (?, ?, 'FLEXPERIMENT_DELEGATED', '{}', ?)`).run(dtId, dtRevision, `hash-dt-${dtId}`);
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  return { agentId, partnerIdentityId, legalProfileId, fwId, dtId, sessionId };
};

const insertStepUpGrant = (db: Database.Database, sessionId: string, partnerIdentityId: string) => {
  const grantId = randomUUID();
  db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
    VALUES (?, ?, ?, 'FRAMEWORK_ACCEPTANCE', '{}', ?, datetime('now', '+1 hour'))`).run(grantId, sessionId, partnerIdentityId, randomUUID());
  return grantId;
};

describe("0060 framework reissuance migration", () => {
  it("aborts closed when a framework_issuances row already exists, leaving the pre-migration schema untouched", () => {
    const db = at0059();
    const { agentId, partnerIdentityId } = seedAncestry(db);
    const fw2 = randomUUID();
    db.prepare(`INSERT INTO framework_agreement_revisions(id, revision, content_json, content_hash) VALUES (?, 2, '{}', 'hash-fw-2')`).run(fw2);
    const dt2 = randomUUID();
    db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash) VALUES (?, 2, 'FLEXPERIMENT_DELEGATED', '{}', 'hash-dt-2')`).run(dt2);
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id) VALUES (?, ?, ?, ?, 'admin-1')`)
      .run(randomUUID(), partnerIdentityId, fw2, dt2);

    expect(() => apply0060(db)).toThrow(/PR2_REISSUANCE_MIGRATION_REQUIRES_ZERO_EXISTING_EVIDENCE/);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sequence'").get()).toBeUndefined();
    // Old shape is intact: partner_identity_id is still UNIQUE (still just one row).
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_issuances").get()).toEqual({ n: 1 });
    void agentId;
  });

  it("applies cleanly against a zero-evidence database and rebuilds all three tables with the new shape", () => {
    const db = at0059();
    seedAncestry(db);
    expect(() => apply0060(db)).not.toThrow();

    const issuanceColumns = (db.prepare("PRAGMA table_info(framework_issuances)").all() as { name: string }[]).map((c) => c.name);
    expect(issuanceColumns).toEqual(expect.arrayContaining(["sequence", "reason"]));
    const acceptanceColumns = (db.prepare("PRAGMA table_info(framework_acceptances)").all() as { name: string }[]).map((c) => c.name);
    expect(acceptanceColumns).toEqual(expect.arrayContaining(["issuance_id", "legal_profile_revision_id"]));
    expect(acceptanceColumns).not.toContain("framework_agreement_revision_id");

    const names = objectNames(db);
    for (const name of [
      "framework_issuances", "framework_issuances_immutable_guard", "framework_issuances_delete_guard",
      "framework_acceptances", "framework_acceptances_immutable_guard", "framework_acceptances_delete_guard",
      "framework_acceptances_issuance_partner_consistency_guard", "framework_acceptances_legal_profile_partner_consistency_guard",
      "ord_reporting_delegations", "ord_reporting_delegations_immutable_guard", "ord_reporting_delegations_delete_guard",
      "ord_reporting_delegations_acceptance_partner_consistency_guard",
      "ord_reporting_delegations_template_issuance_consistency_guard",
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("UNIQUE(partner_identity_id, sequence) admits two issuances for the same partner at different sequences, never at the same one", () => {
    const db = at0059();
    const { partnerIdentityId, fwId, dtId } = seedAncestry(db);
    apply0060(db);
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'first')`).run(randomUUID(), partnerIdentityId, fwId, dtId);
    expect(() => db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'duplicate sequence')`).run(randomUUID(), partnerIdentityId, fwId, dtId)).toThrow(/UNIQUE constraint failed/);
    expect(() => db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 2, ?, ?, 'admin-1', 'second')`).run(randomUUID(), partnerIdentityId, fwId, dtId)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_issuances WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 2 });
  });

  it("cross-partner guard: an acceptance for partner A referencing A's own issuance but partner B's legal profile aborts", () => {
    const db = at0059();
    const a = seedAncestry(db);
    apply0060(db);
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'issued')`).run(randomUUID(), a.partnerIdentityId, a.fwId, a.dtId);
    const issuanceAId = (db.prepare("SELECT id FROM framework_issuances WHERE partner_identity_id = ?").get(a.partnerIdentityId) as { id: string }).id;

    // A second, unrelated partner B with its own legal profile.
    const bAgentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, email, default_reward_type, default_reward_value)
      VALUES (?, ?, 'Agent B', ?, 'PERCENT', 1000)`).run(bAgentId, `agent-b-${bAgentId.slice(0, 8)}`, `b-${bAgentId.slice(0, 8)}@example.test`);
    const bPartnerIdentityId = randomUUID();
    db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'b@example.test', 'hash-b', 'admin-1')`).run(bPartnerIdentityId, bAgentId);
    const bLegalProfileId = randomUUID();
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
      VALUES (?, ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Petrov Petr Petrovich', '999999999999', 'test', 'PARTNER_ASSERTED')`).run(bLegalProfileId, bAgentId);

    const grantId = insertStepUpGrant(db, a.sessionId, a.partnerIdentityId);
    expect(() => db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id)
      VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), a.partnerIdentityId, issuanceAId, bLegalProfileId, grantId))
      .toThrow(/FRAMEWORK_ACCEPTANCE_LEGAL_PROFILE_PARTNER_MISMATCH/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  it("cross-partner guard: an acceptance for partner A referencing partner B's issuance directly aborts", () => {
    const db = at0059();
    const a = seedAncestry(db);
    const b = seedAncestry(db);
    apply0060(db);
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'issued to B')`).run(randomUUID(), b.partnerIdentityId, b.fwId, b.dtId);
    const issuanceBId = (db.prepare("SELECT id FROM framework_issuances WHERE partner_identity_id = ?").get(b.partnerIdentityId) as { id: string }).id;

    const grantId = insertStepUpGrant(db, a.sessionId, a.partnerIdentityId);
    expect(() => db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id)
      VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), a.partnerIdentityId, issuanceBId, a.legalProfileId, grantId))
      .toThrow(/FRAMEWORK_ACCEPTANCE_ISSUANCE_PARTNER_MISMATCH/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  it("cross-partner guard: a delegation for partner A bound to partner B's acceptance aborts", () => {
    const db = at0059();
    const a = seedAncestry(db);
    const b = seedAncestry(db);
    apply0060(db);

    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'issued')`).run(randomUUID(), b.partnerIdentityId, b.fwId, b.dtId);
    const issuanceBId = (db.prepare("SELECT id FROM framework_issuances WHERE partner_identity_id = ?").get(b.partnerIdentityId) as { id: string }).id;
    const grantB = insertStepUpGrant(db, b.sessionId, b.partnerIdentityId);
    const acceptanceBId = randomUUID();
    db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id) VALUES (?, ?, ?, ?, ?)`)
      .run(acceptanceBId, b.partnerIdentityId, issuanceBId, b.legalProfileId, grantB);

    expect(() => db.prepare(`INSERT INTO ord_reporting_delegations(id, partner_identity_id, framework_acceptance_id, delegation_template_revision_id, ord_reporting_mode)
      VALUES (?, ?, ?, ?, 'FLEXPERIMENT_DELEGATED')`).run(randomUUID(), a.partnerIdentityId, acceptanceBId, b.dtId))
      .toThrow(/ORD_REPORTING_DELEGATION_ACCEPTANCE_PARTNER_MISMATCH/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
  });

  it("delegation template must equal the acceptance issuance's template, even for the same partner", () => {
    const db = at0059();
    const a = seedAncestry(db);
    apply0060(db);
    const issuanceId = randomUUID();
    db.prepare(`INSERT INTO framework_issuances(id, partner_identity_id, sequence, framework_agreement_revision_id, delegation_template_revision_id, issued_by_admin_id, reason)
      VALUES (?, ?, 1, ?, ?, 'admin-1', 'issued')`).run(issuanceId, a.partnerIdentityId, a.fwId, a.dtId);
    const acceptanceId = randomUUID();
    db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, issuance_id, legal_profile_revision_id, step_up_grant_id)
      VALUES (?, ?, ?, ?, ?)`).run(acceptanceId, a.partnerIdentityId, issuanceId, a.legalProfileId, insertStepUpGrant(db, a.sessionId, a.partnerIdentityId));
    const otherTemplateId = randomUUID();
    db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash)
      VALUES (?, 2, 'FLEXPERIMENT_DELEGATED', '{}', 'other-template')`).run(otherTemplateId);

    expect(() => db.prepare(`INSERT INTO ord_reporting_delegations(id, partner_identity_id, framework_acceptance_id, delegation_template_revision_id, ord_reporting_mode)
      VALUES (?, ?, ?, ?, 'FLEXPERIMENT_DELEGATED')`).run(randomUUID(), a.partnerIdentityId, acceptanceId, otherTemplateId))
      .toThrow(/ORD_REPORTING_DELEGATION_TEMPLATE_ISSUANCE_MISMATCH/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_delegations").get()).toEqual({ n: 0 });
  });
});
