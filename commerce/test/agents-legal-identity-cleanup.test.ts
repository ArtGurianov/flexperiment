import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommerceDomain } from "../src/domain";
import { assertAgentReferralsSchemaPresent } from "../src/agent-referrals-schema-evidence";
import { isFkOffMigration, migrate, openDatabase } from "../src/db";
import { MockProvider } from "../src/provider";
import { agentPatchSchema, agentSchema } from "../src/types";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agents-legal-identity-cleanup";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
const { createApp } = await import("../src/api");

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const MIGRATION_FILE = "0058_agents_legal_identity_cleanup.sql";
const BEFORE_0058 = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql") && file < "0058").sort();
const MIGRATION_SHA256 = createHash("sha256").update(readFileSync(join(MIGRATIONS, MIGRATION_FILE))).digest("hex");
const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const operationalAgent = (overrides: Record<string, unknown> = {}) => ({
  slug: `agent-${randomUUID().slice(0, 8)}`,
  display_name: "Operational agent",
  email: `agent-${randomUUID().slice(0, 8)}@example.test`,
  ...overrides,
});

const readyDatabase = () => {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return { db, domain: new CommerceDomain(db, new MockProvider()) };
};

const seedCurrentBinding = (db: Database.Database, agentId: string, revision = 1, taxMode: "NPD" | "OTHER" = "NPD") => {
  const revisionId = `lp-${randomUUID()}`;
  const legalForm = taxMode === "NPD" ? "INDIVIDUAL" : "INDIVIDUAL_ENTREPRENEUR";
  const projected = taxMode === "NPD" ? "SELF_EMPLOYED" : "INDIVIDUAL_ENTREPRENEUR";
  db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(
    id, agent_id, revision, legal_form, tax_mode, projected_contractor_type,
    full_name, inn, registration_number, reason, assertion_source
  ) VALUES (?, ?, ?, ?, ?, ?, 'Ivan Ivanov', '123456789012', ?, 'test', 'PARTNER_ASSERTED')`)
    .run(revisionId, agentId, revision, legalForm, taxMode, projected, legalForm === "INDIVIDUAL_ENTREPRENEUR" ? "123456789012345" : null);
  const identityId = `pi-${randomUUID()}`;
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id)
    VALUES (?, ?, ?, 'hash', ?, 'admin')`).run(identityId, agentId, `${identityId}@example.test`, revisionId);
  return { identityId, revisionId, projected };
};

const seedCompletedLegacyReward = (db: Database.Database, agentId: string) => {
  const releaseId = randomUUID();
  const cityId = randomUUID();
  const occurrenceId = randomUUID();
  const orderId = randomUUID();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test', datetime('now'), '{}', 1)").run(releaseId);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address, fulfillment_status, sales_status, completed_at)
    VALUES (?, ?, 'Occurrence', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 'UTC', 10000, 1, 'PUBLISHED', 'CONFIRMED', 'Venue', 'Address', 'COMPLETED', 'CLOSED', CURRENT_TIMESTAMP)`).run(occurrenceId, cityId);
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
    VALUES (?, ?, ?, ?, '', 'customer@example.test', 'hash', 5000, 1, 'snapshot', ?, '{}', 'yes')`).run(orderId, `status-${orderId}`, `FX-${orderId.slice(0, 8)}`, occurrenceId, releaseId);
  db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks, reward_authority_kind) VALUES (?, ?, ?, ?, 5000, 'LEGACY')")
    .run(randomUUID(), orderId, agentId, occurrenceId);
  return occurrenceId;
};

const insertLegacySettlement = (db: Database.Database, agentId: string, occurrenceId: string, revisionId: string, contractorType: string) =>
  db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, legal_profile_revision_id_snapshot, prepared_at, created_by_admin_id)
    VALUES (?, ?, ?, 1, 'TRANSFER', 'PREPARED', ?, ?, datetime('now'), 'admin')`)
    .run(randomUUID(), agentId, occurrenceId, contractorType, revisionId);

describe("Phase 1 agents legal identity cleanup", () => {
  it("fails closed when 0058's reviewed FK-off hash is absent or changed", () => {
    expect(isFkOffMigration(MIGRATION_FILE, MIGRATION_SHA256)).toBe(true);
    expect(isFkOffMigration(MIGRATION_FILE, "0".repeat(64))).toBe(false);
    expect(isFkOffMigration("0058_renamed.sql", MIGRATION_SHA256)).toBe(false);
  });

  it("pins the committed 0058 FK-off rebuild and preserves only operational agent data", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agents-0058-")), "commerce.sqlite");
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const fileName of BEFORE_0058) {
      db.exec(readFileSync(join(MIGRATIONS, fileName), "utf8"));
      db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(fileName);
    }
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES ('agent-1', 'agent-1', 'Agent', 'Legacy legal', 'agent@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 1, 'FIXED', 500, '2026-01-01T00:00:00.000Z')`).run();
    migrate(db);
    const columns = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(MIGRATION_SHA256).toBe("c8f711ace8ebf169fb492aa4b3cd5c745f98a8ed9be03ff1cf76d1ef6a184637");
    expect(columns).toEqual(["id", "slug", "display_name", "email", "enabled", "default_reward_type", "default_reward_value", "created_at", "updated_at"]);
    expect(db.prepare("SELECT slug, display_name, email, default_reward_value FROM agents").get()).toEqual({ slug: "agent-1", display_name: "Agent", email: "agent@example.test", default_reward_value: 500 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'agents_contractor_type_projection_guard'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('reward_settlements_authority_columns_immutable_guard', 'reward_settlements_contractor_type_projection_guard') ORDER BY name").all()).toEqual([
      { name: "reward_settlements_authority_columns_immutable_guard" },
      { name: "reward_settlements_contractor_type_projection_guard" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => assertAgentReferralsSchemaPresent(db)).not.toThrow();
    db.close();
  });

  it("strictly rejects every removed legal field while an operational agent may have no legal profile", () => {
    const removed = ["contractor_type", "legal_name", "inn", "npd_status_checked_at"];
    for (const field of removed) {
      expect(agentSchema.safeParse({ ...operationalAgent(), [field]: "removed" }).success).toBe(false);
      expect(agentPatchSchema.safeParse({ [field]: "removed" }).success).toBe(false);
    }
    const { domain } = readyDatabase();
    const agent = domain.createAgent(operationalAgent());
    expect(domain.agentList().find((row) => row.id === agent.id)).toMatchObject({ legal_profile: null });
  });

  it("rejects removed legal fields at the authenticated HTTP boundary", async () => {
    const { db } = readyDatabase();
    const app = createApp(db, new MockProvider());
    const origin = "https://admin.flexperiment.ru";
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.81" },
      body: JSON.stringify({ password: "correct horse" }),
    });
    expect(login.status).toBe(200);
    const headers = { Origin: origin, Cookie: login.headers.get("set-cookie")!, "Content-Type": "application/json" };
    const payload = operationalAgent({ slug: "http-agent", email: "http-agent@example.test" });
    const rejectedCreate = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "agents-cleanup-http-create-rejected" },
      body: JSON.stringify({ ...payload, legal_name: "must be rejected" }),
    });
    expect(rejectedCreate.status).toBe(422);
    const created = await app.request("http://admin.flexperiment.ru/v1/admin/agents", {
      method: "POST", headers: { ...headers, "Idempotency-Key": "agents-cleanup-http-create" }, body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    const agent = await created.json() as { id: string };
    const rejectedPatch = await app.request(`http://admin.flexperiment.ru/v1/admin/agents/${agent.id}`, {
      method: "PATCH", headers: { ...headers, "Idempotency-Key": "agents-cleanup-http-patch-rejected" },
      body: JSON.stringify({ contractor_type: "SELF_EMPLOYED" }),
    });
    expect(rejectedPatch.status).toBe(422);
  });

  it("prepares a legacy settlement only from an active current legal binding, and replay stays pinned after R2", () => {
    const { db, domain } = readyDatabase();
    const agent = domain.createAgent(operationalAgent());
    const agentId = String(agent.id);
    const occurrenceId = seedCompletedLegacyReward(db, agentId);
    expect(() => domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "TRANSFER" }, "key-1", "admin"))
      .toThrow("AGENT_REFERRALS_LEGACY_SETTLEMENT_IDENTITY_MISSING");
    const r1 = seedCurrentBinding(db, agentId);
    expect(() => domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "TRANSFER" }, "key-1", "admin"))
      .toThrow("CONTRACTOR_STATUS_REVIEW");
    db.prepare("INSERT INTO npd_status_checks(id, partner_identity_id, sequence, status, checked_at, evidence_ref, created_by_admin_id) VALUES (?, ?, 1, 'ACTIVE', ?, 'evidence', 'admin')")
      .run(randomUUID(), r1.identityId, new Date().toISOString());
    const first = domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "TRANSFER" }, "key-1", "admin");
    expect(first.legal_profile_revision_id_snapshot).toBe(r1.revisionId);
    const r2 = `lp-${randomUUID()}`;
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, supersedes_revision_id, reason, assertion_source)
      VALUES (?, ?, 2, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Ivan Ivanov', '123456789012', '123456789012345', ?, 'changed', 'PARTNER_ASSERTED')`).run(r2, agentId, r1.revisionId);
    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = ? WHERE id = ?").run(r2, r1.identityId);
    expect(domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "TRANSFER" }, "key-1", "admin")).toMatchObject({ id: first.id, legal_profile_revision_id_snapshot: r1.revisionId });
    expect(() => domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 4999, method: "TRANSFER" }, "key-1", "admin")).toThrow("IDEMPOTENCY_CONFLICT");
  });

  it("enforces every LEGACY insert-time legal binding property", () => {
    const { db, domain } = readyDatabase();
    const agentId = String(domain.createAgent(operationalAgent()).id);
    const occurrenceId = seedCompletedLegacyReward(db, agentId);
    const r1 = seedCurrentBinding(db, agentId, 1, "OTHER");
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, r1.revisionId, r1.projected)).not.toThrow();

    const r2 = `lp-${randomUUID()}`;
    db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, supersedes_revision_id, reason, assertion_source)
      VALUES (?, ?, 2, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Ivan Ivanov', '123456789012', '123456789012345', ?, 'R2', 'PARTNER_ASSERTED')`).run(r2, agentId, r1.revisionId);
    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = ? WHERE id = ?").run(r2, r1.identityId);
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, r1.revisionId, r1.projected)).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);

    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = ? WHERE id = ?").run(r1.revisionId, r1.identityId);
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, r1.revisionId, r1.projected)).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);

    db.prepare("UPDATE partner_identities SET legal_profile_revision_id = ?, destroyed_at = datetime('now') WHERE id = ?").run(r2, r1.identityId);
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, r2, "INDIVIDUAL_ENTREPRENEUR")).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);

    const otherAgentId = String(domain.createAgent(operationalAgent()).id);
    const other = seedCurrentBinding(db, otherAgentId, 1, "OTHER");
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, other.revisionId, other.projected)).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
    expect(() => insertLegacySettlement(db, agentId, occurrenceId, r2, "SELF_EMPLOYED")).toThrow(/REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT/);
  });
});
