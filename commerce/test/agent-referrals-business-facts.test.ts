import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS } from "../src/agent-referrals-activation";
import { agentReferralsBusinessFactEvidence, agentReferralsBusinessFactTables } from "../src/agent-referrals-business-facts";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-business-facts-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

/**
 * Independent re-derivation of "every base TABLE that migrations 0043-0048
 * create" and "every table one of those migrations pre-seeds with its own
 * INSERT", by parsing the migration SQL text directly - never trusting the
 * module under test's own filtering to prove itself correct. `0042` is
 * deliberately excluded from the created-table set: it only rebuilds the
 * pre-existing, cross-feature `agents` table (widening a CHECK constraint),
 * creates no new table, and its rebuilt table must never be treated as an
 * Agent Referrals business fact.
 */
const MIGRATIONS_DIR = join(process.cwd(), "commerce", "migrations");
const migrationFiles = () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^004[3-8]_.*\.sql$/.test(name)).sort();
  expect(files).toHaveLength(6); // 0043..0048 inclusive - fails loudly if a migration is ever renamed/added/removed
  return files;
};
const tablesCreatedByMigrationText = (): Set<string> => {
  const tables = new Set<string>();
  for (const file of migrationFiles()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const match of text.matchAll(/^CREATE TABLE\s+(\w+)/gm)) tables.add(match[1]);
  }
  return tables;
};
const tablesSeededByMigrationText = (): Set<string> => {
  const tables = new Set<string>();
  for (const file of migrationFiles()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const match of text.matchAll(/^INSERT INTO\s+(\w+)/gm)) tables.add(match[1]);
  }
  return tables;
};

describe("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS -> business-fact table derivation", () => {
  it("0042 creates no new table and its rebuilt `agents` table is never named in the required-schema-object list", () => {
    const text = readFileSync(join(MIGRATIONS_DIR, "0042_agent_referrals_agents_rebuild.sql"), "utf8");
    expect([...text.matchAll(/^CREATE TABLE\s+(\w+)/gm)].map((m) => m[1])).toEqual(["agents_0042_new"]);
    expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS as readonly string[]).not.toContain("agents");
  });

  it("filtering AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS to real tables, minus every migration-seeded table, reproduces exactly the tables 0043-0048 create", () => {
    const db = fresh();
    const created = tablesCreatedByMigrationText();
    const seeded = tablesSeededByMigrationText();
    expect(created.has("agent_referrals_feature_state")).toBe(true); // sanity: 0043 does create the singleton itself
    expect(seeded.has("agent_referrals_feature_state")).toBe(true); // and the migration does seed its one DORMANT row
    const derived = new Set(agentReferralsBusinessFactTables(db));
    for (const table of created) {
      if (seeded.has(table)) { expect(derived.has(table), `migration-seeded table wrongly treated as a business fact: ${table}`).toBe(false); continue; }
      expect(derived.has(table), `expected business-fact table missing: ${table}`).toBe(true);
    }
    // And nothing extra: every derived table really was created by 0043-0048, and none of them is migration-seeded.
    for (const table of derived) {
      expect(created.has(table), `unexpected business-fact table: ${table}`).toBe(true);
      expect(seeded.has(table), `business-fact table is migration-seeded and should be excluded: ${table}`).toBe(false);
    }
  });

  it("every table any 0043-0048 migration seeds is excluded from the business-fact set - the exclusion list cannot silently miss one", () => {
    const seeded = tablesSeededByMigrationText();
    const db = fresh();
    const derived = new Set(agentReferralsBusinessFactTables(db));
    for (const table of seeded) expect(derived.has(table), `migration-seeded table ${table} must be excluded`).toBe(false);
  });
});

describe("agentReferralsBusinessFactEvidence", () => {
  it("reports all_zero on a freshly migrated database with no Agent Referrals activity", () => {
    const db = fresh();
    const evidence = agentReferralsBusinessFactEvidence(db);
    expect(evidence.all_zero).toBe(true);
    expect(Object.keys(evidence.tables).length).toBeGreaterThan(30);
    expect(Object.values(evidence.tables).every((n) => n === 0)).toBe(true);
  });

  it("never counts the migration-seeded tables, even though they carry real post-migration rows", () => {
    const db = fresh();
    const singleton = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state").get() as { n: number };
    expect(singleton.n).toBe(1); // the seeded DORMANT row
    const channelPolicy = db.prepare("SELECT COUNT(*) AS n FROM ad_channel_policy").get() as { n: number };
    expect(channelPolicy.n).toBeGreaterThan(0);
    const reportingPeriodPolicy = db.prepare("SELECT COUNT(*) AS n FROM ord_reporting_period_policy").get() as { n: number };
    expect(reportingPeriodPolicy.n).toBeGreaterThan(0);
    const evidence = agentReferralsBusinessFactEvidence(db);
    expect(evidence.tables).not.toHaveProperty("agent_referrals_feature_state");
    expect(evidence.tables).not.toHaveProperty("ad_channel_policy");
    expect(evidence.tables).not.toHaveProperty("ord_reporting_period_policy");
    expect(evidence.all_zero).toBe(true); // seeded rows alone must never flip this false
  });

  it("flips all_zero to false and reports the exact nonzero count when a row lands in a table from an EARLY migration (0043)", () => {
    const db = fresh();
    db.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json) VALUES (?, ?)")
      .run("test-key", "{}");
    const evidence = agentReferralsBusinessFactEvidence(db);
    expect(evidence.all_zero).toBe(false);
    expect(evidence.tables.agent_referrals_activation_manifest).toBe(1);
    // every other table remains genuinely zero - one fact does not mask another.
    for (const [table, count] of Object.entries(evidence.tables)) {
      if (table !== "agent_referrals_activation_manifest") expect(count).toBe(0);
    }
  });

  it("also detects a fact in a table from a LATE migration (0048), proving coverage spans the full 0043-0048 range", () => {
    const db = fresh();
    db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, reason, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("rev-1", "COUNTERPARTY", 1, "{}", "0".repeat(64), "test", "admin-1");
    const evidence = agentReferralsBusinessFactEvidence(db);
    expect(evidence.all_zero).toBe(false);
    expect(evidence.tables.ord_provider_profile_revisions).toBe(1);
  });
});
