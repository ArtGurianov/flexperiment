import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0046 is the attribution/reward schema: the order authority tuple on the
 * pre-existing `orders` table (added via ALTER TABLE + triggers, since
 * `orders` carries too many inbound FKs to rebuild under the 0042-only
 * FK-off exemption), the referral_rewards reward_authority_kind partition
 * column, and the reward registry (R) / effective snapshot (E) tables.
 * Ordinary migration - not FK-off, and it adds no 0047+.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0046_attribution_reward.sql";
const BEFORE_0046 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0046").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "attribution-reward-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0046) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0045 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "attribution-reward-")), "commerce.sqlite");
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

const seedAgent = (db: Database.Database, agentId = "agent-1") =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'M', 'M Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`);

const seedPartner = (db: Database.Database, partnerId = "partner-1", agentId = "agent-1") =>
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

const seedOrder = (db: Database.Database, orderId = "order-1", occurrenceId = "occ-1") => {
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
    VALUES (?, ?, ?, ?, '', 'c@example.test', 'h', 100000, 1, 'd', 'release-1', '{}', 'x')`).run(orderId, `${orderId}-status`, `FX-${orderId}`, occurrenceId);
  return orderId;
};

/** promo_codes + partner_promos + engagement_promo_authorizations, the full chain an ENGAGEMENT_SCOPED order's resolved_* columns must relationally agree with. */
const seedPromoAuthorization = (db: Database.Database, agentId = "agent-1", engagementId = "eng-1", revisionId = "rev-1", occurrenceId = "occ-1", promoCodeId = "promo-1", authId = "auth-1") => {
  db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES (?, ?, ?, ?, 'NONE', 0)`).run(promoCodeId, agentId, promoCodeId.toUpperCase(), promoCodeId.toUpperCase());
  db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES (?, ?, ?, 'admin')`).run(`${promoCodeId}-pp`, promoCodeId, agentId);
  db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, sequence)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(authId, promoCodeId, agentId, occurrenceId, engagementId, revisionId);
  return { promoCodeId, authId };
};

const seedEngagementScopedOrder = (db: Database.Database, orderId = "order-es-1", occurrenceId = "occ-1", overrides: Partial<{
  explicit_promo_id: string; resolved_partner_id: string; resolved_engagement_id: string; resolved_engagement_revision_id: string;
  resolved_promo_authorization_id: string; attributed_agent_id: string; reward_type_snapshot: string; reward_value_snapshot: number; resolution_reason: string;
}> = {}) => {
  const values = {
    explicit_promo_id: "promo-1", resolved_partner_id: "agent-1", resolved_engagement_id: "eng-1", resolved_engagement_revision_id: "rev-1",
    resolved_promo_authorization_id: "auth-1", attributed_agent_id: "agent-1", reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000,
    resolution_reason: "EXPLICIT_PARTNER_PROMO", ...overrides,
  };
  return db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at,
      reward_authority_kind, explicit_promo_id, resolved_partner_id, resolved_engagement_id, resolved_engagement_revision_id, resolved_promo_authorization_id, attributed_agent_id, reward_type_snapshot, reward_value_snapshot, resolution_reason)
    VALUES (?, ?, ?, ?, '', 'c@example.test', 'h', 90000, 1, 'd', 'release-1', '{}', 'x',
      'ENGAGEMENT_SCOPED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(orderId, `${orderId}-status`, `FX-${orderId}`, occurrenceId,
      values.explicit_promo_id, values.resolved_partner_id, values.resolved_engagement_id, values.resolved_engagement_revision_id, values.resolved_promo_authorization_id,
      values.attributed_agent_id, values.reward_type_snapshot, values.reward_value_snapshot, values.resolution_reason);
};

describe("0046 attribution & reward migration", () => {
  it("applies exactly once through the real migrate() runner, ordinarily (FK stays ON)", () => {
    const db = at0045();
    // orders references legal_releases(id); seed one so a later order insert in this suite can succeed.
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op", () => {
    const db = at0045();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0045();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0047+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("0046 introduces exactly the two new tables, no PR7 act/settlement/payment/provider table, and adds no new base table to `orders` or `referral_rewards`", () => {
    const db = at0045();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual(["engagement_effective_reward_snapshots", "engagement_reward_registry_snapshot"]);
    for (const forbidden of [
      "acts", "settlement_flow", "payment_authorizations", "payment_attempts", "npd_receipts",
      "engagement_zero_reward_closures", "ord_creative_registrations", "ord_distribution_period_reports", "vk_erir_reports",
    ]) {
      expect(introduced).not.toContain(forbidden);
    }
  });

  it("creates no password/social-login/team/RBAC/capacity table or column", () => {
    const db = at0045();
    migrate(db);
    const names = tableNames(db);
    expect(names.some((n) => /password|social_login|team|membership|role|capacity_pilot/i.test(n))).toBe(false);
  });

  describe("PR3-PR5's required-schema-object list now also proves PR6's authority/evidence objects", () => {
    const pr6Objects = [
      "orders_authority_tuple_consistency_guard", "orders_authority_columns_immutable_guard",
      "referral_rewards_authority_kind_matches_order_guard", "referral_rewards_authority_kind_immutable_guard",
      "engagement_reward_registry_snapshot", "engagement_reward_registry_snapshot_relational_consistency_guard",
      "engagement_reward_registry_snapshot_immutable_guard", "engagement_reward_registry_snapshot_delete_guard",
      "engagement_effective_reward_snapshots", "engagement_effective_reward_snapshots_relational_consistency_guard",
      "engagement_effective_reward_snapshots_immutable_guard", "engagement_effective_reward_snapshots_delete_guard",
    ];

    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every PR6 object, exhaustively, as the list's exact suffix", () => {
      for (const object of pr6Objects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      const pr3through5Objects = 92; // 16 (PR3) + 33 (PR4) + 43 (PR5), each proven exhaustive by its own migration test.
      const suffix = [...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS].slice(pr3through5Objects);
      expect(suffix).toEqual(pr6Objects);
    });

    it("passes on a DB migrated through 0046", () => {
      const db = at0045();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0046 has not been applied yet (0045 only)", () => {
      const db = at0045();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/0046_attribution_reward\.sql/);
    });

    it.each([
      "orders_authority_tuple_consistency_guard", "orders_authority_columns_immutable_guard",
      "referral_rewards_authority_kind_matches_order_guard", "referral_rewards_authority_kind_immutable_guard",
      "engagement_reward_registry_snapshot_relational_consistency_guard", "engagement_reward_registry_snapshot_immutable_guard",
      "engagement_effective_reward_snapshots_relational_consistency_guard", "engagement_effective_reward_snapshots_delete_guard",
    ])(
      "dropping %s (proxy table/row remains) still refuses",
      (guardName) => {
        const db = at0045();
        migrate(db);
        db.exec(`DROP TRIGGER ${guardName}`);
        expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(guardName));
      },
    );

    it.each(["engagement_reward_registry_snapshot", "engagement_effective_reward_snapshots"])("dropping the base table %s also refuses", (tableName) => {
      const db = at0045();
      migrate(db);
      db.exec(`DROP TABLE ${tableName}`);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(tableName));
    });
  });

  describe("orders authority tuple: structural invariants proven against actual SQLite schema", () => {
    it("a LEGACY order (the default) needs no resolved_* pin and inserts cleanly", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedOccurrence(db);
      expect(() => seedOrder(db)).not.toThrow();
      const row = db.prepare("SELECT reward_authority_kind, resolved_partner_id FROM orders WHERE id = 'order-1'").get() as { reward_authority_kind: string; resolved_partner_id: string | null };
      expect(row).toEqual({ reward_authority_kind: "LEGACY", resolved_partner_id: null });
    });

    it("a half-shaped ENGAGEMENT_SCOPED row (missing a resolved_* pin) is refused at INSERT", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedOccurrence(db);
      expect(() => db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, reward_authority_kind, explicit_promo_id, resolved_partner_id)
        VALUES ('order-bad', 's', 'FX-BAD', 'occ-1', '', 'c@example.test', 'h', 100000, 1, 'd', 'release-1', '{}', 'x', 'ENGAGEMENT_SCOPED', 'promo-1', 'agent-1')`).run())
        .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("a LEGACY row with a stray resolved_* pin is also refused", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedOccurrence(db);
      expect(() => db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, resolved_partner_id)
        VALUES ('order-bad2', 's2', 'FX-BAD2', 'occ-1', '', 'c@example.test', 'h', 100000, 1, 'd', 'release-1', '{}', 'x', 'agent-1')`).run())
        .toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("the eleven authority columns (the original eight, plus the reused legacy attributed_agent_id/reward_type_snapshot/reward_value_snapshot columns) are immutable after insert", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedOccurrence(db);
      seedOrder(db);
      expect(() => db.exec("UPDATE orders SET reward_authority_kind = 'LEGACY' WHERE id = 'order-1'")).not.toThrow(); // no-op UPDATE (same value) is allowed - the trigger only fires on an actual change
      expect(() => db.exec("UPDATE orders SET resolution_reason = 'DIRECT' WHERE id = 'order-1'")).toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
      expect(() => db.exec("UPDATE orders SET attribution_rule_version = 2 WHERE id = 'order-1'")).toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
      // The exact fields rewardForOrder() and the reward registry actually
      // read (holistic review, P0 finding 2) - post-checkout tampering with
      // these would silently re-price a since-computed reward without ever
      // touching the (already-immutable) resolved_* pins.
      expect(() => db.exec("UPDATE orders SET attributed_agent_id = 'someone-else' WHERE id = 'order-1'")).toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
      expect(() => db.exec("UPDATE orders SET reward_type_snapshot = 'FIXED' WHERE id = 'order-1'")).toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
      expect(() => db.exec("UPDATE orders SET reward_value_snapshot = 9000 WHERE id = 'order-1'")).toThrow(/ORDER_AUTHORITY_COLUMNS_IMMUTABLE/);
    });

    it("an unrelated column (e.g. customer_name) is not covered by the immutability guard - it never blocks non-authority updates", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedOccurrence(db);
      seedOrder(db);
      expect(() => db.exec("UPDATE orders SET customer_name = 'x' WHERE id = 'order-1'")).not.toThrow();
    });

    describe("relational consistency for ENGAGEMENT_SCOPED orders (holistic review, P0 finding 2): a formally-complete tuple must also be the RIGHT tuple", () => {
      const seedChain = (db: Database.Database) => {
        seedAgent(db);
        seedPartner(db);
        seedOccurrence(db);
        seedEngagement(db);
        seedEngagementRevision(db);
        seedPromoAuthorization(db);
      };

      it("the exact authorization/partner/engagement/revision/occurrence chain inserts cleanly", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        expect(() => seedEngagementScopedOrder(db)).not.toThrow();
      });

      it("an authorization id that belongs to a DIFFERENT partner/engagement is refused, even though every column is individually non-NULL and FK-valid", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        // A second, unrelated engagement/partner/authorization - a real row, just the WRONG one for this order.
        seedAgent(db, "agent-2");
        seedPartner(db, "partner-2", "agent-2");
        seedOccurrence(db, "occ-2");
        seedEngagement(db, "eng-2", "partner-2", "occ-2");
        seedEngagementRevision(db, "rev-2", "eng-2");
        seedPromoAuthorization(db, "agent-2", "eng-2", "rev-2", "occ-2", "promo-2", "auth-2");

        expect(() => seedEngagementScopedOrder(db, "order-wrong-auth", "occ-1", { resolved_promo_authorization_id: "auth-2" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("resolved_partner_id that disagrees with the named authorization's own partner_id is refused", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        seedAgent(db, "agent-2");
        expect(() => seedEngagementScopedOrder(db, "order-wrong-partner", "occ-1", { resolved_partner_id: "agent-2" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("resolved_engagement_revision_id pointing at a DIFFERENT (real) revision than the authorization's own is refused", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        seedEngagementRevision(db, "rev-2", "eng-1", 2); // a second, real revision of the SAME engagement, but not the one the authorization names
        expect(() => seedEngagementScopedOrder(db, "order-wrong-revision", "occ-1", { resolved_engagement_revision_id: "rev-2" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("attributed_agent_id disagreeing with resolved_partner_id is refused", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        seedAgent(db, "agent-2");
        expect(() => seedEngagementScopedOrder(db, "order-wrong-attributed", "occ-1", { attributed_agent_id: "agent-2" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("reward_type_snapshot/reward_value_snapshot disagreeing with the resolved revision's own reward terms is refused (never a mixed-authority reward)", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db); // revision's own terms are PERCENT / 1000
        expect(() => seedEngagementScopedOrder(db, "order-wrong-reward-type", "occ-1", { reward_type_snapshot: "FIXED" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
        expect(() => seedEngagementScopedOrder(db, "order-wrong-reward-value", "occ-1", { reward_value_snapshot: 9999 })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("resolution_reason other than EXPLICIT_PARTNER_PROMO is refused for an ENGAGEMENT_SCOPED order", () => {
        const db = at0045();
        db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
        migrate(db);
        seedChain(db);
        expect(() => seedEngagementScopedOrder(db, "order-wrong-reason", "occ-1", { resolution_reason: "LEGACY_PROMO" })).toThrow(/ORDER_AUTHORITY_TUPLE_INCONSISTENT/);
      });
    });
  });

  describe("reward partition column", () => {
    it("historical rows (inserted BEFORE 0046 ever ran) keep reading NULL after migration - ALTER TABLE's own backfill, never a rewrite, and no INSERT trigger fires for pre-existing rows", () => {
      const db = at0045(); // 0045 baseline: referral_rewards exists, but with no reward_authority_kind column yet
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      seedAgent(db);
      seedOccurrence(db);
      seedOrder(db);
      db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks) VALUES ('rr-historical', 'order-1', 'agent-1', 'occ-1', 100)").run();
      migrate(db); // now applies 0046
      expect((db.prepare("SELECT reward_authority_kind FROM referral_rewards WHERE id = 'rr-historical'").get() as { reward_authority_kind: string | null }).reward_authority_kind).toBeNull();
    });

    it("an invalid enum value is refused at INSERT (the CHECK constraint and the order-matching guard below both independently reject it - an invalid value can never equal a real order's own kind)", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedAgent(db);
      seedOccurrence(db);
      seedOrder(db);
      expect(() => db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks, reward_authority_kind) VALUES ('rr2', 'order-1', 'agent-1', 'occ-1', 50, 'NOT_A_KIND')").run())
        .toThrow(/REFERRAL_REWARD_AUTHORITY_KIND_MISMATCH|CHECK constraint failed/);
    });

    it("a NEW row's reward_authority_kind must match its own order's reward_authority_kind (holistic review, P0 finding 3) - never left free to disagree, and immutable once written", () => {
      const db = at0045();
      db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('release-1', 'v1', datetime('now'), '{}', 1)").run();
      migrate(db);
      seedAgent(db);
      seedOccurrence(db);
      seedOrder(db, "order-legacy", "occ-1"); // LEGACY by default (seedOrder sets no authority columns)

      expect(() => db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks, reward_authority_kind) VALUES ('rr-bad', 'order-legacy', 'agent-1', 'occ-1', 100, 'ENGAGEMENT_SCOPED')").run())
        .toThrow(/REFERRAL_REWARD_AUTHORITY_KIND_MISMATCH/);
      expect(() => db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks, reward_authority_kind) VALUES ('rr-ok', 'order-legacy', 'agent-1', 'occ-1', 100, 'LEGACY')").run())
        .not.toThrow();
      expect(() => db.exec("UPDATE referral_rewards SET reward_authority_kind = 'ENGAGEMENT_SCOPED' WHERE id = 'rr-ok'")).toThrow(/REFERRAL_REWARD_AUTHORITY_KIND_IMMUTABLE/);
      expect(() => db.exec("UPDATE referral_rewards SET reward_authority_kind = 'LEGACY' WHERE id = 'rr-ok'")).not.toThrow(); // no-op UPDATE (same value)
    });
  });

  describe("reward registry (R) and effective snapshots (E): structural constraints", () => {
    const seed = (db: Database.Database) => {
      seedAgent(db);
      seedPartner(db);
      seedOccurrence(db);
      seedEngagement(db);
      seedEngagementRevision(db);
    };

    it("at most one registry ever per engagement", () => {
      const db = at0045();
      migrate(db);
      seed(db);
      db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'COMPLETED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run();
      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r2', 'eng-1', 'rev-1', 'occ-1', 'COMPLETED', 500, 1, '[]', 'h', 'w', 'admin', 'y')`).run()).toThrow(/UNIQUE constraint failed/);
      expect(() => db.exec("UPDATE engagement_reward_registry_snapshot SET reward_total_kopecks = 0 WHERE id = 'r1'")).toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM engagement_reward_registry_snapshot WHERE id = 'r1'")).toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE/);
    });

    it("terminal_status is restricted to COMPLETED | CANCELLED", () => {
      const db = at0045();
      migrate(db);
      seed(db);
      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'SCHEDULED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run()).toThrow(/CHECK constraint failed/);
    });

    it("§B-6: a CANCELLED registry can never carry a positive reward_total_kopecks - structural CHECK, not just an application refusal", () => {
      const db = at0045();
      migrate(db);
      seed(db);
      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'CANCELLED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'CANCELLED', 0, 1, '[]', 'h', 'w', 'admin', 'x')`).run()).not.toThrow();
    });

    it("relational consistency (holistic review, P0 finding 5): engagement_revision_id must belong to engagement_id, and occurrence_id must be the engagement's own occurrence", () => {
      const db = at0045();
      migrate(db);
      seed(db);
      // A second, real engagement/revision/occurrence - just the wrong one for R's own engagement_id.
      seedAgent(db, "agent-2");
      seedPartner(db, "partner-2", "agent-2");
      seedOccurrence(db, "occ-2");
      seedEngagement(db, "eng-2", "partner-2", "occ-2");
      seedEngagementRevision(db, "rev-2", "eng-2");

      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r-wrong-rev', 'eng-1', 'rev-2', 'occ-1', 'COMPLETED', 0, 1, '[]', 'h', 'w', 'admin', 'x')`).run())
        .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT/);
      expect(() => db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r-wrong-occ', 'eng-1', 'rev-1', 'occ-2', 'COMPLETED', 0, 1, '[]', 'h', 'w', 'admin', 'x')`).run())
        .toThrow(/ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT/);
    });

    it("effective snapshots: sequence 1 must be INITIAL with no supersedes pointer; UNIQUE(engagement_id, sequence) backstops at-most-one-per-sequence", () => {
      const db = at0045();
      migrate(db);
      seed(db);
      db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
        VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'COMPLETED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run();

      expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
        VALUES ('e1', 'eng-1', 'rev-1', 'r1', 1, 'CORRECTION', 1000, 'h', 'x', 'admin', 'ch1')`).run()).toThrow(/CHECK constraint failed/);

      db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
        VALUES ('e1', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 1000, 'h', 'x', 'admin', 'ch1')`).run();
      // A second CHECK-consistent row (another INITIAL, sequence 1, no supersedes pointer) for the SAME engagement still collides - proving the UNIQUE(engagement_id, sequence) backstop specifically, not merely the CHECK constraint.
      expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
        VALUES ('e1b', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 500, 'h', 'y', 'admin', 'ch1b')`).run()).toThrow(/UNIQUE constraint failed/);

      db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
        VALUES ('e2', 'eng-1', 'rev-1', 'r1', 'e1', 2, 'CORRECTION', 500, 'h', 'y', 'admin', 'ch2')`).run();
      expect(() => db.exec("UPDATE engagement_effective_reward_snapshots SET reward_total_kopecks = 0 WHERE id = 'e2'")).toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE/);
      expect(() => db.exec("DELETE FROM engagement_effective_reward_snapshots WHERE id = 'e1'")).toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE/);
    });

    describe("relational consistency for the E chain (holistic review, P0 finding 5)", () => {
      const seedTwoEngagementsEachWithR = (db: Database.Database) => {
        seed(db); // eng-1, rev-1, occ-1
        db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
          VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'COMPLETED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run();
        seedAgent(db, "agent-2");
        seedPartner(db, "partner-2", "agent-2");
        seedOccurrence(db, "occ-2");
        seedEngagement(db, "eng-2", "partner-2", "occ-2");
        seedEngagementRevision(db, "rev-2", "eng-2");
        db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
          VALUES ('r2', 'eng-2', 'rev-2', 'occ-2', 'COMPLETED', 2000, 1, '[]', 'h2', 'w', 'admin', 'y')`).run();
      };

      it("an E row naming a DIFFERENT engagement's registry as its base is refused, even though every FK individually resolves", () => {
        const db = at0045();
        migrate(db);
        seedTwoEngagementsEachWithR(db);
        expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e-cross', 'eng-1', 'rev-1', 'r2', 1, 'INITIAL', 1000, 'h', 'x', 'admin', 'ch')`).run())
          .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
      });

      it("a CORRECTION whose supersedes pointer names a DIFFERENT engagement's E row is refused", () => {
        const db = at0045();
        migrate(db);
        seedTwoEngagementsEachWithR(db);
        db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e1-eng1', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 1000, 'h', 'x', 'admin', 'ch1')`).run();
        db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e1-eng2', 'eng-2', 'rev-2', 'r2', 1, 'INITIAL', 2000, 'h2', 'y', 'admin', 'ch2')`).run();
        expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e2-eng1-bad', 'eng-1', 'rev-1', 'r1', 'e1-eng2', 2, 'CORRECTION', 500, 'h3', 'z', 'admin', 'ch3')`).run())
          .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
      });

      it("a CORRECTION whose sequence skips ahead of its named predecessor (predecessor+1 required) is refused", () => {
        const db = at0045();
        migrate(db);
        seed(db);
        db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
          VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'COMPLETED', 1000, 1, '[]', 'h', 'w', 'admin', 'x')`).run();
        db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e1', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 1000, 'h', 'x', 'admin', 'ch1')`).run();
        expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e3-skip', 'eng-1', 'rev-1', 'r1', 'e1', 3, 'CORRECTION', 500, 'h2', 'y', 'admin', 'ch2')`).run())
          .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
      });

      it("mirrors R's own CANCELLED-positive-reward CHECK: an E row on a CANCELLED registry can never carry a positive total", () => {
        const db = at0045();
        migrate(db);
        seed(db);
        db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
          VALUES ('r1', 'eng-1', 'rev-1', 'occ-1', 'CANCELLED', 0, 1, '[]', 'h', 'w', 'admin', 'x')`).run();
        expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e1-bad', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 100, 'h', 'x', 'admin', 'ch1')`).run())
          .toThrow(/ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT/);
        expect(() => db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('e1-ok', 'eng-1', 'rev-1', 'r1', 1, 'INITIAL', 0, 'h', 'x', 'admin', 'ch1')`).run())
          .not.toThrow();
      });
    });
  });
});
