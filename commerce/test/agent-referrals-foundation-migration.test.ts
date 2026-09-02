import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";

/**
 * 0043 is the foundation schema: feature-state authority, activation
 * manifest, immutable legal-profile revisions, immutable framework/
 * delegation content revisions, versioned channel policy. It is an ORDINARY
 * migration - not FK-off, and the FK_OFF_MIGRATIONS registry PR2 populated
 * with exactly the 0042 tuple must stay exactly that after this PR.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0043_agent_referrals_foundation.sql";
const BEFORE_0043 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0043").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-foundation-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0043) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0042 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-foundation-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

/**
 * Scoped to exactly 0043, regardless of what later migrations (0044+) exist
 * in the real migrations directory - migrate()'s default directory applies
 * everything it finds there, which is correct for migrate() itself but
 * would make a test asking "what does 0043 introduce" drift the moment a
 * later PR adds its own migration.
 */
const migrateOnly0043 = (db: Database.Database) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-referrals-only-0043-"));
  copyFileSync(join(MIGRATIONS, MIGRATION_FILE), join(dir, MIGRATION_FILE));
  migrate(db, dir);
};

describe("0043 agent-referrals foundation migration", () => {
  it("applies exactly once through the real migrate() runner, ordinarily (FK stays ON)", () => {
    const db = at0042();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op", () => {
    const db = at0042();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    const channelPolicyBefore = db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy").get();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    // Re-running must not re-seed the nine channel policy rows.
    expect(db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy").get()).toEqual(channelPolicyBefore);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off: 0043 is absent from FK_OFF_MIGRATIONS", () => {
    const db = at0042();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    expect(isFkOffMigration(MIGRATION_FILE, sha256)).toBe(false);
    migrate(db);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
  });

  it("leaves the FK_OFF_MIGRATIONS registry containing only the exact 0042 tuple", () => {
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("creates no agent_referrals_pilot_policy table or any capacity-shaped table", () => {
    const db = at0042();
    migrateOnly0043(db);
    const names = tableNames(db);
    expect(names).not.toContain("agent_referrals_pilot_policy");
    expect(names.some((name) => /pilot|capacity|cap_/i.test(name))).toBe(false);
  });

  it("creates exactly the expected new tables and no partner/engagement/promo/reward business tables", () => {
    const db = at0042();
    const before = new Set(tableNames(db));
    migrateOnly0043(db);
    const after = tableNames(db);
    const introduced = after.filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual([
      "ad_channel_policy",
      "agent_referrals_activation_manifest",
      "agent_referrals_feature_state",
      "agent_referrals_feature_state_events",
      "agent_referrals_legal_profile_revisions",
      "delegation_template_revisions",
      "framework_agreement_revisions",
    ].sort());
    for (const forbidden of ["partner_identities", "partner_sessions", "engagements", "partner_promos", "engagement_creative_revisions", "engagement_distributions"]) {
      expect(introduced).not.toContain(forbidden);
    }
  });

  it("seeds exactly the nine plan-listed channel keys at revision 1, ALLOWED, and nothing else", () => {
    const db = at0042();
    migrate(db);
    const rows = db.prepare("SELECT channel_key, policy_revision, status FROM ad_channel_policy ORDER BY channel_key").all();
    expect(rows).toEqual([
      { channel_key: "likee", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "rutube", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "telegram", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "tiktok", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "twitch", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "vk", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "vk_clips", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "vk_video", policy_revision: 1, status: "ALLOWED" },
      { channel_key: "youtube", policy_revision: 1, status: "ALLOWED" },
    ]);
  });

  it("ships agent_referrals_feature_state as DORMANT, unowned, revision 1", () => {
    const db = at0042();
    migrate(db);
    expect(db.prepare("SELECT state, owner_id, revision FROM agent_referrals_feature_state WHERE singleton = 1").get())
      .toEqual({ state: "DORMANT", owner_id: null, revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get()).toEqual({ n: 0 });
  });

  describe("structural constraints, proven against actual SQLite schema", () => {
    it("enforces the legal-profile 4-allowed/2-rejected matrix via a real CHECK constraint", () => {
      const db = at0042();
      migrate(db);
      // Revisions are immutable and undeletable (structurally, by trigger),
      // so each case gets its own agent rather than reusing revision 1 on
      // one agent - this test proves the CHECK, not the revision sequence.
      const insertAgent = (agentId: string) => db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES (?, ?, 'M', 'M Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);

      const allowed: Array<[string, string, string]> = [
        ["INDIVIDUAL", "NPD", "SELF_EMPLOYED"],
        ["INDIVIDUAL_ENTREPRENEUR", "NPD", "INDIVIDUAL_ENTREPRENEUR"],
        ["INDIVIDUAL_ENTREPRENEUR", "OTHER", "INDIVIDUAL_ENTREPRENEUR"],
        ["LEGAL_ENTITY", "OTHER", "ORGANIZATION"],
      ];
      for (const [legalForm, taxMode, projected] of allowed) {
        const agentId = `agent-matrix-allowed-${legalForm}-${taxMode}`;
        insertAgent(agentId);
        expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason)
          VALUES (?, ?, 1, ?, ?, ?, 'structural-proof')`).run(`${legalForm}-${taxMode}`, agentId, legalForm, taxMode, projected),
          `${legalForm}+${taxMode}`).not.toThrow();
      }
      const rejected: Array<[string, string, string]> = [
        ["INDIVIDUAL", "OTHER", "SELF_EMPLOYED"],
        ["LEGAL_ENTITY", "NPD", "ORGANIZATION"],
      ];
      for (const [legalForm, taxMode, projected] of rejected) {
        const agentId = `agent-matrix-rejected-${legalForm}-${taxMode}`;
        insertAgent(agentId);
        expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason)
          VALUES (?, ?, 1, ?, ?, ?, 'structural-proof')`).run(`${legalForm}-${taxMode}`, agentId, legalForm, taxMode, projected),
          `${legalForm}+${taxMode}`).toThrow(/CHECK constraint failed/);
      }
    });

    it("enforces UNIQUE(channel_key, policy_revision) on ad_channel_policy", () => {
      const db = at0042();
      migrate(db);
      expect(() => db.prepare(`INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason)
        VALUES ('dup', 'telegram', 1, 'BLOCKED', '2021-01-01T00:00:00.000Z', 'dup')`).run())
        .toThrow(/UNIQUE constraint failed/);
    });

    it("refuses a catch-all channel_key set ALLOWED at the database layer", () => {
      const db = at0042();
      migrate(db);
      for (const key of ["other", "other_internet_platform", "unknown", "*"]) {
        expect(() => db.prepare(`INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason)
          VALUES (?, ?, 1, 'ALLOWED', '2020-01-01T00:00:00.000Z', 'attempt')`).run(`catch-all-${key}`, key), key)
          .toThrow(/CHECK constraint failed/);
      }
    });

    it("blocks direct UPDATE on framework_agreement_revisions, delegation_template_revisions and agent_referrals_legal_profile_revisions", () => {
      const db = at0042();
      migrate(db);
      db.prepare(`INSERT INTO framework_agreement_revisions(id, revision, content_json, content_hash) VALUES ('f1', 1, '{}', 'h')`).run();
      db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash) VALUES ('d1', 1, 'FLEXPERIMENT_DELEGATED', '{}', 'h')`).run();
      db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES ('agent-guard', 'guard-agent', 'G', 'G Legal', 'g@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run();
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason)
        VALUES ('r1', 'agent-guard', 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'seed')`).run();

      expect(() => db.exec("UPDATE framework_agreement_revisions SET content_hash = 'x' WHERE id = 'f1'")).toThrow(/FRAMEWORK_AGREEMENT_REVISION_IMMUTABLE/);
      expect(() => db.exec("UPDATE delegation_template_revisions SET content_hash = 'x' WHERE id = 'd1'")).toThrow(/DELEGATION_TEMPLATE_REVISION_IMMUTABLE/);
      expect(() => db.exec("UPDATE agent_referrals_legal_profile_revisions SET reason = 'x' WHERE id = 'r1'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
    });

    it("blocks direct DELETE on framework_agreement_revisions, delegation_template_revisions and agent_referrals_legal_profile_revisions - immutable must also mean undeletable", () => {
      const db = at0042();
      migrate(db);
      db.prepare(`INSERT INTO framework_agreement_revisions(id, revision, content_json, content_hash) VALUES ('f1', 1, '{}', 'h')`).run();
      db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash) VALUES ('d1', 1, 'FLEXPERIMENT_DELEGATED', '{}', 'h')`).run();
      db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES ('agent-guard-2', 'guard-agent-2', 'G', 'G Legal', 'g2@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run();
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason)
        VALUES ('r1', 'agent-guard-2', 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'seed')`).run();

      expect(() => db.exec("DELETE FROM framework_agreement_revisions WHERE id = 'f1'")).toThrow(/FRAMEWORK_AGREEMENT_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM delegation_template_revisions WHERE id = 'd1'")).toThrow(/DELEGATION_TEMPLATE_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM agent_referrals_legal_profile_revisions WHERE id = 'r1'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM framework_agreement_revisions").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM delegation_template_revisions").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual({ n: 1 });
    });

    it("requires ord_reporting_mode = FLEXPERIMENT_DELEGATED on delegation_template_revisions", () => {
      const db = at0042();
      migrate(db);
      expect(() => db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash)
        VALUES ('bad', 1, 'SOMETHING_ELSE', '{}', 'h')`).run()).toThrow(/CHECK constraint failed/);
    });

    it("ad_channel_policy is append-only: direct UPDATE and DELETE on a historical row are both refused", () => {
      const db = at0042();
      migrate(db);
      // One of the nine seeded rows, standing in for "a historical policy revision".
      const seeded = db.prepare("SELECT id FROM ad_channel_policy WHERE channel_key = 'telegram' AND policy_revision = 1").get() as { id: string };

      expect(() => db.exec(`UPDATE ad_channel_policy SET status = 'BLOCKED' WHERE id = '${seeded.id}'`)).toThrow(/AD_CHANNEL_POLICY_REVISION_IMMUTABLE/);
      expect(() => db.exec(`DELETE FROM ad_channel_policy WHERE id = '${seeded.id}'`)).toThrow(/AD_CHANNEL_POLICY_REVISION_IMMUTABLE/);
      expect(db.prepare("SELECT status FROM ad_channel_policy WHERE id = ?").get(seeded.id)).toEqual({ status: "ALLOWED" });

      // A policy change is only ever a new INSERT.
      db.prepare(`INSERT INTO ad_channel_policy(id, channel_key, policy_revision, status, effective_from, reason)
        VALUES ('telegram-r2', 'telegram', 2, 'BLOCKED', '2026-01-01T00:00:00.000Z', 'later block')`).run();
      expect(db.prepare("SELECT status FROM ad_channel_policy WHERE channel_key = 'telegram' AND policy_revision = 1").get()).toEqual({ status: "ALLOWED" });
      expect(db.prepare("SELECT status FROM ad_channel_policy WHERE channel_key = 'telegram' AND policy_revision = 2").get()).toEqual({ status: "BLOCKED" });
    });
  });
});
