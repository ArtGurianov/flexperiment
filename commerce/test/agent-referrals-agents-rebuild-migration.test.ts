import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isFkOffMigration, migrate } from "../src/db";

/**
 * 0042 rebuilds `agents` so `contractor_type` admits `ORGANIZATION`. It is
 * the only FK-off migration and changes nothing else - not a single other
 * column, constraint, default, or existing row. Every test here drives the
 * REAL migrate() runner from ../src/db against the REAL, committed
 * migration file and the REAL FK_OFF_MIGRATIONS registry entry, never a
 * standalone `sqlite.exec(0042 sql)` - the property that matters is the
 * integration with PR1's migration runner, not the SQL in isolation.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0042_agent_referrals_agents_rebuild.sql";
const BEFORE_0042 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0042").sort();
const M0042_BYTES = readFileSync(join(MIGRATIONS, MIGRATION_FILE));
const M0042_SHA256 = createHash("sha256").update(M0042_BYTES).digest("hex");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/**
 * Replaying every pre-0042 migration per test tripped vitest's 5s default
 * intermittently on CI for the analogous 0041 suite (outbox-attempt-migration
 * .test.ts). The schema is identical each time, so it is built once, on
 * disk, and the file copied - matching that established pattern.
 */
const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "agents-rebuild-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0042) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0041 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agents-rebuild-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return { db, file };
};

/**
 * Seeds exactly the shape the plan requires: one SELF_EMPLOYED and one
 * INDIVIDUAL_ENTREPRENEUR legacy agent, plus a child row on every one of the
 * eight documented inbound FK columns
 * (promo_codes.agent_id, quotes.attributed_agent_id,
 * quotes.promo_agent_id_snapshot, orders.attributed_agent_id,
 * orders.promo_agent_id_snapshot, referral_rewards.agent_id,
 * reward_adjustments.agent_id, reward_settlements.agent_id), split across
 * both agents so neither survives the rebuild merely by accident.
 */
const seedLegacyRows = (db: Database.Database) => {
  const selfEmployedId = "agent-self-employed-0042";
  const individualEntrepreneurId = "agent-individual-entrepreneur-0042";
  const cityId = randomUUID();
  const legalReleaseId = randomUUID();
  const occurrenceId = randomUUID();
  const promoCodeId = randomUUID();
  const quoteId = randomUUID();
  const orderId = randomUUID();

  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at)
    VALUES (?, 'self-employed-0042', 'Self Employed Agent', 'Self Employed Legal', 'self-employed-0042@example.test', 'SELF_EMPLOYED', '123456789012', 'C-SE-0042', 1, 'PERCENT', 1000, '2026-08-01T00:00:00.000Z')`)
    .run(selfEmployedId);
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value)
    VALUES (?, 'individual-entrepreneur-0042', 'IE Agent', 'IE Legal', 'ie-0042@example.test', 'INDIVIDUAL_ENTREPRENEUR', '1234567890', 'C-IE-0042', 1, 'FIXED', 500)`)
    .run(individualEntrepreneurId);

  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'agents-rebuild-city', 'Agents rebuild city')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'agents-rebuild-release', datetime('now'), '{}', 1)").run(legalReleaseId);
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'Agents rebuild fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);

  // promo_codes.agent_id
  db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value)
    VALUES (?, ?, 'AGENTS0042', 'AGENTS0042', 'FIXED', 10)`).run(promoCodeId, selfEmployedId);

  // quotes.attributed_agent_id, quotes.promo_agent_id_snapshot
  db.prepare(`INSERT INTO quotes(id, occurrence_id, material_revision, legal_release_id, promo_id, attributed_agent_id, promo_agent_id_snapshot, price_kopecks, discount_kopecks, final_amount_kopecks, venue_disclosure, expires_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, 100, 10, 90, 'Studio: Lenina 1', '2030-01-01T00:00:00.000Z')`)
    .run(quoteId, occurrenceId, legalReleaseId, promoCodeId, selfEmployedId, individualEntrepreneurId);

  // orders.attributed_agent_id, orders.promo_agent_id_snapshot
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, attributed_agent_id, promo_agent_id_snapshot, reward_type_snapshot, reward_value_snapshot, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot)
    VALUES (?, 'agents-rebuild-status', 'FX-AGENTSREBUILD00001', ?, 'Buyer', 'buyer@example.test', 'hash', 90, 1, 'Studio: Lenina 1', ?, '{}', datetime('now'), ?, ?, 'PERCENT', 1000, 'AGENTS0042', 'FIXED', 10)`)
    .run(orderId, occurrenceId, legalReleaseId, selfEmployedId, individualEntrepreneurId);

  // referral_rewards.agent_id
  db.prepare(`INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks) VALUES (?, ?, ?, ?, 9)`)
    .run(randomUUID(), orderId, selfEmployedId, occurrenceId);

  // reward_adjustments.agent_id
  db.prepare(`INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason) VALUES (?, ?, ?, -2, 'TEST_ADJUSTMENT')`)
    .run(randomUUID(), orderId, selfEmployedId);

  // reward_settlements.agent_id
  db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
    VALUES (?, ?, ?, 90, 'TRANSFER', 'PREPARED', 'SELF_EMPLOYED', datetime('now'), 'admin-0042')`)
    .run(randomUUID(), selfEmployedId, occurrenceId);

  return { selfEmployedId, individualEntrepreneurId, cityId, legalReleaseId, occurrenceId, promoCodeId, quoteId, orderId };
};

const agentRow = (db: Database.Database, id: string) =>
  db.prepare(`SELECT id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled,
    default_reward_type, default_reward_value, npd_status_checked_at, created_at, updated_at FROM agents WHERE id = ?`).get(id);

describe("0042 agent-referrals agents rebuild migration", () => {
  it("is the exact committed file the registry pins", () => {
    // Sanity check binding this whole suite to the real bytes; if this
    // fails every other test in this file is exercising the wrong file.
    expect(isFkOffMigration(MIGRATION_FILE, M0042_SHA256)).toBe(true);
  });

  describe("A. existing rows survive exactly", () => {
    it("preserves the SELF_EMPLOYED agent row byte-for-byte", () => {
      const { db } = at0041();
      const { selfEmployedId } = seedLegacyRows(db);
      const before = agentRow(db, selfEmployedId);
      migrate(db);
      expect(agentRow(db, selfEmployedId)).toEqual(before);
      expect(before).toMatchObject({ contractor_type: "SELF_EMPLOYED" });
    });

    it("preserves the INDIVIDUAL_ENTREPRENEUR agent row byte-for-byte", () => {
      const { db } = at0041();
      const { individualEntrepreneurId } = seedLegacyRows(db);
      const before = agentRow(db, individualEntrepreneurId);
      migrate(db);
      expect(agentRow(db, individualEntrepreneurId)).toEqual(before);
      expect(before).toMatchObject({ contractor_type: "INDIVIDUAL_ENTREPRENEUR" });
    });

    it("preserves the exact row count", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      const before = db.prepare("SELECT COUNT(*) AS n FROM agents").get();
      migrate(db);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual(before);
      expect(before).toEqual({ n: 2 });
    });

    it("preserves every agent id and every listed column across all rows, unordered", () => {
      const { db } = at0041();
      const { selfEmployedId, individualEntrepreneurId } = seedLegacyRows(db);
      const columns = "id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at, created_at, updated_at";
      const before = db.prepare(`SELECT ${columns} FROM agents ORDER BY id`).all();
      migrate(db);
      expect(db.prepare(`SELECT ${columns} FROM agents ORDER BY id`).all()).toEqual(before);
      expect(before.map((row) => (row as { id: string }).id).sort()).toEqual([individualEntrepreneurId, selfEmployedId].sort());
    });
  });

  describe("B. new DB capability", () => {
    it("rejects ORGANIZATION before 0042", () => {
      const { db } = at0041();
      expect(() => db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES (?, 'org-before-0042', 'Org', 'Org Legal', 'org-before@example.test', 'ORGANIZATION', '1234567890', 'C-ORG', 'FIXED', 0)`).run(randomUUID()))
        .toThrow(/CHECK constraint failed/);
    });

    it("accepts ORGANIZATION after 0042 with otherwise-valid fields", () => {
      const { db } = at0041();
      migrate(db);
      const id = randomUUID();
      expect(() => db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES (?, 'org-after-0042', 'Org', 'Org Legal', 'org-after@example.test', 'ORGANIZATION', '1234567890', 'C-ORG', 'FIXED', 0)`).run(id))
        .not.toThrow();
      expect(db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(id)).toEqual({ contractor_type: "ORGANIZATION" });
    });

    it("still rejects an unrelated value after 0042", () => {
      const { db } = at0041();
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
        VALUES (?, 'invalid-after-0042', 'Invalid', 'Invalid Legal', 'invalid@example.test', 'SOME_OTHER_VALUE', '1234567890', 'C-INVALID', 'FIXED', 0)`).run(randomUUID()))
        .toThrow(/CHECK constraint failed/);
    });
  });

  describe("C. all eight inbound FKs survive", () => {
    const expectedTopology: ReadonlyArray<{ table: string; from: string }> = [
      { table: "promo_codes", from: "agent_id" },
      { table: "quotes", from: "attributed_agent_id" },
      { table: "quotes", from: "promo_agent_id_snapshot" },
      { table: "orders", from: "attributed_agent_id" },
      { table: "orders", from: "promo_agent_id_snapshot" },
      { table: "referral_rewards", from: "agent_id" },
      { table: "reward_adjustments", from: "agent_id" },
      { table: "reward_settlements", from: "agent_id" },
    ];

    it("has all eight foreign_key_list entries pointing at agents(id), by exact table+column", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      migrate(db);
      for (const { table, from } of expectedTopology) {
        const fks = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string; to: string }[])
          .filter((fk) => fk.from === from);
        expect(fks, `${table}.${from}`).toHaveLength(1);
        expect(fks[0], `${table}.${from}`).toMatchObject({ table: "agents", to: "id" });
      }
    });

    it("reports no violations via foreign_key_check", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      migrate(db);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("keeps every eight-column FK functionally enforced against a nonexistent agent", () => {
      const { db } = at0041();
      const { occurrenceId, orderId, promoCodeId, quoteId, legalReleaseId } = seedLegacyRows(db);
      migrate(db);
      db.pragma("foreign_keys = ON");
      const bogus = "does-not-exist";
      // promo_codes.agent_id
      expect(() => db.prepare("UPDATE promo_codes SET agent_id = ? WHERE id = ?").run(bogus, promoCodeId)).toThrow(/FOREIGN KEY constraint failed/);
      // quotes.attributed_agent_id, quotes.promo_agent_id_snapshot
      expect(() => db.prepare("UPDATE quotes SET attributed_agent_id = ? WHERE id = ?").run(bogus, quoteId)).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => db.prepare("UPDATE quotes SET promo_agent_id_snapshot = ? WHERE id = ?").run(bogus, quoteId)).toThrow(/FOREIGN KEY constraint failed/);
      // orders.attributed_agent_id, orders.promo_agent_id_snapshot
      expect(() => db.prepare("UPDATE orders SET attributed_agent_id = ? WHERE id = ?").run(bogus, orderId)).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => db.prepare("UPDATE orders SET promo_agent_id_snapshot = ? WHERE id = ?").run(bogus, orderId)).toThrow(/FOREIGN KEY constraint failed/);
      // referral_rewards.agent_id - a second, distinct order, since order_id is UNIQUE on referral_rewards
      // and the seeded order already owns one.
      const secondOrderId = randomUUID();
      db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
        VALUES (?, 'agents-rebuild-status-2', 'FX-AGENTSREBUILD00002', ?, 'Buyer 2', 'buyer2@example.test', 'hash2', 90, 1, 'Studio: Lenina 1', ?, '{}', datetime('now'))`)
        .run(secondOrderId, occurrenceId, legalReleaseId);
      expect(() => db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks) VALUES (?, ?, ?, ?, 1)")
        .run(randomUUID(), secondOrderId, bogus, occurrenceId)).toThrow(/FOREIGN KEY constraint failed/);
      // reward_adjustments.agent_id
      expect(() => db.prepare("INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason) VALUES (?, ?, ?, 1, 'r')")
        .run(randomUUID(), orderId, bogus)).toThrow(/FOREIGN KEY constraint failed/);
      // reward_settlements.agent_id
      expect(() => db.prepare("INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id) VALUES (?, ?, ?, 1, 'TRANSFER', 'PREPARED', 'SELF_EMPLOYED', datetime('now'), 'admin')")
        .run(randomUUID(), bogus, occurrenceId)).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe("D. FK state through the real migrate() runner", () => {
    it("goes ON -> OFF (internally) -> ON, with foreign_key_check empty after", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      migrate(db);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("applies 0042 through the FK-off path, not the ordinary path", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      migrate(db);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
      expect(isFkOffMigration(MIGRATION_FILE, M0042_SHA256)).toBe(true);
    });

    it("replays as an exact no-op: FK remains ON, ledger unchanged, no re-execution", () => {
      const { db } = at0041();
      seedLegacyRows(db);
      migrate(db);
      const afterFirst = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
      const rowCountAfterFirst = db.prepare("SELECT COUNT(*) AS n FROM agents").get();

      expect(() => migrate(db)).not.toThrow();

      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(afterFirst);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual(rowCountAfterFirst);
    });
  });

  describe("E. registry binding", () => {
    it("recognizes the exact committed filename+sha256 as FK-off", () => {
      expect(isFkOffMigration(MIGRATION_FILE, M0042_SHA256)).toBe(true);
    });

    it("rejects the same filename with a wrong hash", () => {
      expect(isFkOffMigration(MIGRATION_FILE, "0".repeat(64))).toBe(false);
    });

    it("rejects a different filename with the right hash", () => {
      expect(isFkOffMigration("0042_renamed.sql", M0042_SHA256)).toBe(false);
    });
  });

  describe("F. tamper resistance", () => {
    it("a one-byte-mutated 0042, same filename, is not treated as the privileged FK-off migration", () => {
      const { db } = at0041();
      seedLegacyRows(db);

      const tamperedDir = mkdtempSync(join(tmpdir(), "agents-rebuild-tampered-"));
      const mutated = Buffer.from(M0042_BYTES);
      // Flip one byte INSIDE the comment prose, never the leading `--`
      // marker itself - mutating byte 0 (the first `-`) breaks the comment
      // syntax outright, so the file fails to parse as SQL at all and the
      // "rejected" assertion below would pass for the wrong reason (a syntax
      // error, not the FK-enforced DROP TABLE failure this test exists to
      // prove). The executable SQL below the comment block must stay valid
      // and unchanged, or a syntax error would again mask the real property.
      const marker = Buffer.from("The only FK-off migration");
      const offset = mutated.indexOf(marker);
      expect(offset).toBeGreaterThan(-1);
      mutated[offset] = "t".charCodeAt(0); // "The" -> "the": still a valid SQL comment.
      writeFileSync(join(tamperedDir, MIGRATION_FILE), mutated);
      const mutatedSha256 = createHash("sha256").update(mutated).digest("hex");
      expect(mutatedSha256).not.toBe(M0042_SHA256);
      expect(isFkOffMigration(MIGRATION_FILE, mutatedSha256)).toBe(false);

      const beforeCheckType = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get() as { sql: string };
      expect(beforeCheckType.sql).toContain("'SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR')");

      // Filename alone cannot authorize FK-off: the unregistered hash sends
      // this through the ordinary (FK-enforced) path, and the exact same
      // rebuild SQL that succeeds with FK off fails outright with FK on,
      // because DROP TABLE agents is rejected while other tables still
      // reference it. No specific error code is asserted - only that it is
      // rejected and nothing changes.
      expect(() => migrate(db, tamperedDir)).toThrow();

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toBeUndefined();
      const afterCheckType = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get() as { sql: string };
      expect(afterCheckType.sql).toContain("'SELF_EMPLOYED', 'INDIVIDUAL_ENTREPRENEUR')");
      expect(afterCheckType.sql).not.toContain("ORGANIZATION");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  describe("G. concurrency/replay against the real registered 0042", () => {
    it("two migrate() runners over the same DB apply 0042 exactly once, final schema valid, FK ON, foreign_key_check empty", () => {
      const { db: a, file } = at0041();
      seedLegacyRows(a);
      const b = new Database(file);
      b.pragma("journal_mode = WAL");
      b.pragma("foreign_keys = ON");
      b.pragma("busy_timeout = 5000");
      open.push(b);

      // Matches PR1's established deterministic concurrency pattern
      // (db-migrate.test.ts): the correctness property under test is that
      // the second runner's ledger re-check happens inside its own acquired
      // BEGIN IMMEDIATE, not that the two calls are wall-clock simultaneous.
      migrate(a);
      expect(() => migrate(b)).not.toThrow();

      expect(a.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
      expect(a.prepare("SELECT sql FROM sqlite_master WHERE name = 'agents'").get()).toMatchObject({ sql: expect.stringContaining("ORGANIZATION") });
      expect(a.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(a.pragma("foreign_key_check")).toEqual([]);
      expect(a.prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 2 });
    });
  });
});
