import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { mintOrdProviderProfile, currentOrdProviderProfile, ordProviderProfileById, OrdProviderProfileError } from "../src/agent-referrals-ord-provider-profile";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "ord-provider-profile-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const admin = "admin-1";

describe("mintOrdProviderProfile", () => {
  it("mints revision 1 with no predecessor, then revision 2 superseding it", () => {
    const db = fresh();
    const v1 = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC" }, "seed");
    expect(v1.revision).toBe(1);
    expect(v1.supersedes_revision_id).toBeNull();
    const v2 = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { legal_name: "Flexperiment LLC v2" }, "correction");
    expect(v2.revision).toBe(2);
    expect(v2.supersedes_revision_id).toBe(v1.id);
    expect(currentOrdProviderProfile(db, "COUNTERPARTY")!.id).toBe(v2.id);
  });

  it("each profile_kind has its own independent revision sequence", () => {
    const db = fresh();
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { a: 1 }, "seed");
    mintOrdProviderProfile(db, admin, "COUNTERPARTY", { a: 2 }, "seed");
    const platform = mintOrdProviderProfile(db, admin, "PLATFORM", { b: 1 }, "seed");
    expect(platform.revision).toBe(1);
  });

  it("round-2 P1.2: content_hash is a real RECURSIVE canonical hash - a nested-only semantic change always changes it", () => {
    const db = fresh();
    const a = mintOrdProviderProfile(db, admin, "CONTRACT", { provider: { account: "A" } }, "seed");
    const b = mintOrdProviderProfile(db, admin, "CONTRACT", { provider: { account: "B" } }, "changed nested field");
    expect(a.content_hash).not.toBe(b.content_hash);
  });

  it("round-2 P1.2: different key insertion order for semantically-identical content produces the SAME hash", () => {
    const db = fresh();
    const a = mintOrdProviderProfile(db, admin, "MEDIA", { z: 1, a: 2 }, "seed");
    const b = mintOrdProviderProfile(db, admin, "PLATFORM", { a: 2, z: 1 }, "seed"); // different kind so both can be revision 1, but identical content
    expect(a.content_hash).toBe(b.content_hash);
  });
});

describe("round-2 P1.1: structural revision lineage (raw SQL)", () => {
  it("revision 1 must have no predecessor (CHECK)", () => {
    const db = fresh();
    expect(() => db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, supersedes_revision_id, reason, created_by_admin_id)
      VALUES ('p1', 'COUNTERPARTY', 1, '{}', 'h', 'fake-predecessor', 'seed', 'admin')`).run()).toThrow(/CHECK constraint failed/);
  });

  it("revision > 1 with a NULL predecessor is refused (CHECK forbids NULL, and the lineage guard finds no matching predecessor either)", () => {
    const db = fresh();
    expect(() => db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, reason, created_by_admin_id)
      VALUES ('p1', 'COUNTERPARTY', 2, '{}', 'h', 'seed', 'admin')`).run()).toThrow(/CHECK constraint failed|ORD_PROVIDER_PROFILE_REVISION_LINEAGE_INCONSISTENT/);
  });

  it("a raw INSERT naming a predecessor that is NOT exactly revision - 1 for the SAME kind is refused", () => {
    const db = fresh();
    const v1 = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { a: 1 }, "seed");
    // revision 3 naming v1 (revision 1) as predecessor, skipping revision 2.
    expect(() => db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, supersedes_revision_id, reason, created_by_admin_id)
      VALUES ('p3', 'COUNTERPARTY', 3, '{}', 'h', ?, 'seed', 'admin')`).run(v1.id)).toThrow(/ORD_PROVIDER_PROFILE_REVISION_LINEAGE_INCONSISTENT/);
  });

  it("a raw INSERT naming a predecessor of a DIFFERENT profile_kind is refused (cross-kind)", () => {
    const db = fresh();
    const counterparty = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { a: 1 }, "seed");
    expect(() => db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, supersedes_revision_id, reason, created_by_admin_id)
      VALUES ('p2', 'CONTRACT', 2, '{}', 'h', ?, 'seed', 'admin')`).run(counterparty.id)).toThrow(/ORD_PROVIDER_PROFILE_REVISION_LINEAGE_INCONSISTENT/);
  });
});

describe("immutability", () => {
  it("is immutable and delete-protected", () => {
    const db = fresh();
    const v1 = mintOrdProviderProfile(db, admin, "COUNTERPARTY", { a: 1 }, "seed");
    expect(() => db.prepare("UPDATE ord_provider_profile_revisions SET content_json = '{}' WHERE id = ?").run(v1.id)).toThrow(/ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM ord_provider_profile_revisions WHERE id = ?").run(v1.id)).toThrow(/ORD_PROVIDER_PROFILE_REVISION_IMMUTABLE/);
  });
});

describe("errors / readers", () => {
  it("OrdProviderProfileError carries a code and status", () => {
    const err = new OrdProviderProfileError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });

  it("currentOrdProviderProfile returns null when no profile exists yet", () => {
    const db = fresh();
    expect(currentOrdProviderProfile(db, "MEDIA")).toBeNull();
  });

  it("ordProviderProfileById returns null for an unknown id", () => {
    const db = fresh();
    expect(ordProviderProfileById(db, "nonexistent")).toBeNull();
  });
});
