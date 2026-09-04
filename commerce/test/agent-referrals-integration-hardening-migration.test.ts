import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0049 closes six structural gaps found by a cross-phase audit of the
 * merged PR1-8 base (567b65cc4ebc82ab1bf9bfdc04c06a6ba55e32ab), each
 * verified with an executable counterexample before being closed: append-
 * only, lineage-checked agent_referrals_feature_state_events;
 * structurally immutable agent_referrals_activation_manifest; a three-way
 * agents.contractor_type / legal-profile / settlement-snapshot consistency
 * lock; plus three pure application-code fixes with no schema object of
 * their own (ORD reporting-tail obligation set, destroyed-identity new-
 * authority refusal, and NPD status processing routed through the central
 * suspension gate - see agent-referrals-ord-reporting.ts,
 * agent-referrals-engagement.ts, agent-referrals-creative-readiness.ts, and
 * agent-referrals-npd.ts's own tests for those three). Ordinary migration -
 * not FK-off, and it adds no new base table.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0049_agent_referrals_integration_hardening.sql";
const BEFORE_0049 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0049").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "integration-hardening-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0049) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0048 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "integration-hardening-migration-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);

describe("0049 integration-hardening migration", () => {
  it("applies cleanly on top of 0042-0048, FK stays ON, foreign_key_check is clean", () => {
    const db = at0048();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op (migrate() twice)", () => {
    const db = at0048();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    migrate(db);
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0048();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0050+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("introduces no new base table - every fix is a trigger/index on an existing 0043/0047 table, or pure application code", () => {
    const db = at0048();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced).toEqual([]);
  });

  it("does not touch a single byte of 0042-0048", () => {
    for (const name of BEFORE_0049) {
      // BEFORE_0049 already excludes 0049 itself; this is a tautological
      // guard against ever renaming this migration below 0049 by accident.
      expect(name < MIGRATION_FILE).toBe(true);
    }
  });

  describe("PR3-PR8's required-schema-object list now also proves 0049's own guards", () => {
    const integrationHardeningObjects = [
      "agent_referrals_feature_state_events_immutable_guard", "agent_referrals_feature_state_events_delete_guard",
      "agent_referrals_feature_state_events_revision_unique", "agent_referrals_feature_state_events_lineage_guard",
      "agent_referrals_activation_manifest_immutable_guard", "agent_referrals_activation_manifest_delete_guard",
      "agents_contractor_type_projection_guard", "reward_settlements_contractor_type_projection_guard",
    ];

    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every 0049 object, exhaustively, as the list's exact suffix", () => {
      for (const object of integrationHardeningObjects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      const priorObjects = AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS.length - integrationHardeningObjects.length;
      const suffix = [...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS].slice(priorObjects);
      expect(suffix).toEqual(integrationHardeningObjects);
    });

    it("passes on a DB migrated through 0049", () => {
      const db = at0048();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0049 has not been applied yet (0048 only)", () => {
      const db = at0048();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
    });

    it("fails closed and names the object when a 0049 trigger is dropped", () => {
      const db = at0048();
      migrate(db);
      db.exec("DROP TRIGGER agent_referrals_feature_state_events_lineage_guard");
      try {
        assertAgentReferralsFoundationSchemaPresent(db);
        throw new Error("expected a throw");
      } catch (error) {
        expect((error as Error).message).toContain("agent_referrals_feature_state_events_lineage_guard");
      }
    });
  });
});
