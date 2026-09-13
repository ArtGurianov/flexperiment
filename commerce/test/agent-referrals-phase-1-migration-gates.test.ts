import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";

/**
 * The Phase 1 gates are proved inside the migration, not taken from an
 * operator snapshot, because the snapshot cannot bind the cutover: the BASE
 * runtime's legacy prepareSettlement() writes reward_settlements rows with no
 * settlement_flow - so they read as LEGACY - and sits behind no sales gate, so
 * it can invalidate either gate between the query and the migration.
 *
 * applyFkOffMigration runs the whole file in one BEGIN IMMEDIATE transaction,
 * so a writer either lands before the lock and is counted, or cannot interleave
 * before the DDL. These tests execute the real loader path and assert that a
 * violation leaves *nothing* changed.
 */

const MIGRATIONS = "commerce/migrations";
const PHASE_1_MIGRATION = "0058_agents_legal_identity_cleanup.sql";
const PHASE_1_SQL = readFileSync(join(MIGRATIONS, PHASE_1_MIGRATION), "utf8");

const temporary: string[] = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

/** Production's schema immediately before the cutover: everything under 0058. */
const beforePhase1 = () => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-phase1-migration-"));
  temporary.push(directory);
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < PHASE_1_MIGRATION)) {
    cpSync(join(MIGRATIONS, name), join(migrations, name));
  }
  const db = new Database(join(directory, "commerce.sqlite"));
  db.pragma("foreign_keys = ON");
  migrate(db, migrations);
  return { db, migrations };
};

/** Copies 0058 in and runs the real loader, exactly as a booting container would. */
const applyPhase1 = (db: Database.Database, migrations: string) => {
  cpSync(join(MIGRATIONS, PHASE_1_MIGRATION), join(migrations, PHASE_1_MIGRATION));
  migrate(db, migrations);
};

const applied = (db: Database.Database, version: string) =>
  Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const triggerExists = (db: Database.Database, name: string) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name));

const seedAgent = (db: Database.Database, id: string, slug: string) =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Legacy', 'Legacy LLC', 'a@b.c', 'SELF_EMPLOYED', '123456789012', 'K-1', 'PERCENT', 10)`).run(id, slug);

const seedLegacySettlement = (db: Database.Database, id: string, agentId: string) => {
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
    VALUES (?, ?, 'occ-1', 100, 'BANK', 'PREPARED', 'SELF_EMPLOYED', '2026-09-13T00:00:00Z', 'admin-1')`).run(id, agentId);
  db.pragma("foreign_keys = ON");
};

/** Every observable thing the migration would change, before it runs. */
const schemaFingerprint = (db: Database.Database) => ({
  ledger: applied(db, PHASE_1_MIGRATION),
  agentColumns: columns(db, "agents"),
  agentsProjectionGuard: triggerExists(db, "agents_contractor_type_projection_guard"),
  authorityTupleGuard: triggerExists(db, "reward_settlements_authority_tuple_consistency_guard"),
  immutableGuard: triggerExists(db, "reward_settlements_authority_columns_immutable_guard"),
  projectionGuard: triggerExists(db, "reward_settlements_contractor_type_projection_guard"),
  foreignKeys: db.pragma("foreign_keys", { simple: true }),
});

describe("Phase 1 migration gates are the cutover authority", () => {
  it("runs through the reviewed FK-off primitive, so the guards share the DDL's transaction", () => {
    // The race is closed by BEGIN IMMEDIATE inside applyFkOffMigration. That
    // only holds while this exact file is the registered FK-off migration.
    const digest = createHash("sha256").update(PHASE_1_SQL).digest("hex");
    expect(isFkOffMigration(PHASE_1_MIGRATION, digest)).toBe(true);
    expect(FK_OFF_MIGRATIONS.some((entry) => entry.filename === PHASE_1_MIGRATION && entry.sha256 === digest)).toBe(true);
    // Guards precede every destructive statement.
    const firstGuard = PHASE_1_SQL.indexOf("_phase_1_gate_1_guard");
    const firstDestructive = PHASE_1_SQL.search(/^(DROP|ALTER|CREATE TABLE agents_0058_new)/m);
    expect(firstGuard).toBeGreaterThan(-1);
    expect(firstGuard).toBeLessThan(firstDestructive);
    // And carry no remediation of their own.
    expect(PHASE_1_SQL.slice(0, firstDestructive)).not.toMatch(/UPDATE |DELETE |INSERT INTO reward_settlements|INSERT INTO agents/);
  });

  it("applies completely when both gates hold", () => {
    const { db, migrations } = beforePhase1();
    seedAgent(db, "ag-1", "clean");
    applyPhase1(db, migrations);
    expect(applied(db, PHASE_1_MIGRATION)).toBe(true);
    expect(columns(db, "agents")).not.toContain("contractor_type");
    expect(columns(db, "agents")).not.toContain("legal_name");
    expect(columns(db, "agents")).not.toContain("inn");
    expect(columns(db, "agents")).toContain("contract_reference");
    expect(triggerExists(db, "agents_contractor_type_projection_guard")).toBe(false);
    expect(triggerExists(db, "reward_settlements_authority_tuple_consistency_guard")).toBe(true);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM agents").get()).toEqual({ c: 1 });
    db.close();
  });

  it("Gate 1: a LEGACY settlement aborts the transition and changes nothing", () => {
    const { db, migrations } = beforePhase1();
    seedAgent(db, "ag-1", "legacy-one");
    seedLegacySettlement(db, "rs-1", "ag-1");
    const before = schemaFingerprint(db);

    expect(() => applyPhase1(db, migrations)).toThrow(/PHASE_1_GATE_1_LEGACY_SETTLEMENTS_PRESENT/);

    expect(schemaFingerprint(db)).toEqual(before);
    expect(applied(db, PHASE_1_MIGRATION)).toBe(false);
    expect(columns(db, "agents")).toContain("contractor_type");
    expect(db.pragma("foreign_keys", { simple: true }), "restored by the finally").toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM reward_settlements").get()).toEqual({ c: 1 });
    db.close();
  });

  it("Gate 1 counts a historical NULL flow, which is what the BASE runtime writes", () => {
    const { db, migrations } = beforePhase1();
    seedAgent(db, "ag-1", "legacy-null");
    // Exactly the shape legacy prepareSettlement() produces: no settlement_flow.
    seedLegacySettlement(db, "rs-1", "ag-1");
    expect(db.prepare("SELECT settlement_flow FROM reward_settlements WHERE id = 'rs-1'").get()).toEqual({ settlement_flow: null });
    expect(() => applyPhase1(db, migrations)).toThrow(/PHASE_1_GATE_1_LEGACY_SETTLEMENTS_PRESENT/);
    expect(applied(db, PHASE_1_MIGRATION)).toBe(false);
    db.close();
  });

  it("Gate 2: legacy exposure with no live current binding aborts the transition", () => {
    const { db, migrations } = beforePhase1();
    seedAgent(db, "ag-1", "unbound");
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks,
        occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, reward_authority_kind)
      VALUES ('ord-1', 'ps-1', 'FX-PHASE1GATE0000002', 'occ-1', 'Customer', 'c@d.e', 'hash', 500, 1, 'Studio: Lenina 1', 'rel-1', '{}', datetime('now'), 'LEGACY')`).run();
    db.prepare(`INSERT INTO referral_rewards(id, agent_id, order_id, occurrence_id, amount_kopecks, reward_authority_kind)
      VALUES ('rr-1', 'ag-1', 'ord-1', 'occ-1', 500, 'LEGACY')`).run();
    db.pragma("foreign_keys = ON");
    const before = schemaFingerprint(db);

    expect(() => applyPhase1(db, migrations)).toThrow(/PHASE_1_GATE_2_UNBOUND_LEGACY_AGENT/);

    expect(schemaFingerprint(db)).toEqual(before);
    expect(applied(db, PHASE_1_MIGRATION)).toBe(false);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

});
