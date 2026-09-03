import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0045 is the engagement/publication schema: audience verification,
 * engagement identity/revision/acceptance/activation, permanent promo +
 * per-occurrence authorizations, creative content + authorization,
 * distribution facts + removal lifecycle, delegation revocation,
 * engagement closure. Ordinary migration - not FK-off, and it adds no
 * 0046+.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0045_engagement_publication.sql";
const BEFORE_0045 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0045").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "engagement-publication-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0045) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0044 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "engagement-publication-")), "commerce.sqlite");
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

const seedAgent = (db: Database.Database, agentId = "agent-engagement-1") =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'M', 'M Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);

const seedPartner = (db: Database.Database, partnerId = "partner-1", agentId = "agent-engagement-1") =>
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'a@example.test', 'h', 'admin')`).run(partnerId, agentId);

const seedOccurrence = (db: Database.Database, occurrenceId = "occ-1") => {
  const cityId = "city-1";
  db.prepare("INSERT OR IGNORE INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return cityId;
};

const seedEngagement = (db: Database.Database, engagementId = "eng-1", partnerId = "partner-1", occurrenceId = "occ-1") =>
  db.prepare(`INSERT INTO engagements(id, partner_identity_id, occurrence_id, created_by_admin_id) VALUES (?, ?, ?, 'admin')`).run(engagementId, partnerId, occurrenceId);

const seedEngagementRevision = (db: Database.Database, revisionId = "rev-1", engagementId = "eng-1", revision = 1) =>
  db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
    VALUES (?, ?, ?, 1, 'PERCENT', 1000, 'PERCENT', 1000, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`)
    .run(revisionId, engagementId, revision);

describe("0045 engagement publication migration", () => {
  it("applies exactly once through the real migrate() runner, ordinarily (FK stays ON)", () => {
    const db = at0044();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op", () => {
    const db = at0044();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0044();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0046+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("0045 alone introduces exactly the expected new tables - no PR6 order/reward/settlement table", () => {
    const db = at0044();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual([
      "engagement_acceptances",
      "engagement_activation_events",
      "engagement_closure_events",
      "engagement_creative_authorizations",
      "engagement_creative_revisions",
      "engagement_distribution_events",
      "engagement_distribution_revisions",
      "engagement_distributions",
      "engagement_promo_authorizations",
      "engagement_revisions",
      "engagement_step_up_grants",
      "engagements",
      "ord_reporting_delegation_revocations",
      "partner_audience_verification_events",
      "partner_promos",
    ].sort());
    for (const forbidden of [
      "engagement_reward_registry_snapshot", "engagement_effective_reward_snapshots", "settlement_flow", "acts", "reward_adjustments_v2",
      "ord_creative_registrations", "ord_distribution_period_reports", "engagement_zero_reward_closures",
    ]) {
      expect(introduced).not.toContain(forbidden);
    }
  });

  it("creates no password/social-login/team/RBAC/capacity table or column", () => {
    const db = at0044();
    migrate(db);
    const names = tableNames(db);
    expect(names.some((n) => /password|social_login|team|membership|role|capacity_pilot/i.test(n))).toBe(false);
  });

  describe("PR3+PR4's required-schema-object list now also proves PR5's authority/evidence objects", () => {
    const pr5Objects = [
      "partner_audience_verification_events", "partner_audience_verification_events_immutable_guard", "partner_audience_verification_events_delete_guard",
      "engagements",
      "engagement_revisions", "engagement_revisions_immutable_guard", "engagement_revisions_delete_guard",
      "engagement_step_up_grants",
      "engagement_acceptances", "engagement_acceptances_immutable_guard", "engagement_acceptances_delete_guard",
      "partner_promos", "partner_promos_immutable_guard", "partner_promos_delete_guard",
      "engagement_promo_authorizations", "engagement_promo_authorizations_current_unique",
      "engagement_promo_authorizations_placement_immutable_guard", "engagement_promo_authorizations_revoke_one_way_guard", "engagement_promo_authorizations_delete_guard",
      "engagement_activation_events", "engagement_activation_events_immutable_guard", "engagement_activation_events_delete_guard",
      "engagement_creative_revisions", "engagement_creative_revisions_immutable_guard", "engagement_creative_revisions_delete_guard",
      "engagement_creative_authorizations", "engagement_creative_authorizations_current_unique",
      "engagement_creative_authorizations_placement_immutable_guard", "engagement_creative_authorizations_revoke_one_way_guard", "engagement_creative_authorizations_delete_guard",
      "engagement_distributions",
      "engagement_distribution_revisions", "engagement_distribution_revisions_immutable_guard", "engagement_distribution_revisions_delete_guard",
      "engagement_distribution_events", "engagement_distribution_events_immutable_guard", "engagement_distribution_events_delete_guard",
      "ord_reporting_delegation_revocations", "ord_reporting_delegation_revocations_immutable_guard", "ord_reporting_delegation_revocations_delete_guard",
      "engagement_closure_events", "engagement_closure_events_immutable_guard", "engagement_closure_events_delete_guard",
    ];

    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every PR5 base table, structural index and immutability guard, exhaustively", () => {
      for (const object of pr5Objects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      const pr3Plus4Objects = 49; // 16 (PR3) + 33 (PR4), proven exhaustive by that PR's own migration test.
      const suffix = [...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS].slice(pr3Plus4Objects).sort();
      expect(suffix).toEqual([...pr5Objects].sort());
    });

    it("passes on a DB migrated through 0045", () => {
      const db = at0044();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0045 has not been applied yet (0044 only)", () => {
      const db = at0044();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/0045_engagement_publication\.sql/);
    });

    it.each([
      "partner_audience_verification_events_immutable_guard", "engagement_revisions_delete_guard",
      "engagement_acceptances_immutable_guard", "partner_promos_delete_guard",
      "engagement_promo_authorizations_placement_immutable_guard", "engagement_promo_authorizations_revoke_one_way_guard",
      "engagement_activation_events_immutable_guard", "engagement_creative_revisions_delete_guard",
      "engagement_creative_authorizations_placement_immutable_guard", "engagement_creative_authorizations_revoke_one_way_guard",
      "engagement_distribution_revisions_immutable_guard", "engagement_distribution_events_delete_guard",
      "ord_reporting_delegation_revocations_immutable_guard", "engagement_closure_events_delete_guard",
    ])("dropping %s (proxy table remains) still refuses", (guardName) => {
      const db = at0044();
      migrate(db);
      db.exec(`DROP TRIGGER ${guardName}`);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(guardName));
    });

    it.each(["engagements", "engagement_step_up_grants", "engagement_distributions", "engagement_promo_authorizations_current_unique", "engagement_creative_authorizations_current_unique"])(
      "dropping the base object %s (a mutable-authority table, identity table, or structural index, not an evidence guard) also refuses",
      (objectName) => {
        const db = at0044();
        migrate(db);
        const kind = (db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(objectName) as { type: string }).type;
        db.exec(`DROP ${kind === "index" ? "INDEX" : "TABLE"} ${objectName}`);
        expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(objectName));
      },
    );
  });

  describe("structural constraints, proven against actual SQLite schema", () => {
    it("blocks direct UPDATE and DELETE on every PR5 immutable evidence table", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
        VALUES ('rev1', 'eng-1', 1, 1, 'PERCENT', 1000, 'PERCENT', 1000, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`).run();
      expect(() => db.exec("UPDATE engagement_revisions SET reward_value = 2000 WHERE id = 'rev1'")).toThrow(/ENGAGEMENT_REVISION_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM engagement_revisions WHERE id = 'rev1'")).toThrow(/ENGAGEMENT_REVISION_IMMUTABLE/);

      db.prepare(`INSERT INTO partner_audience_verification_events(id, partner_identity_id, city_id, aggregate_revision, event_kind, valid_until, evidence_ref, reason, placed_by_admin_id)
        VALUES ('av1', 'partner-1', 'city-1', 1, 'VERIFIED', '2040-01-01T00:00:00.000Z', 'ev', 'r', 'admin')`).run();
      expect(() => db.exec("UPDATE partner_audience_verification_events SET event_kind = 'REVOKED' WHERE id = 'av1'")).toThrow(/PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM partner_audience_verification_events WHERE id = 'av1'")).toThrow(/PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE/);
    });

    it("engagement_promo_authorizations: placement fields are immutable, release is one-way, and at most one current row exists per (promo, occurrence)", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      seedEngagementRevision(db);
      db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES ('promo-1', 'agent-engagement-1', 'ART', 'ART', 'NONE', 0)`).run();
      db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES ('pp1', 'promo-1', 'agent-engagement-1', 'admin')`).run();
      db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, sequence)
        VALUES ('auth1', 'promo-1', 'agent-engagement-1', 'occ-1', 'eng-1', 'rev-1', 1)`).run();

      expect(() => db.exec("UPDATE engagement_promo_authorizations SET occurrence_id = 'occ-2' WHERE id = 'auth1'")).toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_PLACEMENT_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM engagement_promo_authorizations WHERE id = 'auth1'")).toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_IMMUTABLE/);

      const secondOccurrence = "occ-2";
      db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
        VALUES (?, 'city-1', 'FLEXPERIMENT 2', '2030-11-01T10:00:00.000Z', '2030-11-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(secondOccurrence);
      // A second CURRENT authorization for the SAME (promo, occurrence) pair is refused - the partial unique index.
      expect(() => db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, sequence)
        VALUES ('auth2', 'promo-1', 'agent-engagement-1', 'occ-1', 'eng-1', 'rev-1', 2)`).run()).toThrow(/UNIQUE constraint failed/);
      // A DIFFERENT occurrence for the SAME promo is fine - no bare UNIQUE(promo_code_id) exists.
      expect(() => db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, sequence)
        VALUES ('auth3', 'promo-1', 'agent-engagement-1', ?, 'eng-1', 'rev-1', 2)`).run(secondOccurrence)).not.toThrow();

      db.prepare("UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'x' WHERE id = 'auth1'").run();
      expect(() => db.exec("UPDATE engagement_promo_authorizations SET revoked_reason = 'y' WHERE id = 'auth1'")).toThrow(/ENGAGEMENT_PROMO_AUTHORIZATION_ALREADY_REVOKED/);
    });

    it("partner_promos: both promo_code_id and partner_id are UNIQUE - one partner cannot mint a second code, and one code cannot bind to a second partner", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db, "agent-a");
      seedAgent(db, "agent-b");
      db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES ('promo-a', 'agent-a', 'ART', 'ART', 'NONE', 0)`).run();
      db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES ('promo-a2', 'agent-a', 'ART2', 'ART2', 'NONE', 0)`).run();
      db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES ('pp1', 'promo-a', 'agent-a', 'admin')`).run();
      // Same partner, a second code: refused (UNIQUE(partner_id)).
      expect(() => db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES ('pp2', 'promo-a2', 'agent-a', 'admin')`).run()).toThrow(/UNIQUE constraint failed/);
      // Same code, a second (different) partner: refused (UNIQUE(promo_code_id)).
      expect(() => db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES ('pp3', 'promo-a', 'agent-b', 'admin')`).run()).toThrow(/UNIQUE constraint failed/);
    });

    it("engagement_revisions CHECK enforces validatePromoTerms' exact matrix at the database layer too", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      expect(() => db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
        VALUES ('bad1', 'eng-1', 1, 1, 'PERCENT', 1000, 'PERCENT', 0, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
        VALUES ('bad2', 'eng-1', 1, 1, 'PERCENT', 1000, 'NONE', 1, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
        VALUES ('bad3', 'eng-1', 1, 1, 'PERCENT', 1000, 'PERCENT', 1000, '2035-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`).run()).toThrow(/CHECK constraint failed/);
    });

    it("engagement_distribution_revisions: revision 1 needs no correction_reason, revision > 1 requires one", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      seedEngagementRevision(db);
      db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES ('promo-x', 'agent-engagement-1', 'ART', 'ARTX', 'NONE', 0)`).run();
      db.prepare(`INSERT INTO engagement_creative_revisions(id, engagement_id, revision, partner_id, promo_code_id, format_kind, mandatory_labeling_text, creative_target_url, creative_hash, created_by_admin_id)
        VALUES ('cr1', 'eng-1', 1, 'agent-engagement-1', 'promo-x', 'post', 'label', 'https://flexperiment.ru/novosibirsk?promo=ART', 'chash', 'admin')`).run();
      db.prepare(`INSERT INTO engagement_distributions(id, engagement_id) VALUES ('dist1', 'eng-1')`).run();
      expect(() => db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, engagement_revision_id, creative_revision_id, channel_key, channel_policy_status, resource_kind, resource_identifier, distribution_resource_url, published_at, reported_by, evidence_ref, canonical_hash)
        VALUES ('drev1', 'dist1', 1, 'rev-1', 'cr1', 'telegram', 'ALLOWED', 'channel', '@x', 'https://t.me/x/1', '2030-09-01T00:00:00.000Z', 'PARTNER', 'ev', 'h1')`).run()).not.toThrow();
      expect(() => db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, engagement_revision_id, creative_revision_id, channel_key, channel_policy_status, resource_kind, resource_identifier, distribution_resource_url, published_at, reported_by, evidence_ref, canonical_hash)
        VALUES ('drev2', 'dist1', 2, 'rev-1', 'cr1', 'telegram', 'ALLOWED', 'channel', '@x', 'https://t.me/x/1-corrected', '2030-09-01T00:00:00.000Z', 'PARTNER', 'ev', 'h2')`).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, supersedes_revision_id, engagement_revision_id, creative_revision_id, channel_key, channel_policy_status, resource_kind, resource_identifier, distribution_resource_url, published_at, reported_by, correction_reason, evidence_ref, canonical_hash)
        VALUES ('drev3', 'dist1', 2, 'drev1', 'rev-1', 'cr1', 'telegram', 'ALLOWED', 'channel', '@x', 'https://t.me/x/1-corrected', '2030-09-01T00:00:00.000Z', 'PARTNER', 'typo fix', 'ev', 'h3')`).run()).not.toThrow();
      expect(() => db.exec("UPDATE engagement_distribution_revisions SET distribution_resource_url = 'https://t.me/x/tampered' WHERE id = 'drev1'")).toThrow(/ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE/);
    });

    it("ord_reporting_delegation_revocations: at most one revocation per delegation ever, and the realm/admin-id shape is enforced", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      db.prepare(`INSERT INTO framework_agreement_revisions(id, revision, content_json, content_hash) VALUES ('fw1', 1, '{}', 'h')`).run();
      db.prepare(`INSERT INTO delegation_template_revisions(id, revision, ord_reporting_mode, content_json, content_hash) VALUES ('dt1', 1, 'FLEXPERIMENT_DELEGATED', '{}', 'h')`).run();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES ('sess1', 'partner-1', 'th', datetime('now', '+1 hour'))`).run();
      db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at) VALUES ('sg1', 'sess1', 'partner-1', 'FRAMEWORK_ACCEPTANCE', '{}', 'h', datetime('now', '+5 minutes'))`).run();
      db.prepare(`INSERT INTO framework_acceptances(id, partner_identity_id, framework_agreement_revision_id, delegation_template_revision_id, step_up_grant_id) VALUES ('fa1', 'partner-1', 'fw1', 'dt1', 'sg1')`).run();
      db.prepare(`INSERT INTO ord_reporting_delegations(id, partner_identity_id, framework_acceptance_id, delegation_template_revision_id, ord_reporting_mode) VALUES ('del1', 'partner-1', 'fa1', 'dt1', 'FLEXPERIMENT_DELEGATED')`).run();

      expect(() => db.prepare(`INSERT INTO ord_reporting_delegation_revocations(id, ord_reporting_delegation_id, partner_identity_id, revoked_by_realm, revoked_by_admin_id, reason)
        VALUES ('rev-bad', 'del1', 'partner-1', 'ADMIN', NULL, 'x')`).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO ord_reporting_delegation_revocations(id, ord_reporting_delegation_id, partner_identity_id, revoked_by_realm, revoked_by_admin_id, reason)
        VALUES ('rev-bad2', 'del1', 'partner-1', 'PARTNER', 'admin-1', 'x')`).run()).toThrow(/CHECK constraint failed/);
      db.prepare(`INSERT INTO ord_reporting_delegation_revocations(id, ord_reporting_delegation_id, partner_identity_id, revoked_by_realm, revoked_by_admin_id, reason)
        VALUES ('rev-ok', 'del1', 'partner-1', 'ADMIN', 'admin-1', 'x')`).run();
      expect(() => db.prepare(`INSERT INTO ord_reporting_delegation_revocations(id, ord_reporting_delegation_id, partner_identity_id, revoked_by_realm, revoked_by_admin_id, reason)
        VALUES ('rev-second', 'del1', 'partner-1', 'PARTNER', NULL, 'y')`).run()).toThrow(/UNIQUE constraint failed/);
    });

    it("engagement_closure_events: at most one closure per engagement, ever", () => {
      const db = at0044();
      migrate(db);
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      seedEngagementRevision(db);
      db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES ('promo-c', 'agent-engagement-1', 'ART', 'ARTC', 'NONE', 0)`).run();
      db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, sequence, revoked_at, revoked_reason)
        VALUES ('auth-c', 'promo-c', 'agent-engagement-1', 'occ-1', 'eng-1', 'rev-1', 1, CURRENT_TIMESTAMP, 'closed')`).run();
      db.prepare(`INSERT INTO engagement_closure_events(id, engagement_id, occurrence_id, revoked_promo_authorization_id, reward_registry_finalization_evidence_ref, reason, closed_by_admin_id)
        VALUES ('close1', 'eng-1', 'occ-1', 'auth-c', 'ev', 'closing', 'admin')`).run();
      expect(() => db.prepare(`INSERT INTO engagement_closure_events(id, engagement_id, occurrence_id, revoked_promo_authorization_id, reward_registry_finalization_evidence_ref, reason, closed_by_admin_id)
        VALUES ('close2', 'eng-1', 'occ-1', 'auth-c', 'ev', 'closing again', 'admin')`).run()).toThrow(/UNIQUE constraint failed/);
    });
  });
});
