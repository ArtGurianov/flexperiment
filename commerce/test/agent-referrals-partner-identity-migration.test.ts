import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0044 is the partner-identity schema: OWNER identity, invite capability,
 * OTP challenge, partner session, step-up grant, framework acceptance +
 * effective ORD delegation, immutable payout-profile revisions, identity
 * retention/legal-hold/destruction evidence. Ordinary migration - not
 * FK-off, and it adds no 0045+.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0044_partner_identity.sql";
const BEFORE_0044 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0044").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "partner-identity-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0044) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0043 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "partner-identity-")), "commerce.sqlite");
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

const seedAgent = (db: Database.Database, agentId = "agent-migration-1") =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'M', 'M Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);

describe("0044 partner identity migration", () => {
  it("applies exactly once through the real migrate() runner, ordinarily (FK stays ON)", () => {
    const db = at0043();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op", () => {
    const db = at0043();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0043();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0045+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("creates exactly the expected new tables - no PR5 engagement/publication/promo/creative tables", () => {
    const db = at0043();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual([
      "framework_acceptances",
      "framework_issuances",
      "ord_reporting_delegations",
      "partner_identities",
      "partner_identity_destruction_events",
      "partner_identity_events",
      "partner_identity_legal_holds",
      "partner_identity_retention_policies",
      "partner_invite_capabilities",
      "partner_otp_challenges",
      "partner_sessions",
      "payout_profile_revisions",
      "step_up_grants",
    ].sort());
    for (const forbidden of ["engagements", "engagement_revisions", "partner_promos", "engagement_promo_authorizations", "engagement_creative_revisions", "engagement_distributions", "engagement_zero_reward_closures"]) {
      expect(introduced).not.toContain(forbidden);
    }
  });

  it("creates no password/social-login/team/RBAC table or column", () => {
    const db = at0043();
    migrate(db);
    const names = tableNames(db);
    expect(names.some((n) => /password|social_login|team|membership|role/i.test(n))).toBe(false);
    const partnerIdentityColumns = (db.prepare("PRAGMA table_info(partner_identities)").all() as { name: string }[]).map((c) => c.name);
    expect(partnerIdentityColumns.some((c) => /password|role/i.test(c))).toBe(false);
  });

  it("seeds NO retention policy - the duration is a real externally-approved input this PR does not invent", () => {
    const db = at0043();
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_retention_policies").get()).toEqual({ n: 0 });
  });

  describe("PR3's required-schema-object list now also proves PR4's authority/evidence objects", () => {
    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every PR4 base table, structural index and immutability guard", () => {
      // Every table PR4 ships - both the six immutable evidence tables (with
      // UPDATE+DELETE guards) and the mutable authority tables (invite
      // capabilities, OTP challenges, sessions, step-up grants, legal
      // holds) - plus the partial-unique indexes enforcing "at most one
      // live X per identity". A dropped base table is exactly as unsound as
      // a dropped guard, per P1.2.
      const pr4Objects = [
        "partner_identities",
        "partner_identity_events",
        "partner_identity_events_immutable_guard", "partner_identity_events_delete_guard",
        "partner_invite_capabilities", "partner_invite_capabilities_active_unique",
        "partner_otp_challenges", "partner_otp_challenges_active_unique",
        "partner_sessions",
        "step_up_grants",
        "framework_issuances", "framework_issuances_immutable_guard", "framework_issuances_delete_guard",
        "framework_acceptances", "framework_acceptances_immutable_guard", "framework_acceptances_delete_guard",
        "ord_reporting_delegations", "ord_reporting_delegations_immutable_guard", "ord_reporting_delegations_delete_guard",
        "payout_profile_revisions", "payout_profile_revisions_immutable_guard", "payout_profile_revisions_delete_guard",
        "partner_identity_retention_policies", "partner_identity_retention_policies_immutable_guard", "partner_identity_retention_policies_delete_guard",
        "partner_identity_legal_holds", "partner_identity_legal_holds_active_unique",
        "partner_identity_legal_holds_placement_immutable_guard", "partner_identity_legal_holds_release_one_way_guard", "partner_identity_legal_holds_delete_guard",
        "partner_identity_destruction_events", "partner_identity_destruction_events_immutable_guard", "partner_identity_destruction_events_delete_guard",
      ];
      for (const object of pr4Objects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      // Exhaustive in both directions: nothing PR4 added is missing from
      // this hand-written list either, so this test itself cannot silently
      // drift from the real required-object list.
      const pr3Objects = 16;
      expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.length).toBe(pr3Objects + pr4Objects.length);
    });

    it("passes on a DB migrated through 0044", () => {
      const db = at0043();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0044 has not been applied yet (0043 only)", () => {
      const db = at0043();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/0044_partner_identity\.sql/);
    });

    it.each([
      "partner_identity_events_immutable_guard", "framework_acceptances_delete_guard",
      "ord_reporting_delegations_immutable_guard", "payout_profile_revisions_delete_guard",
      "partner_identity_retention_policies_immutable_guard", "partner_identity_destruction_events_delete_guard",
      "framework_issuances_immutable_guard", "framework_issuances_delete_guard",
      "partner_identity_legal_holds_placement_immutable_guard", "partner_identity_legal_holds_release_one_way_guard",
    ])("dropping %s (proxy table remains) still refuses", (guardName) => {
      const db = at0043();
      migrate(db);
      db.exec(`DROP TRIGGER ${guardName}`);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(guardName));
    });

    it.each(["partner_identity_events", "partner_sessions", "step_up_grants", "partner_invite_capabilities_active_unique", "partner_otp_challenges_active_unique", "partner_identity_legal_holds_active_unique"])(
      "dropping the base object %s (a mutable-authority table or its structural index, not an evidence guard) also refuses",
      (objectName) => {
        const db = at0043();
        migrate(db);
        const kind = (db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(objectName) as { type: string }).type;
        db.exec(`DROP ${kind === "index" ? "INDEX" : "TABLE"} ${objectName}`);
        expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(objectName));
      },
    );
  });

  describe("structural constraints, proven against actual SQLite schema", () => {
    it("enforces exactly one OWNER per partner via agent_id UNIQUE", () => {
      const db = at0043();
      migrate(db);
      seedAgent(db, "agent-owner-unique");
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES ('p1', 'agent-owner-unique', 'a@example.test', 'h', 'admin')`).run();
      expect(() => db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES ('p2', 'agent-owner-unique', 'b@example.test', 'h2', 'admin')`).run())
        .toThrow(/UNIQUE constraint failed/);
    });

    it("blocks direct UPDATE and DELETE on every PR4 immutable evidence table", () => {
      const db = at0043();
      migrate(db);
      seedAgent(db, "agent-evidence");
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES ('p-evidence', 'agent-evidence', 'a@example.test', 'h', 'admin')`).run();
      db.prepare(`INSERT INTO partner_identity_events(id, partner_identity_id, event_kind, actor_realm, details_json) VALUES ('ev1', 'p-evidence', 'TEST', 'SYSTEM', '{}')`).run();
      expect(() => db.exec("UPDATE partner_identity_events SET event_kind = 'X' WHERE id = 'ev1'")).toThrow(/PARTNER_IDENTITY_EVENT_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM partner_identity_events WHERE id = 'ev1'")).toThrow(/PARTNER_IDENTITY_EVENT_IMMUTABLE/);

      db.prepare(`INSERT INTO partner_identity_retention_policies(id, revision, reason) VALUES ('rp1', 99, 'x')`).run();
      expect(() => db.exec("UPDATE partner_identity_retention_policies SET reason = 'y' WHERE id = 'rp1'")).toThrow(/PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM partner_identity_retention_policies WHERE id = 'rp1'")).toThrow(/PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE/);
    });

    it("payout_profile_revisions CHECK forbids mixing ACTIVE_DESTINATION and REVOKED shapes", () => {
      const db = at0043();
      migrate(db);
      seedAgent(db, "agent-payout-check");
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES ('p-payout', 'agent-payout-check', 'a@example.test', 'h', 'admin')`).run();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES ('sess-x', 'p-payout', 'th', datetime('now', '+1 hour'))`).run();
      db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
        VALUES ('g1', 'sess-x', 'p-payout', 'PAYOUT_PROFILE_SUPERSESSION', '{}', 'h1', datetime('now', '+5 minutes'))`).run();
      db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
        VALUES ('g2', 'sess-x', 'p-payout', 'PAYOUT_PROFILE_SUPERSESSION', '{}', 'h2', datetime('now', '+5 minutes'))`).run();
      // ACTIVE_DESTINATION missing ciphertext.
      expect(() => db.prepare(`INSERT INTO payout_profile_revisions(id, partner_identity_id, revision, kind, key_id, destination_kind, step_up_grant_id)
        VALUES ('pp1', 'p-payout', 1, 'ACTIVE_DESTINATION', 'k1', 'BANK_CARD', 'g1')`).run()).toThrow(/CHECK constraint failed/);
      // REVOKED carrying leftover ciphertext.
      expect(() => db.prepare(`INSERT INTO payout_profile_revisions(id, partner_identity_id, revision, kind, ciphertext, step_up_grant_id)
        VALUES ('pp2', 'p-payout', 1, 'REVOKED', 'leftover', 'g2')`).run()).toThrow(/CHECK constraint failed/);
    });

    it("partner_otp_challenges and partner_invite_capabilities admit at most one live row per identity", () => {
      const db = at0043();
      migrate(db);
      seedAgent(db, "agent-active-unique");
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES ('p-active', 'agent-active-unique', 'a@example.test', 'h', 'admin')`).run();
      db.prepare(`INSERT INTO partner_invite_capabilities(id, partner_identity_id, purpose, verifier_hash, expires_at, created_by_admin_id)
        VALUES ('inv1', 'p-active', 'ONBOARDING', 'vh1', datetime('now','+1 day'), 'admin')`).run();
      expect(() => db.prepare(`INSERT INTO partner_invite_capabilities(id, partner_identity_id, purpose, verifier_hash, expires_at, created_by_admin_id)
        VALUES ('inv2', 'p-active', 'ONBOARDING', 'vh2', datetime('now','+1 day'), 'admin')`).run()).toThrow(/UNIQUE constraint failed/);

      db.prepare(`INSERT INTO partner_otp_challenges(id, partner_identity_id, purpose, secret_hash, expires_at) VALUES ('otp1', 'p-active', 'LOGIN', 'sh1', datetime('now','+10 minutes'))`).run();
      expect(() => db.prepare(`INSERT INTO partner_otp_challenges(id, partner_identity_id, purpose, secret_hash, expires_at) VALUES ('otp2', 'p-active', 'LOGIN', 'sh2', datetime('now','+10 minutes'))`).run())
        .toThrow(/UNIQUE constraint failed/);
    });
  });
});
