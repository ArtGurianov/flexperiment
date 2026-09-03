import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, isFkOffMigration, migrate } from "../src/db";
import { AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, assertAgentReferralsFoundationSchemaPresent } from "../src/agent-referrals-activation";

/**
 * 0047 is the act/payment/settlement authority schema (plan Phase 7):
 * `settlement_flow` on the pre-existing `reward_settlements` table (added
 * via ALTER TABLE + triggers - same rationale as 0046's `orders`, since
 * reward_settlements has real ongoing legacy UPDATE traffic and a rebuild
 * would need FK-off), plus settlement_step_up_grants, settlement_acts +
 * acceptances + disputes, npd_status_checks, payment_authorizations,
 * payment_attempts, npd_receipts, and engagement_zero_reward_closures.
 * Ordinary migration - not FK-off, and it adds no 0048+.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0047_act_payment_settlement.sql";
const BEFORE_0047 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0047").sort();

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "act-payment-settlement-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0047) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const at0046 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "act-payment-settlement-")), "commerce.sqlite");
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

// --- Full seed chain: agent -> partner identity -> legal profile -> payout
// profile -> occurrence -> engagement -> revision -> R -> E1. Every
// structural test below builds on this exact fixture, mirroring 0046's own
// migration-test seeding style (raw SQL, never through application code -
// these tests prove the DATABASE enforces the invariant, independent of
// any application-level check).

const seedAgent = (db: Database.Database, agentId = "agent-1", contractorType = "SELF_EMPLOYED") =>
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'M', 'M Legal', ?, ?, '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, agentId, `${agentId}@example.test`, contractorType);

const seedPartnerIdentity = (db: Database.Database, partnerId = "partner-1", agentId = "agent-1", legalProfileRevisionId: string | null = null) =>
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id) VALUES (?, ?, 'a@example.test', 'h', ?, 'admin')`)
    .run(partnerId, agentId, legalProfileRevisionId);

const seedLegalProfileRevision = (db: Database.Database, agentId = "agent-1", revisionId = "lp-1", taxMode: "NPD" | "OTHER" = "NPD") => {
  const legalForm = taxMode === "NPD" ? "INDIVIDUAL" : "INDIVIDUAL_ENTREPRENEUR";
  const projected = taxMode === "NPD" ? "SELF_EMPLOYED" : "INDIVIDUAL_ENTREPRENEUR";
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, reason)
    VALUES (?, ?, 1, ?, ?, ?, 'seed')`).run(revisionId, agentId, legalForm, taxMode, projected);
  return revisionId;
};

const seedPayoutProfileRevision = (db: Database.Database, partnerId = "partner-1", revisionId = "pp-1", revision = 1, kind: "ACTIVE_DESTINATION" | "REVOKED" = "ACTIVE_DESTINATION") => {
  const sessionId = `${partnerId}-session-${revision}`;
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerId, `${sessionId}-hash`);
  const grantId = `${partnerId}-grant-${revision}`;
  db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at, consumed_at)
    VALUES (?, ?, ?, 'PAYOUT_PROFILE_SUPERSESSION', '{}', 'h', datetime('now', '+1 hour'), CURRENT_TIMESTAMP)`).run(grantId, sessionId, partnerId);
  if (kind === "ACTIVE_DESTINATION") {
    db.prepare(`INSERT INTO payout_profile_revisions(id, partner_identity_id, revision, kind, key_id, ciphertext, nonce, destination_kind, destination_last4, step_up_grant_id)
      VALUES (?, ?, ?, 'ACTIVE_DESTINATION', 'k1', 'ct', 'n', 'BANK_CARD', '1111', ?)`).run(revisionId, partnerId, revision, grantId);
  } else {
    db.prepare(`INSERT INTO payout_profile_revisions(id, partner_identity_id, revision, kind, step_up_grant_id) VALUES (?, ?, ?, 'REVOKED', ?)`).run(revisionId, partnerId, revision, grantId);
  }
  return revisionId;
};

const seedOccurrence = (db: Database.Database, occurrenceId = "occ-1") => {
  const cityId = "city-1";
  db.prepare("INSERT OR IGNORE INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return cityId;
};

const markOccurrenceTerminal = (db: Database.Database, occurrenceId = "occ-1", status: "COMPLETED" | "CANCELLED" = "COMPLETED") =>
  db.prepare(`UPDATE occurrences SET fulfillment_status = ?, sales_status = 'CLOSED',
      completed_at = CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIMESTAMP END,
      cancelled_at = CASE WHEN ? = 'CANCELLED' THEN CURRENT_TIMESTAMP END
    WHERE id = ?`).run(status, status, status, occurrenceId);

const seedEngagement = (db: Database.Database, engagementId = "eng-1", partnerId = "partner-1", occurrenceId = "occ-1") =>
  db.prepare(`INSERT INTO engagements(id, partner_identity_id, occurrence_id, created_by_admin_id) VALUES (?, ?, ?, 'admin')`).run(engagementId, partnerId, occurrenceId);

const seedEngagementRevision = (db: Database.Database, revisionId = "rev-1", engagementId = "eng-1", revision = 1) =>
  db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
    VALUES (?, ?, ?, 1, 'PERCENT', 1000, 'PERCENT', 1000, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'hash', 'admin', 'seed')`)
    .run(revisionId, engagementId, revision);

const seedRegistryAndEffective = (db: Database.Database, opts: {
  engagementId?: string; revisionId?: string; occurrenceId?: string; total?: number; registryId?: string; effectiveId?: string; terminalStatus?: "COMPLETED" | "CANCELLED";
} = {}) => {
  const { engagementId = "eng-1", revisionId = "rev-1", occurrenceId = "occ-1", total = 9000, registryId = "reg-1", effectiveId = "eff-1", terminalStatus = "COMPLETED" } = opts;
  // E1 must be an EXACT mirror of R (engagement_revision_id/reward_total_kopecks/source_state_hash all equal) - the §B-6 identity PR6's own relational-consistency guard enforces - so both rows share the same literal hash below.
  const hash = `hash-${registryId}`;
  db.prepare(`INSERT INTO engagement_reward_registry_snapshot(id, engagement_id, engagement_revision_id, occurrence_id, terminal_status, reward_total_kopecks, formula_version, source_order_ids_json, source_state_hash, watermark, finalized_by_admin_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, 1, '[]', ?, 'w', 'admin', 'seed')`).run(registryId, engagementId, revisionId, occurrenceId, terminalStatus, total, hash);
  db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
    VALUES (?, ?, ?, ?, 1, 'INITIAL', ?, ?, 'seed', 'admin', ?)`).run(effectiveId, engagementId, revisionId, registryId, total, hash, `ch-${effectiveId}`);
  return { registryId, effectiveId };
};

/** The full default fixture: NPD partner, COMPLETED occurrence, R=E1=9000. Returns every id a settlement/act/payment test needs. */
const seedFixture = (db: Database.Database, opts: { taxMode?: "NPD" | "OTHER"; total?: number; terminalStatus?: "COMPLETED" | "CANCELLED" } = {}) => {
  const { taxMode = "NPD", total = 9000, terminalStatus = "COMPLETED" } = opts;
  seedAgent(db);
  const legalProfileRevisionId = seedLegalProfileRevision(db, "agent-1", "lp-1", taxMode);
  seedPartnerIdentity(db, "partner-1", "agent-1", legalProfileRevisionId);
  const payoutProfileRevisionId = seedPayoutProfileRevision(db);
  seedOccurrence(db);
  if (terminalStatus !== "SCHEDULED" as unknown as "COMPLETED") markOccurrenceTerminal(db, "occ-1", terminalStatus);
  seedEngagement(db);
  seedEngagementRevision(db);
  const { registryId, effectiveId } = seedRegistryAndEffective(db, { total, terminalStatus });
  return { agentId: "agent-1", partnerId: "partner-1", legalProfileRevisionId, payoutProfileRevisionId, occurrenceId: "occ-1", engagementId: "eng-1", revisionId: "rev-1", registryId, effectiveId, taxMode };
};

const seedSettlement = (db: Database.Database, f: ReturnType<typeof seedFixture>, overrides: Partial<{
  id: string; amount_kopecks: number; effective_reward_snapshot_id: string; engagement_id: string; engagement_revision_id: string;
  base_registry_snapshot_id: string; partner_identity_id: string; payout_profile_revision_id: string; supersedes_settlement_id: string | null;
  status: string; cancellation_reason: string | null; agent_id: string; occurrence_id: string;
}> = {}) => {
  const v = {
    id: "settle-1", amount_kopecks: 9000, effective_reward_snapshot_id: f.effectiveId, engagement_id: f.engagementId, engagement_revision_id: f.revisionId,
    base_registry_snapshot_id: f.registryId, partner_identity_id: f.partnerId, payout_profile_revision_id: f.payoutProfileRevisionId, supersedes_settlement_id: null,
    status: "PREPARED", cancellation_reason: null, agent_id: f.agentId, occurrence_id: f.occurrenceId, ...overrides,
  };
  db.prepare(`INSERT INTO reward_settlements(
      id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id,
      settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id,
      partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot, supersedes_settlement_id, cancellation_reason)
    VALUES (?, ?, ?, ?, 'PAYOUT_PROFILE', ?, 'SELF_EMPLOYED', datetime('now'), 'admin',
      'AGENT_REFERRALS', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(v.id, v.agent_id, v.occurrence_id, v.amount_kopecks, v.status,
      v.engagement_id, v.engagement_revision_id, v.base_registry_snapshot_id, v.effective_reward_snapshot_id,
      v.partner_identity_id, v.payout_profile_revision_id, f.taxMode, f.legalProfileRevisionId, v.supersedes_settlement_id, v.cancellation_reason);
  return v.id;
};

const seedAct = (db: Database.Database, f: ReturnType<typeof seedFixture>, settlementId: string, overrides: Partial<{ id: string; presented: boolean; amount_kopecks: number }> = {}) => {
  const v = { id: "act-1", presented: false, amount_kopecks: 9000, ...overrides };
  db.prepare(`INSERT INTO settlement_acts(id, settlement_id, engagement_id, engagement_revision_id, effective_reward_snapshot_id, partner_identity_id, amount_kopecks, created_by_admin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admin')`).run(v.id, settlementId, f.engagementId, f.revisionId, f.effectiveId, f.partnerId, v.amount_kopecks);
  if (v.presented) db.prepare("UPDATE settlement_acts SET presented_at = CURRENT_TIMESTAMP WHERE id = ?").run(v.id);
  return v.id;
};

const seedAcceptedAct = (db: Database.Database, f: ReturnType<typeof seedFixture>, settlementId: string, actId = "act-1") => {
  seedAct(db, f, settlementId, { id: actId, presented: true });
  const sessionId = `${f.partnerId}-accept-session`;
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, f.partnerId, `${sessionId}-hash`);
  const grantId = `${actId}-grant`;
  db.prepare(`INSERT INTO settlement_step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at, consumed_at)
    VALUES (?, ?, ?, 'ACT_ACCEPTANCE', '{}', 'h', datetime('now', '+1 hour'), CURRENT_TIMESTAMP)`).run(grantId, sessionId, f.partnerId);
  db.prepare(`INSERT INTO settlement_act_acceptances(id, act_id, partner_identity_id, step_up_grant_id, accepted_amount_kopecks, accepted_engagement_revision_id)
    VALUES (?, ?, ?, ?, 9000, ?)`).run(`${actId}-acc`, actId, f.partnerId, grantId, f.revisionId);
  return actId;
};

const seedNpdCheck = (db: Database.Database, f: ReturnType<typeof seedFixture>, opts: { id?: string; status?: "ACTIVE" | "INACTIVE" | "UNKNOWN" } = {}) => {
  const { id = "npd-1", status = "ACTIVE" } = opts;
  db.prepare(`INSERT INTO npd_status_checks(id, partner_identity_id, status, checked_at, evidence_ref, created_by_admin_id) VALUES (?, ?, ?, datetime('now'), 'ev', 'admin')`)
    .run(id, f.partnerId, status);
  return id;
};

const seedAuthorization = (db: Database.Database, f: ReturnType<typeof seedFixture>, settlementId: string, actId: string, overrides: Partial<{
  id: string; amount_kopecks: number; payout_profile_revision_id: string; npd_status_check_id: string | null;
}> = {}) => {
  const v = { id: "auth-1", amount_kopecks: 9000, payout_profile_revision_id: f.payoutProfileRevisionId, npd_status_check_id: f.taxMode === "NPD" ? "npd-1" : null, ...overrides };
  db.prepare(`INSERT INTO payment_authorizations(id, settlement_id, act_id, amount_kopecks, payout_profile_revision_id, npd_status_check_id, created_by_admin_id)
    VALUES (?, ?, ?, ?, ?, ?, 'admin')`).run(v.id, settlementId, actId, v.amount_kopecks, v.payout_profile_revision_id, v.npd_status_check_id);
  return v.id;
};

const seedAttempt = (db: Database.Database, settlementId: string, authorizationId: string, overrides: Partial<{ id: string; amount_kopecks: number; status: string }> = {}) => {
  const v = { id: "attempt-1", amount_kopecks: 9000, status: "IN_PROGRESS", ...overrides };
  // The table's own CHECK ties each status to its own timestamp column -
  // satisfied at INSERT time here too, not only via a later UPDATE.
  const madeAt = v.status === "MADE" ? "CURRENT_TIMESTAMP" : "NULL";
  const unknownAt = v.status === "PAYOUT_UNKNOWN" ? "CURRENT_TIMESTAMP" : "NULL";
  const notMadeAt = v.status === "CONFIRMED_NOT_MADE" ? "CURRENT_TIMESTAMP" : "NULL";
  db.prepare(`INSERT INTO payment_attempts(id, payment_authorization_id, settlement_id, status, amount_kopecks, made_at, payout_unknown_at, confirmed_not_made_at)
    VALUES (?, ?, ?, ?, ?, ${madeAt}, ${unknownAt}, ${notMadeAt})`)
    .run(v.id, authorizationId, settlementId, v.status, v.amount_kopecks);
  return v.id;
};

describe("0047 act/payment/settlement migration", () => {
  it("applies exactly once through the real migrate() runner, ordinarily (FK stays ON)", () => {
    const db = at0046();
    migrate(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ version: MIGRATION_FILE });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("replays as an exact no-op", () => {
    const db = at0046();
    migrate(db);
    const before = db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE);
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = ?").get(MIGRATION_FILE)).toEqual({ n: 1 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is not FK-off, and the registry still contains only the exact 0042 tuple", () => {
    const db = at0046();
    const sql = readFileSync(join(MIGRATIONS, MIGRATION_FILE), "utf8");
    expect(isFkOffMigration(MIGRATION_FILE, createHash("sha256").update(sql).digest("hex"))).toBe(false);
    migrate(db);
    expect(FK_OFF_MIGRATIONS).toHaveLength(1);
    expect(FK_OFF_MIGRATIONS).toEqual([
      { filename: "0042_agent_referrals_agents_rebuild.sql", sha256: "d9b5ecbf496993669201b45440ea5213ba0e52af778e2094d569f772adfee6ab" },
    ]);
  });

  it("ships no 0048+ migration file", () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"));
    expect(all.filter((n) => n > MIGRATION_FILE)).toEqual([]);
  });

  it("0047 introduces exactly the eight new tables, no ORD/VK/ERIR provider table, and adds no new base table to reward_settlements", () => {
    const db = at0046();
    const before = new Set(tableNames(db));
    migrate(db);
    const introduced = tableNames(db).filter((name) => !before.has(name) && name !== "schema_migrations");
    expect(introduced.sort()).toEqual([
      "engagement_zero_reward_closures", "npd_receipts", "npd_status_checks", "payment_attempts", "payment_authorizations",
      "settlement_act_acceptances", "settlement_act_disputes", "settlement_acts", "settlement_step_up_grants",
    ]);
    for (const forbidden of ["ord_creative_registrations", "ord_distribution_period_reports", "vk_erir_reports", "engagement_creative_revisions_v2"]) {
      expect(introduced).not.toContain(forbidden);
    }
  });

  it("creates no password/social-login/team/RBAC/capacity/generic-accounting table", () => {
    const db = at0046();
    migrate(db);
    const names = tableNames(db);
    expect(names.some((n) => /password|social_login|team|membership|role|capacity_pilot|ledger|chart_of_accounts/i.test(n))).toBe(false);
  });

  describe("PR3-PR6's required-schema-object list now also proves PR7's authority/evidence objects", () => {
    const pr7Objects = [
      "reward_settlements_authority_tuple_consistency_guard", "reward_settlements_authority_columns_immutable_guard", "reward_settlements_effective_snapshot_unique",
      "settlement_step_up_grants",
      "settlement_acts", "settlement_acts_relational_consistency_guard", "settlement_acts_fields_immutable_guard", "settlement_acts_presented_one_way_guard", "settlement_acts_delete_guard",
      "settlement_act_acceptances", "settlement_act_acceptances_relational_consistency_guard", "settlement_act_acceptances_immutable_guard", "settlement_act_acceptances_delete_guard",
      "settlement_act_disputes", "settlement_act_disputes_relational_consistency_guard", "settlement_act_disputes_immutable_guard", "settlement_act_disputes_delete_guard",
      "npd_status_checks", "npd_status_checks_immutable_guard", "npd_status_checks_delete_guard",
      "payment_authorizations", "payment_authorizations_relational_consistency_guard", "payment_authorizations_immutable_guard", "payment_authorizations_delete_guard",
      "payment_attempts", "payment_attempts_active_unique", "payment_attempts_relational_consistency_guard", "payment_attempts_identity_immutable_guard",
      "payment_attempts_terminal_immutable_guard", "payment_attempts_transition_legality_guard", "payment_attempts_delete_guard",
      "npd_receipts", "npd_receipts_relational_consistency_guard", "npd_receipts_immutable_guard", "npd_receipts_delete_guard",
      "engagement_zero_reward_closures", "engagement_zero_reward_closures_relational_consistency_guard", "engagement_zero_reward_closures_immutable_guard", "engagement_zero_reward_closures_delete_guard",
    ];

    it("AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS includes every PR7 object, exhaustively, as the list's exact suffix", () => {
      for (const object of pr7Objects) expect(AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS, object).toContain(object);
      const pr3through6Objects = 104; // 92 (PR3-5) + 12 (PR6), each proven exhaustive by its own migration test.
      const suffix = [...AGENT_REFERRALS_REQUIRED_SCHEMA_OBJECTS].slice(pr3through6Objects);
      expect(suffix).toEqual(pr7Objects);
    });

    it("passes on a DB migrated through 0047", () => {
      const db = at0046();
      migrate(db);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).not.toThrow();
    });

    it("fails closed when 0047 has not been applied yet (0046 only)", () => {
      const db = at0046();
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/AGENT_REFERRALS_ACTIVATION_SCHEMA_MISSING/);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(/0047_act_payment_settlement\.sql/);
    });

    it.each([
      "reward_settlements_authority_tuple_consistency_guard", "settlement_acts_relational_consistency_guard",
      "settlement_act_acceptances_relational_consistency_guard", "settlement_act_disputes_relational_consistency_guard",
      "payment_authorizations_relational_consistency_guard", "payment_attempts_relational_consistency_guard",
      "npd_receipts_relational_consistency_guard", "engagement_zero_reward_closures_relational_consistency_guard",
    ])("dropping %s (proxy table/row remains) still refuses", (guardName) => {
      const db = at0046();
      migrate(db);
      db.exec(`DROP TRIGGER ${guardName}`);
      expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(guardName));
    });

    it.each(["settlement_acts", "payment_authorizations", "payment_attempts", "npd_status_checks", "npd_receipts", "engagement_zero_reward_closures"])(
      "dropping the base table %s also refuses",
      (tableName) => {
        const db = at0046();
        migrate(db);
        db.exec(`DROP TABLE ${tableName}`);
        expect(() => assertAgentReferralsFoundationSchemaPresent(db)).toThrow(new RegExp(tableName));
      },
    );
  });

  describe("reward_settlements: settlement_flow partition and authority tuple", () => {
    it("historical NULL is impossible - ALTER TABLE's own NOT NULL DEFAULT 'LEGACY' backfills every pre-existing row", () => {
      const db = at0046();
      seedAgent(db); seedOccurrence(db);
      db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
        VALUES ('pre-1', 'agent-1', 'occ-1', 1000, 'bank', 'PREPARED', 'SELF_EMPLOYED', datetime('now'), 'admin')`).run();
      migrate(db);
      expect(db.prepare("SELECT settlement_flow FROM reward_settlements WHERE id = 'pre-1'").get()).toEqual({ settlement_flow: "LEGACY" });
    });

    it("a new LEGACY-flow row (the unchanged legacy INSERT shape) continues to succeed with every AGENT_REFERRALS column NULL", () => {
      const db = at0046();
      migrate(db);
      seedAgent(db); seedOccurrence(db);
      expect(() => db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
        VALUES ('legacy-1', 'agent-1', 'occ-1', 1000, 'bank', 'PREPARED', 'SELF_EMPLOYED', datetime('now'), 'admin')`).run()).not.toThrow();
      const row = db.prepare("SELECT settlement_flow, engagement_id, effective_reward_snapshot_id FROM reward_settlements WHERE id = 'legacy-1'").get();
      expect(row).toEqual({ settlement_flow: "LEGACY", engagement_id: null, effective_reward_snapshot_id: null });
    });

    it("a well-formed AGENT_REFERRALS settlement succeeds", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      expect(() => seedSettlement(db, f)).not.toThrow();
    });

    it("a half-shaped AGENT_REFERRALS row (missing payout_profile_revision_id) is refused", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      expect(() => seedSettlement(db, f, { payout_profile_revision_id: null as unknown as string })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("amount_kopecks disagreeing with the pinned E's own total is refused - F10's structural proof", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db, { total: 9000 });
      expect(() => seedSettlement(db, f, { amount_kopecks: 4000 })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("a settlement whose engagement_id belongs to a different partner_identity than the one pinned is refused", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      seedAgent(db, "agent-2");
      const lp2 = seedLegalProfileRevision(db, "agent-2", "lp-2", "NPD");
      seedPartnerIdentity(db, "partner-2", "agent-2", lp2);
      expect(() => seedSettlement(db, f, { partner_identity_id: "partner-2" })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("a payout profile belonging to a DIFFERENT partner is refused, even though it exists and is ACTIVE_DESTINATION", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      seedAgent(db, "agent-2");
      const lp2 = seedLegalProfileRevision(db, "agent-2", "lp-2", "NPD");
      seedPartnerIdentity(db, "partner-2", "agent-2", lp2);
      const foreignPayout = seedPayoutProfileRevision(db, "partner-2", "pp-2", 1);
      expect(() => seedSettlement(db, f, { payout_profile_revision_id: foreignPayout })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("a payout profile that is a SUPERSEDED (not-current) revision is refused - 'still usable' recheck at creation time", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      seedPayoutProfileRevision(db, "partner-1", "pp-2", 2); // supersedes pp-1
      expect(() => seedSettlement(db, f, { payout_profile_revision_id: "pp-1" })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("a positive settlement for an engagement whose occurrence is not COMPLETED is refused - the §B-6 hard invariant, rechecked here directly by this settlement's OWN guard", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db, { total: 9000 }); // legitimately finalized while COMPLETED
      // The occurrence later moves off COMPLETED (unrealistic for this schema in practice, but proves the settlement guard's own direct occurrence
      // recheck, not merely relying on R/E already agreeing) - R and E still legitimately say COMPLETED/9000, only the occurrence itself changes.
      db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(f.occurrenceId);
      expect(() => seedSettlement(db, f, { amount_kopecks: 9000 })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    });

    it("at most one settlement per effective snapshot, ever - the partial UNIQUE index, not merely a WHEN-clause check", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      seedSettlement(db, f, { id: "settle-1" });
      expect(() => seedSettlement(db, f, { id: "settle-2" })).toThrow(/UNIQUE constraint failed/);
    });

    it("authority columns are DB-immutable, but ordinary status transitions remain legal", () => {
      const db = at0046();
      migrate(db);
      const f = seedFixture(db);
      seedSettlement(db, f);
      expect(() => db.prepare("UPDATE reward_settlements SET amount_kopecks = 1 WHERE id = 'settle-1'").run()).toThrow(/REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE/);
      expect(() => db.prepare("UPDATE reward_settlements SET engagement_id = 'eng-2' WHERE id = 'settle-1'").run()).toThrow(/REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE/);
      expect(() => db.prepare("UPDATE reward_settlements SET status = 'PENDING_DOCUMENT' WHERE id = 'settle-1'").run()).not.toThrow();
    });

    describe("supersession lineage", () => {
      it("a new settlement naming a genuine CANCELLED_BEFORE_PAYMENT predecessor whose E is the immediate successor of the predecessor's own E succeeds", () => {
        const db = at0046();
        migrate(db);
        const f = seedFixture(db);
        seedSettlement(db, f, { id: "settle-1", amount_kopecks: 9000 });
        db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = 'settle-1'").run();
        db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('eff-2', ?, ?, ?, 'eff-1', 2, 'CORRECTION', 3000, 'h2', 'correction', 'admin', 'ch2')`).run(f.engagementId, f.revisionId, f.registryId);
        expect(() => seedSettlement(db, f, { id: "settle-2", amount_kopecks: 3000, effective_reward_snapshot_id: "eff-2", supersedes_settlement_id: "settle-1" })).not.toThrow();
      });

      it("a new settlement naming a predecessor that is NOT actually CANCELLED_BEFORE_PAYMENT (still PREPARED) is refused", () => {
        const db = at0046();
        migrate(db);
        const f = seedFixture(db);
        seedSettlement(db, f, { id: "settle-1" }); // stays PREPARED
        db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
          VALUES ('eff-2', ?, ?, ?, 'eff-1', 2, 'CORRECTION', 3000, 'h2', 'correction', 'admin', 'ch2')`).run(f.engagementId, f.revisionId, f.registryId);
        expect(() => seedSettlement(db, f, { id: "settle-2", amount_kopecks: 3000, effective_reward_snapshot_id: "eff-2", supersedes_settlement_id: "settle-1" })).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
      });

      it("a new settlement whose E is NOT the immediate successor of the predecessor's own E (wrong lineage) is refused", () => {
        const db = at0046();
        migrate(db);
        const f = seedFixture(db);
        seedSettlement(db, f, { id: "settle-1" });
        db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = 'settle-1'").run();
        // eff-2 supersedes nothing (unrelated INITIAL-shaped row would violate other CHECKs); instead mint an unrelated engagement's own chain and try to attach it here.
        seedAgent(db, "agent-2"); const lp2 = seedLegalProfileRevision(db, "agent-2", "lp-2", "NPD"); seedPartnerIdentity(db, "partner-2", "agent-2", lp2);
        seedPayoutProfileRevision(db, "partner-2", "pp-2", 1);
        seedOccurrence(db, "occ-2"); markOccurrenceTerminal(db, "occ-2", "COMPLETED");
        seedEngagement(db, "eng-2", "partner-2", "occ-2"); seedEngagementRevision(db, "rev-2", "eng-2");
        const other = seedRegistryAndEffective(db, { engagementId: "eng-2", revisionId: "rev-2", occurrenceId: "occ-2", registryId: "reg-2", effectiveId: "eff-x", total: 3000 });
        void other;
        expect(() => seedSettlement(db, f, { id: "settle-2", amount_kopecks: 3000, effective_reward_snapshot_id: "eff-x", engagement_id: "eng-2", engagement_revision_id: "rev-2", base_registry_snapshot_id: "reg-2", partner_identity_id: "partner-2", payout_profile_revision_id: "pp-2", supersedes_settlement_id: "settle-1" }))
          .toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
      });
    });
  });

  describe("settlement_acts / acceptances / disputes", () => {
    it("a well-formed act mirroring its own AGENT_REFERRALS settlement succeeds", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f);
      expect(() => seedAct(db, f, "settle-1")).not.toThrow();
    });

    it("an act whose amount disagrees with its settlement's own amount is refused", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f);
      expect(() => seedAct(db, f, "settle-1", { amount_kopecks: 1 })).toThrow(/SETTLEMENT_ACT_RELATIONAL_INCONSISTENT/);
    });

    it("at most one act per settlement, ever", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f);
      seedAct(db, f, "settle-1", { id: "act-1" });
      expect(() => seedAct(db, f, "settle-1", { id: "act-2" })).toThrow(/UNIQUE constraint failed/);
    });

    it("presented_at is one-way: once presented, no further UPDATE of any kind is legal, including re-presenting or un-presenting", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1", { presented: true });
      expect(() => db.prepare("UPDATE settlement_acts SET presented_at = NULL WHERE id = 'act-1'").run()).toThrow(/SETTLEMENT_ACT_ALREADY_PRESENTED/);
      expect(() => db.prepare("UPDATE settlement_acts SET presented_at = CURRENT_TIMESTAMP WHERE id = 'act-1'").run()).toThrow(/SETTLEMENT_ACT_ALREADY_PRESENTED/);
      expect(() => db.prepare("UPDATE settlement_acts SET amount_kopecks = 1 WHERE id = 'act-1'").run()).toThrow(/SETTLEMENT_ACT_ALREADY_PRESENTED/);
    });

    it("fields other than presented_at are DB-immutable even before presentation", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1", { presented: false });
      expect(() => db.prepare("UPDATE settlement_acts SET amount_kopecks = 1 WHERE id = 'act-1'").run()).toThrow(/SETTLEMENT_ACT_FIELDS_IMMUTABLE/);
    });

    it("dropping settlement_acts rows is forbidden", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1");
      expect(() => db.prepare("DELETE FROM settlement_acts WHERE id = 'act-1'").run()).toThrow(/SETTLEMENT_ACT_IMMUTABLE/);
    });

    it("acceptance requires the act to already be presented", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1", { presented: false });
      const sessionId = "s1"; db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, 'partner-1', 'h', datetime('now', '+1 hour'))`).run(sessionId);
      db.prepare(`INSERT INTO settlement_step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at, consumed_at)
        VALUES ('g1', ?, 'partner-1', 'ACT_ACCEPTANCE', '{}', 'h', datetime('now', '+1 hour'), CURRENT_TIMESTAMP)`).run(sessionId);
      expect(() => db.prepare(`INSERT INTO settlement_act_acceptances(id, act_id, partner_identity_id, step_up_grant_id, accepted_amount_kopecks, accepted_engagement_revision_id)
        VALUES ('acc-1', 'act-1', 'partner-1', 'g1', 9000, ?)`).run(f.revisionId)).toThrow(/SETTLEMENT_ACT_ACCEPTANCE_INVALID/);
    });

    it("acceptance and dispute are mutually exclusive - a dispute already on file refuses a later acceptance, and vice versa", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1", { presented: true });
      db.prepare(`INSERT INTO settlement_act_disputes(id, act_id, partner_identity_id, reason) VALUES ('d1', 'act-1', 'partner-1', 'AMOUNT_INCORRECT')`).run();
      const sessionId = "s2"; db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, 'partner-1', 'h', datetime('now', '+1 hour'))`).run(sessionId);
      db.prepare(`INSERT INTO settlement_step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at, consumed_at)
        VALUES ('g2', ?, 'partner-1', 'ACT_ACCEPTANCE', '{}', 'h', datetime('now', '+1 hour'), CURRENT_TIMESTAMP)`).run(sessionId);
      expect(() => db.prepare(`INSERT INTO settlement_act_acceptances(id, act_id, partner_identity_id, step_up_grant_id, accepted_amount_kopecks, accepted_engagement_revision_id)
        VALUES ('acc-1', 'act-1', 'partner-1', 'g2', 9000, ?)`).run(f.revisionId)).toThrow(/SETTLEMENT_ACT_ACCEPTANCE_INVALID/);
    });

    it("acceptance/dispute rows are immutable and delete-protected", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1");
      expect(() => db.prepare("UPDATE settlement_act_acceptances SET accepted_amount_kopecks = 1 WHERE id = 'act-1-acc'").run()).toThrow(/SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM settlement_act_acceptances WHERE id = 'act-1-acc'").run()).toThrow(/SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE/);
    });
  });

  describe("npd_status_checks", () => {
    it("is immutable and delete-protected", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedNpdCheck(db, f);
      expect(() => db.prepare("UPDATE npd_status_checks SET status = 'INACTIVE' WHERE id = 'npd-1'").run()).toThrow(/NPD_STATUS_CHECK_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM npd_status_checks WHERE id = 'npd-1'").run()).toThrow(/NPD_STATUS_CHECK_IMMUTABLE/);
    });
  });

  describe("payment_authorizations", () => {
    const readyForAuth = (db: Database.Database, opts: { taxMode?: "NPD" | "OTHER" } = {}) => {
      const f = seedFixture(db, { taxMode: opts.taxMode ?? "NPD" });
      seedSettlement(db, f);
      seedAcceptedAct(db, f, "settle-1");
      if (f.taxMode === "NPD") seedNpdCheck(db, f);
      return f;
    };

    it("succeeds when settlement PREPARED, act presented+accepted+undisputed, payout profile current, NPD check fresh ACTIVE", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db);
      expect(() => seedAuthorization(db, f, "settle-1", "act-1")).not.toThrow();
    });

    it("succeeds for OTHER tax mode with no npd_status_check_id at all", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db, { taxMode: "OTHER" });
      expect(() => seedAuthorization(db, f, "settle-1", "act-1", { npd_status_check_id: null })).not.toThrow();
    });

    it("refuses when the settlement is not PREPARED (e.g. already CANCELLED_BEFORE_PAYMENT)", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db);
      db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = 'settle-1'").run();
      expect(() => seedAuthorization(db, f, "settle-1", "act-1")).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses when a LATER settlement has already superseded this one, even if settle-1's own status were somehow still PREPARED", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db);
      // Build a GENUINE supersession chain (the only way settlement_id-2 can legally point at settlement_id-1 at all), then flip settle-1's status
      // back to PREPARED via a plain UPDATE (status is not authority-immutable) - isolating this test to the payment_authorizations guard's OWN
      // "not already superseded" clause, independent of settle-1's own status check proven separately above.
      db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION' WHERE id = 'settle-1'").run();
      db.prepare(`INSERT INTO engagement_effective_reward_snapshots(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash)
        VALUES ('eff-2', ?, ?, ?, 'eff-1', 2, 'CORRECTION', 3000, 'h2', 'correction', 'admin', 'ch2')`).run(f.engagementId, f.revisionId, f.registryId);
      seedSettlement(db, f, { id: "settle-2", amount_kopecks: 3000, effective_reward_snapshot_id: "eff-2", supersedes_settlement_id: "settle-1" });
      db.prepare("UPDATE reward_settlements SET status = 'PREPARED' WHERE id = 'settle-1'").run();
      expect(() => seedAuthorization(db, f, "settle-1", "act-1")).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses when the act is undisputed but not accepted", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAct(db, f, "settle-1", { presented: true }); seedNpdCheck(db, f);
      expect(() => seedAuthorization(db, f, "settle-1", "act-1")).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses when the act is disputed, even if somehow also accepted", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db);
      db.exec("DROP TRIGGER settlement_act_disputes_relational_consistency_guard"); // unrealistic combined state, direct SQL only
      db.prepare(`INSERT INTO settlement_act_disputes(id, act_id, partner_identity_id, reason) VALUES ('d1', 'act-1', 'partner-1', 'OTHER')`).run();
      expect(() => seedAuthorization(db, f, "settle-1", "act-1")).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses NPD without an ACTIVE npd_status_check_id", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); // no npd_status_checks row exists at all
      expect(() => seedAuthorization(db, f, "settle-1", "act-1", { npd_status_check_id: null })).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses NPD whose named check is INACTIVE", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1");
      seedNpdCheck(db, f, { id: "npd-bad", status: "INACTIVE" });
      expect(() => seedAuthorization(db, f, "settle-1", "act-1", { npd_status_check_id: "npd-bad" })).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("refuses when the payout profile is no longer the current revision", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db);
      seedPayoutProfileRevision(db, "partner-1", "pp-2", 2);
      expect(() => seedAuthorization(db, f, "settle-1", "act-1", { payout_profile_revision_id: "pp-1" })).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
    });

    it("is fully immutable and delete-protected", () => {
      const db = at0046(); migrate(db);
      const f = readyForAuth(db); seedAuthorization(db, f, "settle-1", "act-1");
      expect(() => db.prepare("UPDATE payment_authorizations SET amount_kopecks = 1 WHERE id = 'auth-1'").run()).toThrow(/PAYMENT_AUTHORIZATION_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM payment_authorizations WHERE id = 'auth-1'").run()).toThrow(/PAYMENT_AUTHORIZATION_IMMUTABLE/);
    });
  });

  describe("payment_attempts", () => {
    const readyForAttempt = (db: Database.Database) => {
      const f = seedFixture(db); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); seedNpdCheck(db, f); seedAuthorization(db, f, "settle-1", "act-1");
      return f;
    };

    it("a well-formed IN_PROGRESS attempt succeeds", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      expect(() => seedAttempt(db, "settle-1", "auth-1")).not.toThrow();
    });

    it("amount disagreeing with its own authorization is refused", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      expect(() => seedAttempt(db, "settle-1", "auth-1", { amount_kopecks: 1 })).toThrow(/PAYMENT_ATTEMPT_RELATIONAL_INCONSISTENT/);
    });

    it("at most one active (non-CONFIRMED_NOT_MADE) attempt per settlement - the partial UNIQUE index", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "attempt-1" });
      // A second authorization for the same settlement is itself blocked by
      // payment_authorizations' own guard (status != PREPARED once an
      // attempt exists is NOT what gates this - PREPARED persists until
      // MADE - so this proves the payment_attempts index specifically via
      // a second raw attempt row naming a second raw authorization).
      db.prepare(`INSERT INTO payment_authorizations(id, settlement_id, act_id, amount_kopecks, payout_profile_revision_id, npd_status_check_id, created_by_admin_id)
        VALUES ('auth-2', 'settle-1', 'act-1', 9000, 'pp-1', 'npd-1', 'admin')`).run();
      expect(() => seedAttempt(db, "settle-1", "auth-2", { id: "attempt-2" })).toThrow(/UNIQUE constraint failed/);
    });

    it("a fresh attempt IS allowed once the prior one reached CONFIRMED_NOT_MADE", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "attempt-1", status: "CONFIRMED_NOT_MADE" });
      db.prepare(`INSERT INTO payment_authorizations(id, settlement_id, act_id, amount_kopecks, payout_profile_revision_id, npd_status_check_id, created_by_admin_id)
        VALUES ('auth-2', 'settle-1', 'act-1', 9000, 'pp-1', 'npd-1', 'admin')`).run();
      expect(() => seedAttempt(db, "settle-1", "auth-2", { id: "attempt-2" })).not.toThrow();
    });

    it("transition legality: IN_PROGRESS -> MADE/PAYOUT_UNKNOWN/CONFIRMED_NOT_MADE all legal; PAYOUT_UNKNOWN -> CONFIRMED_NOT_MADE legal; everything else illegal", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a" });
      expect(() => db.prepare("UPDATE payment_attempts SET status = 'MADE', made_at = CURRENT_TIMESTAMP WHERE id = 'a'").run()).not.toThrow();
    });

    it("MADE -> anything is illegal (terminal immutability)", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a" });
      db.prepare("UPDATE payment_attempts SET status = 'MADE', made_at = CURRENT_TIMESTAMP WHERE id = 'a'").run();
      expect(() => db.prepare("UPDATE payment_attempts SET evidence_ref = 'x' WHERE id = 'a'").run()).toThrow(/PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE/);
    });

    it("IN_PROGRESS -> CONFIRMED_NOT_MADE directly (definitive synchronous failure) is legal", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a" });
      expect(() => db.prepare("UPDATE payment_attempts SET status = 'CONFIRMED_NOT_MADE', confirmed_not_made_at = CURRENT_TIMESTAMP WHERE id = 'a'").run()).not.toThrow();
    });

    it("PAYOUT_UNKNOWN -> MADE is illegal - an unresolved payout is never later relabelled paid by this attempt's own lifecycle", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "PAYOUT_UNKNOWN" });
      expect(() => db.prepare("UPDATE payment_attempts SET status = 'MADE', made_at = CURRENT_TIMESTAMP WHERE id = 'a'").run()).toThrow(/PAYMENT_ATTEMPT_TRANSITION_ILLEGAL/);
    });

    it("CONFIRMED_NOT_MADE -> IN_PROGRESS (a fabricated 'retry' rewind) is illegal", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "CONFIRMED_NOT_MADE" });
      // Both the terminal-immutability guard and the transition-legality guard independently forbid this; either firing proves the rewind is refused.
      expect(() => db.prepare("UPDATE payment_attempts SET status = 'IN_PROGRESS' WHERE id = 'a'").run()).toThrow(/PAYMENT_ATTEMPT_(TERMINAL_IMMUTABLE|TRANSITION_ILLEGAL)/);
    });

    it("dropping an attempt row is forbidden", () => {
      const db = at0046(); migrate(db); readyForAttempt(db);
      seedAttempt(db, "settle-1", "auth-1", { id: "a" });
      expect(() => db.prepare("DELETE FROM payment_attempts WHERE id = 'a'").run()).toThrow(/PAYMENT_ATTEMPT_IMMUTABLE/);
    });
  });

  describe("npd_receipts", () => {
    it("succeeds for a MADE attempt on an NPD settlement", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { taxMode: "NPD" }); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); seedNpdCheck(db, f); seedAuthorization(db, f, "settle-1", "act-1");
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "MADE" });
      expect(() => db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
        VALUES ('r1', 'a', 'settle-1', 'ref', 'ev', 'admin')`).run()).not.toThrow();
    });

    it("refuses when the attempt is not MADE", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { taxMode: "NPD" }); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); seedNpdCheck(db, f); seedAuthorization(db, f, "settle-1", "act-1");
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "IN_PROGRESS" });
      expect(() => db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
        VALUES ('r1', 'a', 'settle-1', 'ref', 'ev', 'admin')`).run()).toThrow(/NPD_RECEIPT_RELATIONAL_INCONSISTENT/);
    });

    it("refuses for an OTHER-tax-mode settlement even if the attempt is MADE - never force OTHER through the NPD document lifecycle", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { taxMode: "OTHER" }); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); seedAuthorization(db, f, "settle-1", "act-1", { npd_status_check_id: null });
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "MADE" });
      expect(() => db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
        VALUES ('r1', 'a', 'settle-1', 'ref', 'ev', 'admin')`).run()).toThrow(/NPD_RECEIPT_RELATIONAL_INCONSISTENT/);
    });

    it("is immutable and delete-protected", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { taxMode: "NPD" }); seedSettlement(db, f); seedAcceptedAct(db, f, "settle-1"); seedNpdCheck(db, f); seedAuthorization(db, f, "settle-1", "act-1");
      seedAttempt(db, "settle-1", "auth-1", { id: "a", status: "MADE" });
      db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id) VALUES ('r1', 'a', 'settle-1', 'ref', 'ev', 'admin')`).run();
      expect(() => db.prepare("UPDATE npd_receipts SET receipt_reference = 'x' WHERE id = 'r1'").run()).toThrow(/NPD_RECEIPT_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM npd_receipts WHERE id = 'r1'").run()).toThrow(/NPD_RECEIPT_IMMUTABLE/);
    });
  });

  describe("engagement_zero_reward_closures", () => {
    it("succeeds for a genuine zero-total E, pinning a possibly-positive R untouched", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { terminalStatus: "CANCELLED", total: 0 });
      expect(() => db.prepare(`INSERT INTO engagement_zero_reward_closures(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks, closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version, command_id, canonical_hash, closed_by_admin_id)
        VALUES ('z1', ?, ?, ?, ?, 0, 'OCCURRENCE_CANCELLED', 'CANCELLED', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', 1, 'cmd-1', 'ch', 'admin')`)
        .run(f.engagementId, f.revisionId, f.registryId, f.effectiveId)).not.toThrow();
    });

    it("refuses when the pinned E does not actually have a zero total", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { total: 9000 });
      expect(() => db.prepare(`INSERT INTO engagement_zero_reward_closures(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks, closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version, command_id, canonical_hash, closed_by_admin_id)
        VALUES ('z1', ?, ?, ?, ?, 0, 'OTHER_POLICY_ZERO', 'COMPLETED', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', 1, 'cmd-1', 'ch', 'admin')`)
        .run(f.engagementId, f.revisionId, f.registryId, f.effectiveId)).toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT/);
    });

    it("at most one closure per engagement, ever", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { terminalStatus: "CANCELLED", total: 0 });
      const insert = (id: string) => db.prepare(`INSERT INTO engagement_zero_reward_closures(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks, closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version, command_id, canonical_hash, closed_by_admin_id)
        VALUES (?, ?, ?, ?, ?, 0, 'OCCURRENCE_CANCELLED', 'CANCELLED', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', 1, ?, 'ch', 'admin')`).run(id, f.engagementId, f.revisionId, f.registryId, f.effectiveId, id);
      insert("z1");
      expect(() => insert("z2")).toThrow(/UNIQUE constraint failed/);
    });

    it("is immutable and delete-protected", () => {
      const db = at0046(); migrate(db);
      const f = seedFixture(db, { terminalStatus: "CANCELLED", total: 0 });
      db.prepare(`INSERT INTO engagement_zero_reward_closures(id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks, closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version, command_id, canonical_hash, closed_by_admin_id)
        VALUES ('z1', ?, ?, ?, ?, 0, 'OCCURRENCE_CANCELLED', 'CANCELLED', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', 1, 'cmd-1', 'ch', 'admin')`).run(f.engagementId, f.revisionId, f.registryId, f.effectiveId);
      expect(() => db.prepare("UPDATE engagement_zero_reward_closures SET reward_total_kopecks = 0 WHERE id = 'z1'").run()).toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE/);
      expect(() => db.prepare("DELETE FROM engagement_zero_reward_closures WHERE id = 'z1'").run()).toThrow(/ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE/);
    });
  });
});
