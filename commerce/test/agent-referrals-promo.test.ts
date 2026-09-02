import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import type { AdminPrincipal } from "../src/agent-referrals-partner-identity";
import {
  AgentReferralsPromoError,
  createPartnerPromo,
  currentEngagementPromoAuthorization,
  currentEngagementPromoAuthorizationForEngagement,
  isPromoPartnerOwned,
  mintEngagementPromoAuthorizationInTransaction,
} from "../src/agent-referrals-promo";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-promo-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const seedAgent = (db: Database.Database, agentId = randomUUID()) => {
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `s-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  return agentId;
};

const seedOccurrence = (db: Database.Database) => {
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `c-${cityId.slice(0, 8)}`);
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'X', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'S', 'A')`).run(occurrenceId, cityId);
  return occurrenceId;
};

const partnerIdentityCache = new Map<string, string>();
const seedEngagement = (db: Database.Database, agentId: string, occurrenceId: string) => {
  let partnerId = partnerIdentityCache.get(agentId);
  if (!partnerId) {
    partnerId = randomUUID();
    db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'a@example.test', 'h', 'admin')`).run(partnerId, agentId);
    partnerIdentityCache.set(agentId, partnerId);
  }
  const engagementId = randomUUID();
  db.prepare(`INSERT INTO engagements(id, partner_identity_id, occurrence_id, created_by_admin_id) VALUES (?, ?, ?, 'admin')`).run(engagementId, partnerId, occurrenceId);
  const revisionId = randomUUID();
  db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, created_by_admin_id, reason)
    VALUES (?, ?, 1, 1, 'PERCENT', 1000, 'NONE', 0, '2020-01-01T00:00:00.000Z', '2035-01-01T00:00:00.000Z', '{}', 'h', 'admin', 'seed')`).run(revisionId, engagementId);
  return { engagementId, revisionId };
};

describe("one permanent promo per partner (§B-9)", () => {
  it("mints the underlying promo_codes row with frozen NONE/0 placeholders", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    const row = db.prepare("SELECT discount_type, discount_value, status FROM promo_codes WHERE id = ?").get(promo.promo_code_id);
    expect(row).toEqual({ discount_type: "NONE", discount_value: 0, status: "ACTIVE" });
    expect(isPromoPartnerOwned(db, promo.promo_code_id)).toBe(true);
  });

  it("reuses the legacy admin promo-code grammar - lowercase is normalized, and an invalid code is refused before any row is written", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "art-lower", reason: "mint" });
    const row = db.prepare("SELECT code, normalized_code FROM promo_codes WHERE id = ?").get(promo.promo_code_id);
    expect(row).toEqual({ code: "ART-LOWER", normalized_code: "ART-LOWER" });

    const agentId2 = seedAgent(db, randomUUID());
    const before = db.prepare("SELECT COUNT(*) AS n FROM promo_codes").get() as { n: number };
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId2, code: "a", reason: "too short" })).toThrow(); // fails promoCodeSchema's ^[A-Z0-9_-]{2,64}$
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId2, code: "has a space", reason: "invalid chars" })).toThrow();
    const after = db.prepare("SELECT COUNT(*) AS n FROM promo_codes").get() as { n: number };
    expect(after.n).toBe(before.n); // no partial row from a rejected code
  });

  it("one partner cannot mint a second promo (UNIQUE(partner_id))", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId, code: "ART2", reason: "mint 2" })).toThrow();
  });

  it("a promo code, once bound, cannot be reassigned to a second partner (UNIQUE(promo_code_id) via the underlying normalized_code UNIQUE too)", () => {
    const db = fresh();
    const agentA = seedAgent(db, randomUUID());
    const agentB = seedAgent(db, randomUUID());
    createPartnerPromo(db, admin, { partner_id: agentA, code: "ART", reason: "mint" });
    expect(() => createPartnerPromo(db, admin, { partner_id: agentB, code: "ART", reason: "mint dup" })).toThrow();
  });
});

describe("per-occurrence promo authorization: no bare UNIQUE(promo_code_id), at most one CURRENT per (promo, occurrence)", () => {
  it("the SAME promo authorizes THREE different occurrences simultaneously - one partner advertising three cities holds one code", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    const occ1 = seedOccurrence(db); const occ2 = seedOccurrence(db); const occ3 = seedOccurrence(db);
    const e1 = seedEngagement(db, agentId, occ1); const e2 = seedEngagement(db, agentId, occ2); const e3 = seedEngagement(db, agentId, occ3);

    const a1 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ1, engagement_id: e1.engagementId, engagement_revision_id: e1.revisionId });
    const a2 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ2, engagement_id: e2.engagementId, engagement_revision_id: e2.revisionId });
    const a3 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ3, engagement_id: e3.engagementId, engagement_revision_id: e3.revisionId });

    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ1)!.id).toBe(a1.id);
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ2)!.id).toBe(a2.id);
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ3)!.id).toBe(a3.id);

    // Suspending/revoking one occurrence's authorization must not touch the other two.
    db.prepare("UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'x' WHERE id = ?").run(a2.id);
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ1)).not.toBeNull();
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ2)).toBeNull();
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ3)).not.toBeNull();
  });

  it("minting a new authorization for the SAME (promo, occurrence) supersedes the current one - history is never rewritten", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    const occ = seedOccurrence(db);
    const e = seedEngagement(db, agentId, occ);
    const a1 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ, engagement_id: e.engagementId, engagement_revision_id: e.revisionId });
    const a2 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ, engagement_id: e.engagementId, engagement_revision_id: e.revisionId });
    expect(a2.supersedes_authorization_id).toBe(a1.id);
    const a1Row = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(a1.id) as { revoked_at: string | null };
    expect(a1Row.revoked_at).not.toBeNull();
    expect(currentEngagementPromoAuthorization(db, promo.promo_code_id, occ)!.id).toBe(a2.id);
    expect(currentEngagementPromoAuthorizationForEngagement(db, e.engagementId)!.id).toBe(a2.id);
  });

  it("mintEngagementPromoAuthorizationInTransaction rejects a concurrently-already-revoked current row rather than silently double-superseding", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    const occ = seedOccurrence(db);
    const e = seedEngagement(db, agentId, occ);
    const a1 = mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ, engagement_id: e.engagementId, engagement_revision_id: e.revisionId });
    db.prepare("UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'raced away' WHERE id = ?").run(a1.id);
    // currentEngagementPromoAuthorization now sees nothing live, so a fresh mint (not a supersession) proceeds cleanly.
    expect(() => mintEngagementPromoAuthorizationInTransaction(db, { promo_code_id: promo.promo_code_id, partner_id: agentId, occurrence_id: occ, engagement_id: e.engagementId, engagement_revision_id: e.revisionId })).not.toThrow();
  });
});

describe("AgentReferralsPromoError export", () => {
  it("is thrown as the module's own error class", () => {
    expect(new AgentReferralsPromoError("X").code).toBe("X");
  });
});
