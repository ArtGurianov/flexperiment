import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { type LegalManifest } from "../src/legal-manifest";
import { LegalReleasePublishError, loadCanonicalLegalRelease, publishLegalRelease, verifyCurrentLegalSourceHashes, verifyLegalArchiveHashes } from "../src/legal-release";

const manifest = (offerHash = "a".repeat(64)): LegalManifest => ({ documents: {
  PUBLIC_OFFER: { document_id: "PUBLIC_OFFER", version: "2026-08-20", sha256: offerHash, current_url: "https://flexperiment.ru/legal/public-offer.md", archive_url: "https://archive.flexperiment.ru/legal/2026-08-21.1/public-offer.md", checkout_relevant: true },
  PRIVACY_POLICY: { document_id: "PRIVACY_POLICY", version: "2026-08-12", sha256: "b".repeat(64), current_url: "https://flexperiment.ru/legal/privacy-policy.md", archive_url: "https://archive.flexperiment.ru/legal/2026-08-21.1/privacy-policy.md", checkout_relevant: true },
  PD_CONSENT: { document_id: "PD_CONSENT", version: "2026-08-12", sha256: "c".repeat(64), current_url: "https://flexperiment.ru/legal/personal-data-consent.md", archive_url: "https://archive.flexperiment.ru/legal/2026-08-21.1/personal-data-consent.md", checkout_relevant: true },
  CHECKOUT_DISCLOSURE: { document_id: "CHECKOUT_DISCLOSURE", version: "2026-08-12", sha256: "d".repeat(64), current_url: "https://flexperiment.ru/legal/disclaimer.md", archive_url: "https://archive.flexperiment.ru/legal/2026-08-21.1/disclaimer.md", checkout_relevant: true },
} });

describe("production legal-release publisher", () => {
  const databases: ReturnType<typeof openDatabase>[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it("publishes the first release and records durable evidence", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const result = publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest() });
    expect(result.published).toBe(true);
    expect(result.effectiveAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(db.prepare("SELECT version, active FROM legal_releases").get()).toMatchObject({ version: "2026-08-21.1", active: 1 });
    expect(db.prepare("SELECT action, release_version, manifest_sha256 FROM legal_release_publish_events").get()).toMatchObject({ action: "PUBLISHED", release_version: "2026-08-21.1", manifest_sha256: result.manifestSha256 });
  });

  it("replays an identical active release without creating another release", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const release = { version: "2026-08-21.1", manifest: manifest() };
    const first = publishLegalRelease(db, release);
    const replay = publishLegalRelease(db, release);
    expect(replay).toMatchObject({ id: first.id, published: false, manifestSha256: first.manifestSha256, effectiveAt: first.effectiveAt });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT action FROM legal_release_publish_events ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ action: "REPLAY_VERIFIED" });
  });

  it("fails closed when a version is reused with a different manifest", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest() });
    expect(() => publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest("e".repeat(64)) })).toThrow(LegalReleasePublishError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases WHERE active = 1").get()).toMatchObject({ count: 1 });
  });

  it("rejects an unexpected candidate manifest before changing the active release", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const first = publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest() });
    expect(() => publishLegalRelease(db, { version: "2026-08-25.1", manifest: manifest("e".repeat(64)) }, { expectedManifestSha256: "f".repeat(64) }))
      .toThrow(/Candidate legal manifest/);
    expect(db.prepare("SELECT version, active FROM legal_releases WHERE active = 1").get()).toEqual({ version: first.version, active: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases").get()).toEqual({ count: 1 });
  });

  it("loads the active release the runtime will actually publish", () => {
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-28.1");
  });





  it("keeps current Flexperiment legal documents free of legacy operator contacts", () => {
    const currentDocuments = [
      "public/legal/privacy-policy.md",
      "public/legal/personal-data-consent.md",
      "public/legal/public-offer.md",
      "public/legal/disclaimer.md",
    ].map((filename) => readFileSync(filename, "utf8"));
    for (const document of currentDocuments) {
      expect(document).not.toMatch(/flextatic\.ru|art@artgurianov\.com/i);
    }
  });

  it("keeps every current legal convenience file byte-identical to the canonical manifest", () => {
    const release = loadCanonicalLegalRelease("commerce/legal/production-manifest.json");
    expect(() => verifyCurrentLegalSourceHashes(release.manifest)).not.toThrow();
    expect(release.version).toBe("2026-08-28.1");
    expect(release.manifest.documents.PUBLIC_OFFER.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifies every active archive URL against its manifest hash", async () => {
    const bytes = new TextEncoder().encode("immutable archive");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const active = manifest(hash);
    for (const document of Object.values(active.documents)) document.sha256 = hash;
    await expect(verifyLegalArchiveHashes(active, async () => new Response(bytes, { status: 200 }))).resolves.toBeUndefined();
    await expect(verifyLegalArchiveHashes(active, async () => new Response("changed", { status: 200 }))).rejects.toThrow("Archive hash does not match");
    await expect(verifyLegalArchiveHashes(active, async () => new Response(null, { status: 404 }))).rejects.toThrow("returned HTTP 404");
  });

  it("refuses a second active legal release, even through direct SQL", () => {
    // The publisher promotes by deactivating the incumbent and activating the
    // successor, so the application path never produces two. This index is what
    // holds when the writer is not the application - a restore, a repair, a
    // hand-run UPDATE - because two active releases means two different sets of
    // terms are simultaneously the ones a customer agreed to.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const insert = (id: string, version: string, active: number) => db
      .prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, '2026-09-20T00:00:00Z', '{}', ?)")
      .run(id, version, active);

    insert("first", "2026-09-20.1", 1);
    expect(() => insert("second", "2026-09-20.2", 1)).toThrow(/UNIQUE constraint failed: legal_releases.active/);
    // An inactive successor is fine; it is only ever one at a time that is live.
    expect(() => insert("second", "2026-09-20.2", 0)).not.toThrow();

    // Deactivating the incumbent is the only way the successor becomes active.
    db.prepare("UPDATE legal_releases SET active = 0 WHERE id = 'first'").run();
    expect(() => db.prepare("UPDATE legal_releases SET active = 1 WHERE id = 'second'").run()).not.toThrow();
  });
});
