import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import * as audienceVerificationModule from "../src/agent-referrals-audience-verification";
import {
  AudienceVerificationError,
  allAudienceVerificationEvents,
  currentAudienceVerification,
  isAudienceVerified,
  mintAudienceVerificationEventInTransaction,
  verifyAudience,
} from "../src/agent-referrals-audience-verification";
import type { AdminPrincipal } from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-audience-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return { db, file };
};

const seedPartnerAndCity = (db: Database.Database, partnerId = randomUUID(), cityId = randomUUID()) => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'a@example.test', 'h', 'admin')`).run(partnerId, agentId);
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
  return { partnerId, cityId };
};

/**
 * A thin transactional wrapper around the nestable primitive, for these
 * low-level logic tests only. Production code never calls
 * mintAudienceVerificationEventInTransaction with 'REVOKED' from anywhere
 * except agent-referrals-engagement.ts's revokeAudienceVerificationForPartnerCity
 * cascade - see the "no standalone public REVOKED path" test below.
 */
const mint = (db: Database.Database, partnerId: string, cityId: string, eventKind: "VERIFIED" | "REVOKED", reason: string, evidenceRef: string) =>
  db.transaction(() => mintAudienceVerificationEventInTransaction(db, admin, partnerId, cityId, eventKind, reason, evidenceRef)).immediate();

describe("audience verification: append-only, VERIFIED | REVOKED, no SUPERSEDED state", () => {
  it("verifyAudience (the sole top-level production entry point) mints VERIFIED as revision 1 with no supersedes_event_id", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    const event = verifyAudience(db, admin, partnerId, cityId, "initial check", "ev-1");
    expect(event).toMatchObject({ event_kind: "VERIFIED", aggregate_revision: 1, supersedes_event_id: null });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(true);
  });

  it("there is no standalone public top-level REVOKED path - the module exports no such function", () => {
    expect(audienceVerificationModule).not.toHaveProperty("mintAudienceVerificationEvent");
    expect(audienceVerificationModule).not.toHaveProperty("revokeAudience");
    // verifyAudience itself has no eventKind parameter at all - structurally VERIFIED-only.
    expect(verifyAudience.length).toBe(6); // (db, admin, partnerIdentityId, cityId, reason, evidenceRef)
  });

  it("refuses REVOKED when there is nothing currently VERIFIED", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    expect(() => mint(db, partnerId, cityId, "REVOKED", "x", "ev")).toThrow(AudienceVerificationError);
    expect(() => mint(db, partnerId, cityId, "REVOKED", "x", "ev")).toThrow(/AGENT_REFERRALS_AUDIENCE_NOT_VERIFIED/);
  });

  it("REVOKED after VERIFIED supersedes it and becomes current; a replacement VERIFIED can follow", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    const v1 = mint(db, partnerId, cityId, "VERIFIED", "initial", "ev-1");
    const r1 = mint(db, partnerId, cityId, "REVOKED", "compliance issue", "ev-2");
    expect(r1).toMatchObject({ event_kind: "REVOKED", aggregate_revision: 2, supersedes_event_id: v1.id });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(false);

    const v2 = mint(db, partnerId, cityId, "VERIFIED", "re-verified with updated evidence", "ev-3");
    expect(v2).toMatchObject({ event_kind: "VERIFIED", aggregate_revision: 3, supersedes_event_id: r1.id });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(true);

    // Current authority is derived from revision lineage (MAX(aggregate_revision)), never MAX(created_at) and never a stored pointer.
    expect(currentAudienceVerification(db, partnerId, cityId)).toMatchObject({ id: v2.id, aggregate_revision: 3 });
  });

  it("every event ever written is exactly VERIFIED or REVOKED - there is no SUPERSEDED state anywhere in the lineage", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    mint(db, partnerId, cityId, "VERIFIED", "a", "1");
    mint(db, partnerId, cityId, "REVOKED", "b", "2");
    mint(db, partnerId, cityId, "VERIFIED", "c", "3");
    const all = allAudienceVerificationEvents(db, partnerId, cityId);
    expect(all).toHaveLength(3);
    for (const event of all) expect(["VERIFIED", "REVOKED"]).toContain(event.event_kind);
    // History is never rewritten: the first VERIFIED event still reads exactly as filed.
    expect(all[0]).toMatchObject({ event_kind: "VERIFIED", aggregate_revision: 1, reason: "a" });
  });

  it("a different (partner, city) pair has its own independent revision lineage", () => {
    const { db } = fresh();
    const { partnerId: p1, cityId: c1 } = seedPartnerAndCity(db);
    const c2 = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'city-2', 'City 2')").run(c2);
    mint(db, p1, c1, "VERIFIED", "a", "1");
    mint(db, p1, c1, "REVOKED", "b", "2");
    const c2Event = mint(db, p1, c2, "VERIFIED", "c", "1");
    expect(c2Event.aggregate_revision).toBe(1); // c2's own lineage starts at 1, unaffected by c1's history
    expect(isAudienceVerified(db, p1, c1)).toBe(false);
    expect(isAudienceVerified(db, p1, c2)).toBe(true);
  });

  describe("concurrency: two writers racing to mint the next revision for the same (partner, city)", () => {
    it("both eventually mint, serialized onto distinct revisions - never a duplicate or lost revision", () => {
      const { db: a, file } = fresh();
      const { partnerId, cityId } = seedPartnerAndCity(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      mint(a, partnerId, cityId, "VERIFIED", "racer A initial", "ev-a1");
      // Racer B, from a separate connection, revokes what racer A just verified - each call is serialized by SQLite's write lock and re-reads current state fresh.
      const revoked = mint(b, partnerId, cityId, "REVOKED", "racer B revokes", "ev-b1");
      const reverified = mint(a, partnerId, cityId, "VERIFIED", "racer A re-verifies", "ev-a2");

      expect(revoked.aggregate_revision).toBe(2);
      expect(reverified.aggregate_revision).toBe(3);
      expect(allAudienceVerificationEvents(a, partnerId, cityId).map((e) => e.aggregate_revision)).toEqual([1, 2, 3]);
    });

    it("structurally, no two rows for the same (partner, city) can ever share an aggregate_revision", () => {
      const { db } = fresh();
      const { partnerId, cityId } = seedPartnerAndCity(db);
      mint(db, partnerId, cityId, "VERIFIED", "a", "1");
      expect(() => db.prepare(`INSERT INTO partner_audience_verification_events(id, partner_identity_id, city_id, aggregate_revision, event_kind, evidence_ref, reason, placed_by_admin_id)
        VALUES (?, ?, ?, 1, 'REVOKED', 'ev', 'r', 'admin')`).run(randomUUID(), partnerId, cityId)).toThrow(/UNIQUE constraint failed/);
    });
  });
});
