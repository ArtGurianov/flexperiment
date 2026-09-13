import Database from "better-sqlite3";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db";

/**
 * The two Phase 1 production gates are STOP conditions, and a gate that cannot
 * fail proves nothing. These tests extract the exact SQL from the runbook - not
 * a copy of it - and run it against a real schema built from the production
 * migration set, so the documented query and the tested query cannot drift.
 *
 * Production is at head 0057; 0058 is what the cutover applies. The gates run
 * *before* that, so the schema here deliberately stops short of 0058, the same
 * partial-replay idiom the migration tests already use.
 */

const RUNBOOK = "docs/release/AGENT_REFERRALS_PHASE_1_RUNBOOK.md";
const MIGRATIONS = "commerce/migrations";
const PHASE_1_MIGRATION = "0058_agents_legal_identity_cleanup.sql";

const statement = (marker: string): string => {
  const source = readFileSync(RUNBOOK, "utf8");
  const match = new RegExp("```sql\\n-- " + marker + "\\n([\\s\\S]*?)```").exec(source);
  if (!match) throw new Error(`RUNBOOK_MISSING_STATEMENT: ${marker}`);
  return match[1].trim();
};

const temporary: string[] = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

/** Production's current schema: every migration strictly before 0058. */
const productionSchema = (): Database.Database => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-phase1-gate-"));
  temporary.push(directory);
  const migrations = join(directory, "migrations");
  mkdirSync(migrations);
  const applied = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name < PHASE_1_MIGRATION);
  for (const name of applied) cpSync(join(MIGRATIONS, name), join(migrations, name));
  const db = new Database(join(directory, "gate.sqlite"));
  db.pragma("foreign_keys = ON");
  migrate(db, migrations);
  expect(applied.at(-1)).toBe("0057_partner_invite_capability_head.sql");
  // Synthetic fixtures below reference occurrences/admins that are not seeded;
  // the gates are being judged on their own predicate, not on referential setup.
  db.pragma("foreign_keys = OFF");
  return db;
};

const rows = (db: Database.Database, sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

const legacyAgent = (db: Database.Database, id: string, slug: string) =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Legacy', 'Legacy LLC', 'a@b.c', 'SELF_EMPLOYED', '123456789012', 'K-1', 'PERCENT', 10)`).run(id, slug);

const legacySettlement = (db: Database.Database, id: string, agentId: string) =>
  db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
    VALUES (?, ?, 'occ-1', 100, 'BANK', 'PREPARED', 'SELF_EMPLOYED', '2026-09-13T00:00:00Z', 'admin-1')`).run(id, agentId);

const revision = (db: Database.Database, id: string, agentId: string, number: number, supersedes: string | null = null) =>
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, supersedes_revision_id, reason, assertion_source)
    VALUES (?, ?, ?, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivan Ivanov', '123456789012', ?, 'seed', 'PARTNER_ASSERTED')`).run(id, agentId, number, supersedes);

/** referral_rewards carries a trigger pinning its kind to the parent order's (0046:137). */
const legacyOrder = (db: Database.Database, id: string, kind: "LEGACY" | "ENGAGEMENT_SCOPED" = "LEGACY") =>
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks,
      occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, reward_authority_kind)
    VALUES (?, ?, ?, 'occ-1', 'Customer', 'c@d.e', 'hash', 500, 1, 'Studio: Lenina 1', 'rel-1', '{}', datetime('now'), ?)`)
    .run(id, `ps-${id}`, `FX-PHASE1${id.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.padEnd(20, "0").slice(0, 20), kind);

const identity = (db: Database.Database, id: string, agentId: string, revisionId: string | null) =>
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, onboarding_state, onboarding_revision, legal_profile_revision_id, created_by_admin_id)
    VALUES (?, ?, 'a@b.c', 'hash', 'PARTNER_ACTIVE', 1, ?, 'admin-1')`).run(id, agentId, revisionId);

describe("Phase 1 production gate queries", () => {
  it("are the exact statements the runbook publishes", () => {
    expect(statement("gate1")).toContain("FROM reward_settlements");
    expect(statement("gate1")).toContain("settlement_flow IS NOT 'AGENT_REFERRALS'");
    expect(statement("gate2")).toContain("FROM agents a");
    expect(statement("gate2")).toContain("pi.destroyed_at IS NULL");
    // Gate 2 must model the real consumer: prepareSettlement does not check
    // `enabled`, and a disabled agent can still hold unpaid legacy reward.
    expect(statement("gate2")).not.toContain("a.enabled");
  });

  it("both report zero against a clean production schema", () => {
    const db = productionSchema();
    expect(rows(db, statement("gate1"))).toEqual([]);
    expect(rows(db, statement("gate2"))).toEqual([]);
    db.close();
  });

  it("Gate 1 detects a historical LEGACY settlement, including a NULL flow", () => {
    const db = productionSchema();
    legacyAgent(db, "ag-1", "legacy-one");
    legacySettlement(db, "rs-1", "ag-1");
    expect(rows(db, statement("gate1"))).toHaveLength(1);
    db.prepare("UPDATE reward_settlements SET settlement_flow = NULL WHERE id = 'rs-1'").run();
    expect(rows(db, statement("gate1")), "a NULL flow is LEGACY, not exempt").toHaveLength(1);
    // Relabelling is not a remedy and the schema says so:
    // reward_settlements_authority_columns_immutable_guard (0047:174) refuses.
    expect(() => db.prepare("UPDATE reward_settlements SET settlement_flow = 'AGENT_REFERRALS' WHERE id = 'rs-1'").run())
      .toThrow(/REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE/);
    db.prepare("DELETE FROM reward_settlements WHERE id = 'rs-1'").run();
    expect(rows(db, statement("gate1"))).toEqual([]);
    db.close();
  });

  it("Gate 2 clears only for a live identity pointing at the current MAX revision", () => {
    const db = productionSchema();
    legacyAgent(db, "ag-1", "legacy-one");
    legacySettlement(db, "rs-1", "ag-1");

    expect(rows(db, statement("gate2")), "no binding at all").toHaveLength(1);

    revision(db, "lp-1", "ag-1", 1);
    identity(db, "pi-1", "ag-1", "lp-1");
    expect(rows(db, statement("gate2")), "live identity at MAX revision").toEqual([]);

    db.prepare("UPDATE partner_identities SET destroyed_at = '2026-09-13T00:00:00Z' WHERE id = 'pi-1'").run();
    expect(rows(db, statement("gate2")), "destroyed identity is not authority").toHaveLength(1);
    db.prepare("UPDATE partner_identities SET destroyed_at = NULL WHERE id = 'pi-1'").run();

    revision(db, "lp-2", "ag-1", 2, "lp-1");
    expect(rows(db, statement("gate2")), "pointer superseded by a newer revision").toHaveLength(1);
    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = 'lp-2' WHERE id = 'pi-1'").run();
    expect(rows(db, statement("gate2")), "pointer advanced to the new MAX").toEqual([]);

    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = NULL WHERE id = 'pi-1'").run();
    expect(rows(db, statement("gate2")), "identity with no pointer").toHaveLength(1);
    db.close();
  });

  it("Gate 2 ignores an agent with no legacy exposure, and a revision owned by someone else", () => {
    const db = productionSchema();
    legacyAgent(db, "ag-1", "no-exposure");
    expect(rows(db, statement("gate2")), "no exposure, nothing to gate").toEqual([]);

    legacyAgent(db, "ag-2", "exposed");
    legacySettlement(db, "rs-2", "ag-2");
    revision(db, "lp-other", "ag-1", 1);
    identity(db, "pi-2", "ag-2", "lp-other");
    expect(rows(db, statement("gate2")), "another agent's revision is not a binding").toHaveLength(1);
    db.close();
  });

  it("Gate 2 sees exposure through rewards and adjustments, not only settlements", () => {
    const db = productionSchema();

    // A LEGACY reward is exposure. The order's authority kind is immutable
    // (0046:110) and the reward's is pinned to it (0046:137), so each case
    // gets its own order rather than being mutated into shape.
    legacyAgent(db, "ag-1", "reward-exposed");
    legacyOrder(db, "ord-1", "LEGACY");
    db.prepare(`INSERT INTO referral_rewards(id, agent_id, order_id, occurrence_id, amount_kopecks, reward_authority_kind)
      VALUES ('rr-1', 'ag-1', 'ord-1', 'occ-1', 500, 'LEGACY')`).run();
    expect(rows(db, statement("gate2"))).toHaveLength(1);

    // A row predating 0046 carries a NULL kind, which 0046:125 defines as
    // LEGACY. Both of 0046's guards refuse to produce one today, so the only
    // faithful way to reconstruct that historical shape is to drop them for
    // this one insert - the gate must still count it.
    db.exec("DROP TRIGGER referral_rewards_authority_kind_matches_order_guard; DROP TRIGGER referral_rewards_authority_kind_immutable_guard");
    db.prepare("DELETE FROM referral_rewards WHERE id = 'rr-1'").run();
    db.prepare(`INSERT INTO referral_rewards(id, agent_id, order_id, occurrence_id, amount_kopecks, reward_authority_kind)
      VALUES ('rr-historical', 'ag-1', 'ord-1', 'occ-1', 500, NULL)`).run();
    expect(rows(db, statement("gate2")), "historical NULL reads as LEGACY").toHaveLength(1);

    // An engagement-scoped reward is the Agent Referrals flow, not exposure.
    // A real ENGAGEMENT_SCOPED order requires a whole engagement graph
    // (0046:76-82), which has its own invariant and its own tests; this gate
    // only reads reward_authority_kind, so the tuple guard is dropped rather
    // than satisfied with a fixture that would prove nothing about the gate.
    db.exec("DROP TRIGGER orders_authority_tuple_consistency_guard");
    legacyAgent(db, "ag-2", "engagement-scoped");
    legacyOrder(db, "ord-2", "ENGAGEMENT_SCOPED");
    db.prepare(`INSERT INTO referral_rewards(id, agent_id, order_id, occurrence_id, amount_kopecks, reward_authority_kind)
      VALUES ('rr-2', 'ag-2', 'ord-2', 'occ-1', 500, 'ENGAGEMENT_SCOPED')`).run();
    expect(rows(db, statement("gate2")).map((row) => row.slug)).toEqual(["reward-exposed"]);

    // An adjustment on a LEGACY order is exposure on its own.
    legacyAgent(db, "ag-3", "adjustment-exposed");
    db.prepare(`INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason)
      VALUES ('adj-1', 'ord-1', 'ag-3', 250, 'correction')`).run();
    expect(rows(db, statement("gate2")).map((row) => row.slug)).toEqual(["adjustment-exposed", "reward-exposed"]);
    db.close();
  });
});
