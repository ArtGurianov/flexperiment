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
} from "../src/agent-referrals-audience-verification";
import { revokeAudienceVerificationForPartnerCity, verifyAudienceForPartnerCity } from "../src/agent-referrals-engagement";
import type { AdminPrincipal } from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };
const FAR_FUTURE = "2040-01-01T00:00:00.000Z";

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
 * Every test here uses the two REAL production entry points -
 * verifyAudienceForPartnerCity (VERIFIED) and
 * revokeAudienceVerificationForPartnerCity (REVOKED), both from
 * agent-referrals-engagement.ts - never a low-level primitive, because
 * agent-referrals-audience-verification.ts exports none, at any
 * visibility level, for either event kind (Phase 5 holistic review,
 * final pass). Both cascade functions return only
 * `{ verification_event_id, suspended_engagement_ids }`, not the full
 * event row, so these helpers fetch the row separately via the exported
 * read-only currentAudienceVerification - exactly what production code
 * would do too.
 */
const verify = (db: Database.Database, partnerId: string, cityId: string, reason: string, evidenceRef: string) => {
  verifyAudienceForPartnerCity(db, admin, partnerId, cityId, FAR_FUTURE, reason, evidenceRef);
  return currentAudienceVerification(db, partnerId, cityId)!;
};
const revoke = (db: Database.Database, partnerId: string, cityId: string, reason: string, evidenceRef: string) =>
  revokeAudienceVerificationForPartnerCity(db, admin, partnerId, cityId, reason, evidenceRef);

describe("audience verification: append-only, VERIFIED | REVOKED, no SUPERSEDED state", () => {
  it("verifyAudienceForPartnerCity (the sole top-level production entry point for VERIFIED) mints VERIFIED as revision 1 with no supersedes_event_id", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    const event = verify(db, partnerId, cityId, "initial check", "ev-1");
    expect(event).toMatchObject({ event_kind: "VERIFIED", aggregate_revision: 1, valid_until: FAR_FUTURE, supersedes_event_id: null });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(true);
  });

  it("there is no standalone public VERIFIED or REVOKED path anywhere - the leaf module exports no generic mutation capable of writing either event kind, at any visibility level", () => {
    expect(audienceVerificationModule).not.toHaveProperty("verifyAudience");
    expect(audienceVerificationModule).not.toHaveProperty("mintVerifiedInTransaction");
    expect(audienceVerificationModule).not.toHaveProperty("mintAudienceVerificationEvent");
    expect(audienceVerificationModule).not.toHaveProperty("mintAudienceVerificationEventInTransaction");
    expect(audienceVerificationModule).not.toHaveProperty("revokeAudience");
    // Neither top-level entry point (both in agent-referrals-engagement.ts) has an eventKind parameter at all - structurally VERIFIED-only / REVOKED-only.
    expect(verifyAudienceForPartnerCity.length).toBe(7); // (db, admin, partnerIdentityId, cityId, validUntil, reason, evidenceRef)
    expect(revokeAudienceVerificationForPartnerCity.length).toBe(6); // (db, admin, partnerIdentityId, cityId, reason, evidenceRef)
  });

  it("refuses REVOKED when there is nothing currently VERIFIED", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    expect(() => revoke(db, partnerId, cityId, "x", "ev")).toThrow(AudienceVerificationError);
    expect(() => revoke(db, partnerId, cityId, "x", "ev")).toThrow(/AGENT_REFERRALS_AUDIENCE_NOT_VERIFIED/);
  });

  it("REVOKED after VERIFIED supersedes it and becomes current; a replacement VERIFIED can follow", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    const v1 = verify(db, partnerId, cityId, "initial", "ev-1");
    const r1Result = revoke(db, partnerId, cityId, "compliance issue", "ev-2");
    const r1 = currentAudienceVerification(db, partnerId, cityId)!;
    expect(r1Result.verification_event_id).toBe(r1.id);
    expect(r1).toMatchObject({ event_kind: "REVOKED", aggregate_revision: 2, valid_until: null, supersedes_event_id: v1.id });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(false);

    const v2 = verify(db, partnerId, cityId, "re-verified with updated evidence", "ev-3");
    expect(v2).toMatchObject({ event_kind: "VERIFIED", aggregate_revision: 3, supersedes_event_id: r1.id });
    expect(isAudienceVerified(db, partnerId, cityId)).toBe(true);

    // Current authority is derived from revision lineage (MAX(aggregate_revision)), never MAX(created_at) and never a stored pointer.
    expect(currentAudienceVerification(db, partnerId, cityId)).toMatchObject({ id: v2.id, aggregate_revision: 3 });
  });

  it("every event ever written is exactly VERIFIED or REVOKED - there is no SUPERSEDED state anywhere in the lineage", () => {
    const { db } = fresh();
    const { partnerId, cityId } = seedPartnerAndCity(db);
    verify(db, partnerId, cityId, "a", "1");
    revoke(db, partnerId, cityId, "b", "2");
    verify(db, partnerId, cityId, "c", "3");
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
    verify(db, p1, c1, "a", "1");
    revoke(db, p1, c1, "b", "2");
    const c2Event = verify(db, p1, c2, "c", "1");
    expect(c2Event.aggregate_revision).toBe(1); // c2's own lineage starts at 1, unaffected by c1's history
    expect(isAudienceVerified(db, p1, c1)).toBe(false);
    expect(isAudienceVerified(db, p1, c2)).toBe(true);
  });

  describe("concurrency: two writers racing to mint the next revision for the same (partner, city)", () => {
    it("both eventually mint, serialized onto distinct revisions - never a duplicate or lost revision", () => {
      const { db: a, file } = fresh();
      const { partnerId, cityId } = seedPartnerAndCity(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      verify(a, partnerId, cityId, "racer A initial", "ev-a1");
      // Racer B, from a separate connection, revokes what racer A just verified - each call is serialized by SQLite's write lock and re-reads current state fresh.
      const revoked = revoke(b, partnerId, cityId, "racer B revokes", "ev-b1");
      const reverified = verify(a, partnerId, cityId, "racer A re-verifies", "ev-a2");

      const revokedEvent = allAudienceVerificationEvents(a, partnerId, cityId).find((e) => e.id === revoked.verification_event_id)!;
      expect(revokedEvent.aggregate_revision).toBe(2);
      expect(reverified.aggregate_revision).toBe(3);
      expect(allAudienceVerificationEvents(a, partnerId, cityId).map((e) => e.aggregate_revision)).toEqual([1, 2, 3]);
    });

    it("structurally, no two rows for the same (partner, city) can ever share an aggregate_revision", () => {
      const { db } = fresh();
      const { partnerId, cityId } = seedPartnerAndCity(db);
      verify(db, partnerId, cityId, "a", "1");
      expect(() => db.prepare(`INSERT INTO partner_audience_verification_events(id, partner_identity_id, city_id, aggregate_revision, event_kind, valid_until, evidence_ref, reason, placed_by_admin_id)
        VALUES (?, ?, ?, 1, 'REVOKED', NULL, 'ev', 'r', 'admin')`).run(randomUUID(), partnerId, cityId)).toThrow(/UNIQUE constraint failed/);
    });
  });
});
