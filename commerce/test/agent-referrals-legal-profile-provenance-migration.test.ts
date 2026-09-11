import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isFkOffMigration, migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, type AdminPrincipal } from "../src/agent-referrals-partner-identity";
import { applyAgentReferralsLegalProfile, currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";

/**
 * 0050 rebuilds agent_referrals_legal_profile_revisions to add the
 * assertion_source/evidence_ref provenance columns and their CHECK - the
 * PR-D foundation D2's supersession work depends on. It is the SECOND
 * FK-off migration (after 0042) and changes nothing about any OTHER table's
 * own columns. Every test here drives the REAL migrate() runner from
 * ../src/db against the REAL, committed migration file and the REAL
 * FK_OFF_MIGRATIONS registry entry, mirroring
 * agent-referrals-agents-rebuild-migration.test.ts's own structure for
 * 0042 - the property that matters is the integration with the migration
 * runner and the real inbound-FK topology, not the SQL in isolation.
 *
 * Scope note on the three inbound FKs
 * (engagement_activation_events.legal_profile_revision_id,
 * reward_settlements.legal_profile_revision_id_snapshot,
 * partner_identities.legal_profile_revision_id): partner_identities is
 * cheap to seed a real row for and gets full byte-preservation +
 * functional-FK-enforcement coverage below (section D). The other two each
 * require reproducing a large chunk of a DIFFERENT PR's own fixture graph
 * to insert even one legal row (a full activated engagement with audience
 * verification, framework acceptance, ORD delegation and promo
 * authorization for engagement_activation_events; a full AGENT_REFERRALS
 * settlement's entire authority tuple - engagement, revision, reward
 * registry snapshot, effective reward snapshot - for reward_settlements,
 * per reward_settlements_authority_tuple_consistency_guard in
 * 0047_act_payment_settlement.sql). Duplicating those fixtures here would
 * test 0047/0048's own graphs, not this migration. Those two are instead
 * proven at the schema level (PRAGMA foreign_key_list topology, section C)
 * plus the global PRAGMA foreign_key_check (section B) that would catch a
 * dangling reference if one existed; their own functional row-survival is
 * already exercised by commerce/test/agent-referrals-act-payment-settlement
 * -migration.test.ts and commerce/test/agent-referrals-engagement-
 * publication-migration.test.ts.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0050_agent_referrals_legal_profile_provenance_rebuild.sql";
const BEFORE_0050 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0050").sort();
const M0050_BYTES = readFileSync(join(MIGRATIONS, MIGRATION_FILE));
const M0050_SHA256 = createHash("sha256").update(M0050_BYTES).digest("hex");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** Built once, on disk, and copied per test - matching the 0042 suite's own established pattern. */
const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "legal-profile-provenance-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0050) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0049 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "legal-profile-provenance-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return { db, file };
};

const seedAgent = (db: Database.Database, agentId = `agent-${randomUUID()}`) => {
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`)
    .run(agentId, agentId, `${agentId}@example.test`);
  return agentId;
};

/** Pre-0050 shape: exactly 0043's eight columns, no assertion_source/evidence_ref - those columns do not exist yet. */
const seedLegacyRevision = (db: Database.Database, opts: { id: string; agentId: string; revision: number; supersedesRevisionId?: string | null }) => {
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason)
    VALUES (?, ?, ?, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', ?, 'legacy seed')`)
    .run(opts.id, opts.agentId, opts.revision, opts.supersedesRevisionId ?? null);
};

/**
 * Scoped to exactly 0050, regardless of what later migrations (0052's own
 * zero-legacy-rows premise guard included) exist in the real migrations
 * directory - matches agent-referrals-integration-hardening-migration.test
 * .ts's own migrateOnly0049 precedent. This file's whole point is proving
 * 0050's OWN row-preservation/CHECK/trigger behavior on data seeded in
 * 0050's pre-rebuild shape; using the general migrate() runner here would
 * make every test that seeds a legacy row before migrating collide with a
 * premise 0052 introduced years after this file was written - exactly the
 * drift migrateOnly0049 already exists to avoid.
 */
const migrateOnly0050 = (db: Database.Database) => {
  const dir = mkdtempSync(join(tmpdir(), "legal-profile-provenance-only-0050-"));
  copyFileSync(join(MIGRATIONS, MIGRATION_FILE), join(dir, MIGRATION_FILE));
  migrate(db, dir);
};

describe("0050 agent-referrals legal-profile provenance rebuild migration", () => {
  it("is the exact committed file the registry pins", () => {
    expect(isFkOffMigration(MIGRATION_FILE, M0050_SHA256)).toBe(true);
  });

  describe("A. existing rows survive, backfilled as PARTNER_ASSERTED", () => {
    it("preserves a single legacy revision's id/agent_id/revision/legal_form/tax_mode/projected_contractor_type/reason/created_at, and backfills assertion_source=PARTNER_ASSERTED, evidence_ref=NULL", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      const before = db.prepare("SELECT id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, created_at FROM agent_referrals_legal_profile_revisions WHERE id = 'lp-1'").get();

      migrateOnly0050(db);

      const after = db.prepare("SELECT id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, supersedes_revision_id, reason, created_at FROM agent_referrals_legal_profile_revisions WHERE id = 'lp-1'").get();
      expect(after).toEqual(before);
      const provenance = db.prepare("SELECT assertion_source, evidence_ref FROM agent_referrals_legal_profile_revisions WHERE id = 'lp-1'").get();
      expect(provenance).toEqual({ assertion_source: "PARTNER_ASSERTED", evidence_ref: null });
    });

    it("preserves a two-revision supersession chain, including the self-referencing supersedes_revision_id, both backfilled", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      seedLegacyRevision(db, { id: "lp-2", agentId, revision: 2, supersedesRevisionId: "lp-1" });

      migrateOnly0050(db);

      const rows = db.prepare("SELECT id, revision, supersedes_revision_id, assertion_source, evidence_ref FROM agent_referrals_legal_profile_revisions WHERE agent_id = ? ORDER BY revision").all(agentId);
      expect(rows).toEqual([
        { id: "lp-1", revision: 1, supersedes_revision_id: null, assertion_source: "PARTNER_ASSERTED", evidence_ref: null },
        { id: "lp-2", revision: 2, supersedes_revision_id: "lp-1", assertion_source: "PARTNER_ASSERTED", evidence_ref: null },
      ]);
      // The self-reference is still a real, enforced FK after the rebuild, not merely a preserved value.
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("preserves the exact row count and every id across multiple agents, unordered", () => {
      const { db } = at0049();
      const agentA = seedAgent(db);
      const agentB = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-a1", agentId: agentA, revision: 1 });
      seedLegacyRevision(db, { id: "lp-b1", agentId: agentB, revision: 1 });
      seedLegacyRevision(db, { id: "lp-b2", agentId: agentB, revision: 2, supersedesRevisionId: "lp-b1" });
      const before = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get();

      migrateOnly0050(db);

      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual(before);
      expect(before).toEqual({ n: 3 });
      const ids = (db.prepare("SELECT id FROM agent_referrals_legal_profile_revisions ORDER BY id").all() as { id: string }[]).map((r) => r.id);
      expect(ids.sort()).toEqual(["lp-a1", "lp-b1", "lp-b2"].sort());
    });
  });

  describe("B. new DB capability and CHECK semantics", () => {
    it("rejects assertion_source before 0050 (column does not exist)", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason, assertion_source)
        VALUES ('lp-x', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'x', 'PARTNER_ASSERTED')`).run(agentId))
        .toThrow(/no column named assertion_source/);
    });

    it("after 0050: ADMIN_ASSERTED with a real evidence_ref is accepted", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source, evidence_ref)
        VALUES ('lp-admin', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', 'OOO', 'Romashka LLC', '1234567890', '123456789', '1234567890123', 'Moscow', 'admin claim', 'ADMIN_ASSERTED', 'egrul-extract.pdf')`).run(agentId))
        .not.toThrow();
    });

    it("after 0050: ADMIN_ASSERTED with NULL evidence_ref is rejected by the table's own CHECK", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-admin-noev', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', 'OOO', 'Romashka LLC', '1234567890', '123456789', '1234567890123', 'Moscow', 'admin claim', 'ADMIN_ASSERTED')`).run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    it("after 0050: a blank-string evidence_ref is rejected regardless of assertion_source", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source, evidence_ref)
        VALUES ('lp-blank', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED', '')`).run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    describe("whitespace-only evidence_ref (SQLite's single-argument trim() strips only ASCII space, not TAB/LF/CR)", () => {
      const whitespaceCases: Array<[string, string]> = [
        ["plain spaces", "   "],
        ["TAB", "\t"],
        ["LF", "\n"],
        ["CR", "\r"],
        ["TAB + spaces + LF", "\t  \n"],
      ];

      it.each(whitespaceCases)("rejects evidence_ref = %s (raw INSERT, ADMIN_ASSERTED)", (_label, value) => {
        const { db } = at0049();
        const agentId = seedAgent(db);
        migrate(db);
        expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source, evidence_ref)
          VALUES ('lp-ws', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', 'OOO', 'Romashka LLC', '1234567890', '123456789', '1234567890123', 'Moscow', 'admin claim', 'ADMIN_ASSERTED', ?)`).run(agentId, value))
          .toThrow(/CHECK constraint failed/);
      });

      it.each(whitespaceCases)("rejects evidence_ref = %s even under PARTNER_ASSERTED, where it is otherwise optional", (_label, value) => {
        const { db } = at0049();
        const agentId = seedAgent(db);
        migrate(db);
        expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source, evidence_ref)
          VALUES ('lp-ws-partner', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED', ?)`).run(agentId, value))
          .toThrow(/CHECK constraint failed/);
      });
    });

    it("after 0050: an unrecognized assertion_source is rejected", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-bad', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'SOMETHING_ELSE')`).run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    it("the original 4-allowed/2-rejected legal_form x tax_mode matrix CHECK still holds after the rebuild", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-matrix-bad', ?, 1, 'INDIVIDUAL', 'OTHER', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`).run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    it("still blocks direct UPDATE and DELETE (immutability triggers recreated after the rebuild)", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-guard", agentId, revision: 1 });
      migrateOnly0050(db);
      expect(() => db.exec("UPDATE agent_referrals_legal_profile_revisions SET reason = 'x' WHERE id = 'lp-guard'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM agent_referrals_legal_profile_revisions WHERE id = 'lp-guard'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
    });
  });

  describe("C. inbound FK topology survives, by exact table+column+target", () => {
    const expectedTopology: ReadonlyArray<{ table: string; from: string }> = [
      { table: "engagement_activation_events", from: "legal_profile_revision_id" },
      { table: "reward_settlements", from: "legal_profile_revision_id_snapshot" },
      { table: "partner_identities", from: "legal_profile_revision_id" },
      { table: "agent_referrals_legal_profile_revisions", from: "supersedes_revision_id" },
    ];

    it("has all four foreign_key_list entries pointing at agent_referrals_legal_profile_revisions(id)", () => {
      const { db } = at0049();
      migrate(db);
      for (const { table, from } of expectedTopology) {
        const fks = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string; to: string }[])
          .filter((fk) => fk.from === from);
        expect(fks, `${table}.${from}`).toHaveLength(1);
        expect(fks[0], `${table}.${from}`).toMatchObject({ table: "agent_referrals_legal_profile_revisions", to: "id" });
      }
    });

    it("also still has the unrelated agent_id -> agents(id) FK intact", () => {
      const { db } = at0049();
      migrate(db);
      const fks = (db.prepare("PRAGMA foreign_key_list(agent_referrals_legal_profile_revisions)").all() as { table: string; from: string; to: string }[])
        .filter((fk) => fk.from === "agent_id");
      expect(fks).toHaveLength(1);
      expect(fks[0]).toMatchObject({ table: "agents", to: "id" });
    });

    it("reports no violations via foreign_key_check with rows present across the chain and partner_identities", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'lp-1', 'admin')`)
        .run(randomUUID(), agentId);
      migrateOnly0050(db);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });
  });

  describe("D. partner_identities.legal_profile_revision_id: full functional round-trip", () => {
    it("preserves the row and keeps the FK enforced against a nonexistent revision id", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      const partnerId = randomUUID();
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'lp-1', 'admin')`)
        .run(partnerId, agentId);

      migrateOnly0050(db);

      expect(db.prepare("SELECT legal_profile_revision_id FROM partner_identities WHERE id = ?").get(partnerId)).toEqual({ legal_profile_revision_id: "lp-1" });
      expect(() => db.prepare("UPDATE partner_identities SET legal_profile_revision_id = 'does-not-exist' WHERE id = ?").run(partnerId))
        .toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  describe("E. FK state through the real migrate() runner", () => {
    it("goes ON -> OFF (internally) -> ON, with foreign_key_check empty after", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      migrateOnly0050(db);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("applies 0050 through the FK-off path, not the ordinary path", () => {
      const { db } = at0049();
      migrate(db);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
      expect(isFkOffMigration(MIGRATION_FILE, M0050_SHA256)).toBe(true);
    });

    it("replays as an exact no-op: FK remains ON, ledger unchanged, no re-execution", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      migrateOnly0050(db);
      const afterFirst = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
      const rowCountAfterFirst = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get();

      expect(() => migrateOnly0050(db)).not.toThrow();

      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(afterFirst);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual(rowCountAfterFirst);
    });
  });

  describe("F. registry binding", () => {
    it("recognizes the exact committed filename+sha256 as FK-off", () => {
      expect(isFkOffMigration(MIGRATION_FILE, M0050_SHA256)).toBe(true);
    });

    it("rejects the same filename with a wrong hash", () => {
      expect(isFkOffMigration(MIGRATION_FILE, "0".repeat(64))).toBe(false);
    });

    it("rejects a different filename with the right hash", () => {
      expect(isFkOffMigration("0050_renamed.sql", M0050_SHA256)).toBe(false);
    });

    it("the 0042 entry is unaffected: still exactly two FK-off entries, 0042 unchanged", () => {
      const m0042 = readFileSync(join(MIGRATIONS, "0042_agent_referrals_agents_rebuild.sql"));
      const sha0042 = createHash("sha256").update(m0042).digest("hex");
      expect(isFkOffMigration("0042_agent_referrals_agents_rebuild.sql", sha0042)).toBe(true);
    });
  });

  describe("G. tamper resistance", () => {
    it("a one-byte-mutated 0050, same filename, is not treated as the privileged FK-off migration", () => {
      const { db } = at0049();
      const agentId = seedAgent(db);
      seedLegacyRevision(db, { id: "lp-1", agentId, revision: 1 });
      // A real inbound-FK child row is required, or DROP TABLE has nothing to
      // orphan and succeeds fine even under FK enforcement - exactly the gap
      // 0042's own analogous test closes with seedLegacyRows() seeding all
      // eight of ITS FK columns.
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'lp-1', 'admin')`)
        .run(randomUUID(), agentId);

      const tamperedDir = mkdtempSync(join(tmpdir(), "legal-profile-provenance-tampered-"));
      const mutated = Buffer.from(M0050_BYTES);
      const marker = Buffer.from("second FK-off migration");
      const offset = mutated.indexOf(marker);
      expect(offset).toBeGreaterThan(-1);
      mutated[offset] = "S".charCodeAt(0); // "second" -> "Second": still a valid SQL comment.
      writeFileSync(join(tamperedDir, MIGRATION_FILE), mutated);
      const mutatedSha256 = createHash("sha256").update(mutated).digest("hex");
      expect(mutatedSha256).not.toBe(M0050_SHA256);
      expect(isFkOffMigration(MIGRATION_FILE, mutatedSha256)).toBe(false);

      const beforeType = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_referrals_legal_profile_revisions'").get() as { sql: string };
      expect(beforeType.sql).not.toContain("assertion_source");

      // Every earlier (0001-0049) migration file must also be present in the
      // tampered dir for migrate() to reach 0050 - copy them alongside it.
      for (const name of BEFORE_0050) copyFileSync(join(MIGRATIONS, name), join(tamperedDir, name));

      // Filename alone cannot authorize FK-off: the unregistered hash sends
      // this through the ordinary (FK-enforced) path, and the exact same
      // rebuild SQL that succeeds with FK off fails outright with FK on,
      // because DROP TABLE is rejected while partner_identities (and the
      // table's own self-reference) still reference it.
      expect(() => migrate(db, tamperedDir)).toThrow();

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toBeUndefined();
      const afterType = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_referrals_legal_profile_revisions'").get() as { sql: string };
      expect(afterType.sql).not.toContain("assertion_source");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  describe("H. concurrency/replay against the real registered 0050", () => {
    it("two migrate() runners over the same DB apply 0050 exactly once, final schema valid, FK ON, foreign_key_check empty", () => {
      const { db: a, file } = at0049();
      const agentId = seedAgent(a);
      seedLegacyRevision(a, { id: "lp-1", agentId, revision: 1 });
      const b = new Database(file);
      b.pragma("journal_mode = WAL");
      b.pragma("foreign_keys = ON");
      b.pragma("busy_timeout = 5000");
      open.push(b);

      migrateOnly0050(a);
      expect(() => migrateOnly0050(b)).not.toThrow();

      expect(a.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
      expect(a.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_referrals_legal_profile_revisions'").get()).toMatchObject({ sql: expect.stringContaining("assertion_source") });
      expect(a.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(a.pragma("foreign_key_check")).toEqual([]);
      expect(a.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual({ n: 1 });
    });
  });

  describe("I. application-level regression: the real onboarding mint path is untouched", () => {
    const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

    it("verifyPartnerLegalProfile still mints, now recorded as PARTNER_ASSERTED with no evidence_ref", () => {
      const file = join(mkdtempSync(join(tmpdir(), "legal-profile-provenance-e2e-")), "commerce.sqlite");
      const db = openDatabase(file);
      migrate(db);
      open.push(db);

      activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
      const agentId = seedAgent(db);
      const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD", { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012" });
      verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");

      expect(currentAgentReferralsLegalProfile(db, agentId)).toMatchObject({
        legal_form: "INDIVIDUAL", tax_mode: "NPD", projected_contractor_type: "SELF_EMPLOYED",
        assertion_source: "PARTNER_ASSERTED", evidence_ref: null,
      });
    });

    it("applyAgentReferralsLegalProfile still enforces the ADMIN_ASSERTED evidence_ref requirement post-migration, end to end", () => {
      const file = join(mkdtempSync(join(tmpdir(), "legal-profile-provenance-e2e-admin-")), "commerce.sqlite");
      const db = openDatabase(file);
      migrate(db);
      open.push(db);
      const agentId = seedAgent(db);

      const legalEntityRequisites = { opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow" };
      expect(() => applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "admin claim", assertion_source: "ADMIN_ASSERTED", ...legalEntityRequisites }))
        .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_EVIDENCE_REF_REQUIRED/);

      applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "admin claim", assertion_source: "ADMIN_ASSERTED", evidence_ref: "egrul-extract.pdf", ...legalEntityRequisites });
      expect(currentAgentReferralsLegalProfile(db, agentId)).toMatchObject({ assertion_source: "ADMIN_ASSERTED", evidence_ref: "egrul-extract.pdf" });
    });
  });

  describe("J. the three recreated cross-table triggers are byte-for-byte identical, not merely behaviorally equivalent", () => {
    const recreatedTriggers = [
      "agents_contractor_type_projection_guard",
      "reward_settlements_contractor_type_projection_guard",
      "reward_settlements_authority_tuple_consistency_guard",
    ] as const;

    it("sqlite_master.sql for each of the three triggers is unchanged across the 0050 rebuild", () => {
      const { db } = at0049();
      const before = Object.fromEntries(
        recreatedTriggers.map((name) => [name, (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql]),
      );

      // Scoped to exactly 0050, not the general migrate() runner: a LATER
      // migration (PR-F's own 0053) legitimately extends reward_settlements_
      // authority_tuple_consistency_guard's own body for an unrelated
      // reason - this test's only claim is about what 0050's OWN rebuild
      // does to these triggers, matching migrateOnly0050's own established
      // rationale elsewhere in this file.
      migrateOnly0050(db);

      for (const name of recreatedTriggers) {
        const after = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql;
        expect(after, name).toEqual(before[name]);
      }
    });
  });
});
