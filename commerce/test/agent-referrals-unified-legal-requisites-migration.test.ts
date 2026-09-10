import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { isFkOffMigration, migrate } from "../src/db";

/**
 * 0052 (PR-E) rebuilds agent_referrals_legal_profile_revisions AND
 * agent_referrals_legal_profile_change_requests to add the unified
 * requisites tuple (opf, full_name, short_name, inn, kpp,
 * registration_number, legal_address), and extends partner_identities'
 * mutable onboarding draft with matching submitted_* columns. It is the
 * THIRD FK-off migration (after 0042 and 0050), same rebuild hazard as
 * both.
 *
 * Deliberately clean-slate: a production read-only check (2026-09-10)
 * proved zero rows in agent_referrals_legal_profile_revisions, so unlike
 * 0050's "existing rows survive, backfilled" suite, there is nothing to
 * preserve here. Section B instead proves the fail-closed premise guard
 * itself - the executable form of that production evidence, not merely
 * today's one-off manual check.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0052_agent_referrals_unified_legal_requisites.sql";
const BEFORE_0052 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0052").sort();
const M0052_BYTES = readFileSync(join(MIGRATIONS, MIGRATION_FILE));
const M0052_SHA256 = createHash("sha256").update(M0052_BYTES).digest("hex");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "unified-legal-requisites-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0052) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0051 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "unified-legal-requisites-")), "commerce.sqlite");
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

/** Pre-0052 shape: exactly 0050's eleven columns, no requisites - those columns do not exist yet at 0051. */
const seedLegacyRevisionAt0051 = (db: Database.Database, opts: { id: string; agentId: string; revision: number }) => {
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason, assertion_source)
    VALUES (?, ?, ?, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'legacy seed', 'PARTNER_ASSERTED')`)
    .run(opts.id, opts.agentId, opts.revision);
};

/** Pre-0052 shape: exactly 0051's candidate columns, no requisites. */
const seedLegacyCandidateAt0051 = (db: Database.Database, opts: { id: string; partnerIdentityId: string; supersedesRevisionId: string }) => {
  db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests(id, partner_identity_id, legal_form, tax_mode, assertion_source, reason, supersedes_revision_id, created_by)
    VALUES (?, ?, 'INDIVIDUAL', 'NPD', 'PARTNER_ASSERTED', 'legacy seed', ?, 'admin')`)
    .run(opts.id, opts.partnerIdentityId, opts.supersedesRevisionId);
};

const seedPartnerIdentity = (db: Database.Database, opts: { id: string; agentId: string; legalProfileRevisionId: string }) => {
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id)
    VALUES (?, ?, 'p@example.test', 'h', ?, 'admin')`)
    .run(opts.id, opts.agentId, opts.legalProfileRevisionId);
};

const revisionsSql = (db: Database.Database): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_referrals_legal_profile_revisions'").get() as { sql: string }).sql;

/** A full requisites tuple accepted by LEGAL_ENTITY, for INSERT-time CHECK exercises. */
const legalEntityRequisites = {
  opf: "OOO", full_name: 'Общество с ограниченной ответственностью "Ромашка"', short_name: "OOO Romashka",
  inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "г. Москва, ул. Ленина, д. 1",
};

describe("0052 agent-referrals unified legal requisites migration", () => {
  it("is the exact committed file the registry pins", () => {
    expect(isFkOffMigration(MIGRATION_FILE, M0052_SHA256)).toBe(true);
  });

  describe("A. zero-legacy-rows premise guard", () => {
    it("succeeds when both tables are empty (the actual production premise)", () => {
      const { db } = at0051();
      migrate(db);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("aborts, with no partial state, when >=1 legacy revision row exists", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      seedLegacyRevisionAt0051(db, { id: "lp-1", agentId, revision: 1 });
      const beforeSql = revisionsSql(db);

      expect(() => migrate(db)).toThrow(/pr_e_migration_requires_zero_legacy_rows|CHECK constraint failed/);

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toBeUndefined();
      expect(revisionsSql(db)).toEqual(beforeSql);
      expect(revisionsSql(db)).not.toContain("full_name");
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_revisions").get()).toEqual({ n: 1 });
    });

    it("aborts, with no partial state, when >=1 candidate row exists (necessarily alongside its supersedes-target revision, per FK)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      seedLegacyRevisionAt0051(db, { id: "lp-1", agentId, revision: 1 });
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-1" });
      seedLegacyCandidateAt0051(db, { id: "cr-1", partnerIdentityId: partnerId, supersedesRevisionId: "lp-1" });
      const beforeSql = revisionsSql(db);

      expect(() => migrate(db)).toThrow();

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toBeUndefined();
      expect(revisionsSql(db)).toEqual(beforeSql);
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_change_requests").get()).toEqual({ n: 1 });
    });
  });

  describe("B. requisites CHECK semantics on the rebuilt revisions table", () => {
    it("accepts a valid LEGAL_ENTITY tuple", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, short_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-le', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', ?, ?, ?, ?, ?, ?, ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, legalEntityRequisites.opf, legalEntityRequisites.full_name, legalEntityRequisites.short_name,
          legalEntityRequisites.inn, legalEntityRequisites.kpp, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .not.toThrow();
    });

    it("accepts a valid INDIVIDUAL tuple (all optional requisites NULL)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-ind', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId))
        .not.toThrow();
    });

    it("accepts a valid INDIVIDUAL_ENTREPRENEUR tuple (registration_number required, address still NULL)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, reason, assertion_source)
        VALUES ('lp-ie', ?, 1, 'INDIVIDUAL_ENTREPRENEUR', 'NPD', 'INDIVIDUAL_ENTREPRENEUR', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId))
        .not.toThrow();
    });

    it("rejects INDIVIDUAL with a forbidden field present (registration_number)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, reason, assertion_source)
        VALUES ('lp-bad', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', '123456789012345', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects LEGAL_ENTITY with a missing mandatory field (opf NULL)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-no-opf', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', ?, ?, ?, ?, ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, legalEntityRequisites.full_name, legalEntityRequisites.inn, legalEntityRequisites.kpp, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects a blank (whitespace-only) full_name", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-blank-name', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', ?, '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, "\t  \n"))
        .toThrow(/CHECK constraint failed/);
    });

    it.each([
      ["too short", "12345678901"],
      ["too long", "1234567890123"],
      ["contains a non-digit", "12345678901a"],
    ])("rejects an INDIVIDUAL inn that is %s", (_label, inn) => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-bad-inn', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, inn))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects a LEGAL_ENTITY inn using the individual's 12-digit length instead of 10", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-le-12', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', ?, ?, '123456789012', ?, ?, ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, legalEntityRequisites.opf, legalEntityRequisites.full_name, legalEntityRequisites.kpp, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects a kpp that is not exactly 9 digits", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-bad-kpp', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', ?, ?, ?, '12345678', ?, ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, legalEntityRequisites.opf, legalEntityRequisites.full_name, legalEntityRequisites.inn, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .toThrow(/CHECK constraint failed/);
    });

    it("rejects an INDIVIDUAL_ENTREPRENEUR registration_number using the legal entity's 13-digit OGRN length instead of 15-digit OGRNIP", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, reason, assertion_source)
        VALUES ('lp-ie-13', ?, 1, 'INDIVIDUAL_ENTREPRENEUR', 'NPD', 'INDIVIDUAL_ENTREPRENEUR', 'Ivanov Ivan Ivanovich', '123456789012', '1234567890123', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId))
        .toThrow(/CHECK constraint failed/);
    });

    it.each([
      ["opf", "\t"],
      ["short_name", "\t"],
      ["legal_address", "\t"],
    ])("rejects a whitespace-only %s when present on LEGAL_ENTITY", (field, value) => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      const values = { ...legalEntityRequisites, [field]: value };
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, opf, full_name, short_name, inn, kpp, registration_number, legal_address, reason, assertion_source)
        VALUES ('lp-ws-field', ?, 1, 'LEGAL_ENTITY', 'OTHER', 'ORGANIZATION', ?, ?, ?, ?, ?, ?, ?, 'x', 'PARTNER_ASSERTED')`)
        .run(agentId, values.opf, values.full_name, values.short_name, values.inn, values.kpp, values.registration_number, values.legal_address))
        .toThrow(/CHECK constraint failed/);
    });

    it("still blocks direct UPDATE and DELETE (immutability triggers recreated after the rebuild)", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-guard', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId);
      expect(() => db.exec("UPDATE agent_referrals_legal_profile_revisions SET reason = 'x' WHERE id = 'lp-guard'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM agent_referrals_legal_profile_revisions WHERE id = 'lp-guard'")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE/);
    });
  });

  describe("C. requisites CHECK semantics mirrored on the recreated change_requests table", () => {
    it("accepts a valid LEGAL_ENTITY candidate and rejects the same missing-opf shape violation as the revisions table", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-seed', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId);
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-seed" });

      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, opf, full_name, short_name, inn, kpp, registration_number, legal_address, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-le', ?, 'LEGAL_ENTITY', 'OTHER', ?, ?, ?, ?, ?, ?, ?, 'PARTNER_ASSERTED', 'x', 'lp-seed', 'partner')`)
        .run(partnerId, legalEntityRequisites.opf, legalEntityRequisites.full_name, legalEntityRequisites.short_name,
          legalEntityRequisites.inn, legalEntityRequisites.kpp, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .not.toThrow();

      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, full_name, inn, kpp, registration_number, legal_address, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-le-no-opf', ?, 'LEGAL_ENTITY', 'OTHER', ?, ?, ?, ?, ?, 'PARTNER_ASSERTED', 'x', 'lp-seed', 'partner')`)
        .run(partnerId, legalEntityRequisites.full_name, legalEntityRequisites.inn, legalEntityRequisites.kpp, legalEntityRequisites.registration_number, legalEntityRequisites.legal_address))
        .toThrow(/CHECK constraint failed/);
    });

    it("the request-fields-immutable-guard also protects the seven new requisites columns", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-seed', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId);
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-seed" });
      db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, full_name, inn, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-1', ?, 'INDIVIDUAL', 'NPD', 'Ivanov Ivan Ivanovich', '123456789012', 'PARTNER_ASSERTED', 'x', 'lp-seed', 'partner')`)
        .run(partnerId);

      expect(() => db.exec("UPDATE agent_referrals_legal_profile_change_requests SET full_name = 'Someone Else' WHERE id = 'cr-1'"))
        .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE/);
      expect(() => db.exec("UPDATE agent_referrals_legal_profile_change_requests SET inn = '000000000000' WHERE id = 'cr-1'"))
        .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUPERSESSION_REQUEST_IMMUTABLE/);
    });

    it("the pending-unique index still allows at most one PENDING candidate per partner", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-seed', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId);
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-seed" });
      db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, full_name, inn, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-1', ?, 'INDIVIDUAL', 'NPD', 'Ivanov Ivan Ivanovich', '123456789012', 'PARTNER_ASSERTED', 'x', 'lp-seed', 'partner')`)
        .run(partnerId);
      expect(() => db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, full_name, inn, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-2', ?, 'INDIVIDUAL', 'NPD', 'Ivanov Ivan Ivanovich', '123456789012', 'PARTNER_ASSERTED', 'x', 'lp-seed', 'partner')`)
        .run(partnerId))
        .toThrow(/UNIQUE constraint failed/);
    });
  });

  describe("D. partner_identities onboarding draft extension", () => {
    it("adds the seven nullable submitted_* requisites columns without disturbing existing draft columns", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      // No legal_profile_revision_id here (still INVITED/PROFILE_SUBMITTED,
      // never verified) - deliberately, so this test does not itself trip
      // 0052's own zero-legacy-rows premise guard.
      const partnerId = randomUUID();
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'admin')`).run(partnerId, agentId);
      db.prepare("UPDATE partner_identities SET submitted_legal_form = 'INDIVIDUAL', submitted_tax_mode = 'NPD' WHERE id = ?").run(partnerId);

      migrate(db);

      const cols = new Set((db.prepare("PRAGMA table_info(partner_identities)").all() as { name: string }[]).map((c) => c.name));
      for (const col of ["submitted_opf", "submitted_full_name", "submitted_short_name", "submitted_inn", "submitted_kpp", "submitted_registration_number", "submitted_legal_address"]) {
        expect(cols, col).toContain(col);
      }
      const row = db.prepare("SELECT submitted_legal_form, submitted_tax_mode, submitted_opf, submitted_full_name FROM partner_identities WHERE id = ?").get(partnerId);
      expect(row).toEqual({ submitted_legal_form: "INDIVIDUAL", submitted_tax_mode: "NPD", submitted_opf: null, submitted_full_name: null });
    });

    it("the new draft columns accept an arbitrary partial write - no shape CHECK on the mutable draft", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      const partnerId = randomUUID();
      migrate(db);
      db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p2@example.test', 'h2', 'admin')`).run(partnerId, agentId);
      expect(() => db.prepare("UPDATE partner_identities SET submitted_full_name = ?, submitted_inn = ? WHERE id = ?").run("only a name, no inn yet", null, partnerId))
        .not.toThrow();
    });
  });

  describe("E. inbound FK topology survives, by exact table+column+target", () => {
    const expectedTopology: ReadonlyArray<{ table: string; from: string }> = [
      { table: "engagement_activation_events", from: "legal_profile_revision_id" },
      { table: "reward_settlements", from: "legal_profile_revision_id_snapshot" },
      { table: "partner_identities", from: "legal_profile_revision_id" },
      { table: "agent_referrals_legal_profile_change_requests", from: "supersedes_revision_id" },
      { table: "agent_referrals_legal_profile_change_requests", from: "resolved_legal_profile_revision_id" },
    ];

    it("has every expected foreign_key_list entry pointing at agent_referrals_legal_profile_revisions(id)", () => {
      const { db } = at0051();
      migrate(db);
      for (const { table, from } of expectedTopology) {
        const fks = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string; to: string }[])
          .filter((fk) => fk.from === from);
        expect(fks, `${table}.${from}`).toHaveLength(1);
        expect(fks[0], `${table}.${from}`).toMatchObject({ table: "agent_referrals_legal_profile_revisions", to: "id" });
      }
    });

    it("reports no violations via foreign_key_check with rows present across partner_identities and the candidate table", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      migrate(db);
      db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions
        (id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, reason, assertion_source)
        VALUES ('lp-1', ?, 1, 'INDIVIDUAL', 'NPD', 'SELF_EMPLOYED', 'Ivanov Ivan Ivanovich', '123456789012', 'x', 'PARTNER_ASSERTED')`)
        .run(agentId);
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-1" });
      db.prepare(`INSERT INTO agent_referrals_legal_profile_change_requests
        (id, partner_identity_id, legal_form, tax_mode, full_name, inn, assertion_source, reason, supersedes_revision_id, created_by)
        VALUES ('cr-1', ?, 'INDIVIDUAL', 'NPD', 'Ivanov Ivan Ivanovich', '123456789012', 'PARTNER_ASSERTED', 'x', 'lp-1', 'partner')`)
        .run(partnerId);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });
  });

  describe("F. FK state through the real migrate() runner", () => {
    it("goes ON -> OFF (internally) -> ON, with foreign_key_check empty after", () => {
      const { db } = at0051();
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      migrate(db);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });

    it("applies 0052 through the FK-off path, not the ordinary path", () => {
      const { db } = at0051();
      migrate(db);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
      expect(isFkOffMigration(MIGRATION_FILE, M0052_SHA256)).toBe(true);
    });

    it("replays as an exact no-op: FK remains ON, ledger unchanged, no re-execution", () => {
      const { db } = at0051();
      migrate(db);
      const afterFirst = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);

      expect(() => migrate(db)).not.toThrow();

      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(afterFirst);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    });
  });

  describe("G. registry binding and tamper resistance", () => {
    it("rejects the same filename with a wrong hash", () => {
      expect(isFkOffMigration(MIGRATION_FILE, "0".repeat(64))).toBe(false);
    });

    it("all three FK-off entries (0042, 0050, 0052) are present and independently correct", () => {
      for (const name of ["0042_agent_referrals_agents_rebuild.sql", "0050_agent_referrals_legal_profile_provenance_rebuild.sql"]) {
        const bytes = readFileSync(join(MIGRATIONS, name));
        expect(isFkOffMigration(name, createHash("sha256").update(bytes).digest("hex"))).toBe(true);
      }
      expect(isFkOffMigration(MIGRATION_FILE, M0052_SHA256)).toBe(true);
    });

    it("a one-byte-mutated 0052, same filename, is not treated as the privileged FK-off migration", () => {
      const { db } = at0051();
      const agentId = seedAgent(db);
      seedLegacyRevisionAt0051(db, { id: "lp-1", agentId, revision: 1 });
      const partnerId = randomUUID();
      seedPartnerIdentity(db, { id: partnerId, agentId, legalProfileRevisionId: "lp-1" });

      const tamperedDir = mkdtempSync(join(tmpdir(), "unified-legal-requisites-tampered-"));
      const mutated = Buffer.from(M0052_BYTES);
      const marker = Buffer.from("third FK-off migration");
      const offset = mutated.indexOf(marker);
      expect(offset).toBeGreaterThan(-1);
      mutated[offset] = "T".charCodeAt(0); // "third" -> "Third": still a valid SQL comment.
      writeFileSync(join(tamperedDir, MIGRATION_FILE), mutated);
      const mutatedSha256 = createHash("sha256").update(mutated).digest("hex");
      expect(mutatedSha256).not.toBe(M0052_SHA256);
      expect(isFkOffMigration(MIGRATION_FILE, mutatedSha256)).toBe(false);

      for (const name of BEFORE_0052) copyFileSync(join(MIGRATIONS, name), join(tamperedDir, name));

      // Unregistered hash -> ordinary (FK-enforced) path -> the same DROP
      // TABLE that succeeds with FK off fails outright with FK on, because
      // partner_identities (and the table's own self-reference) still
      // reference it.
      expect(() => migrate(db, tamperedDir)).toThrow();

      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toBeUndefined();
      expect(revisionsSql(db)).not.toContain("full_name");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  describe("H. no semantic drift in ANY pre-existing trigger that textually names the rebuilt table - not just the three known ones", () => {
    it("every pre-0052 trigger whose sql mentions agent_referrals_legal_profile_revisions is preserved byte-for-byte", () => {
      const { db } = at0051();
      const before = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%agent_referrals_legal_profile_revisions%'",
      ).all() as { name: string; sql: string }[];
      // A sanity floor, not a ceiling: at least the three cross-table guards
      // already known from 0050 must be present before we even migrate,
      // proving this discovery query itself is not vacuously empty.
      expect(before.length).toBeGreaterThanOrEqual(3);
      const beforeByName = new Map(before.map((t) => [t.name, t.sql]));

      migrate(db);

      for (const [name, sql] of beforeByName) {
        const after = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
        expect(after, `trigger ${name} must still exist after 0052`).toBeDefined();
        expect(after!.sql, `trigger ${name} must be byte-for-byte unchanged`).toEqual(sql);
      }
    });
  });
});
