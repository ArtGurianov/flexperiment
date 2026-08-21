import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import type { LegalManifest } from "../src/legal-manifest";
import { LegalReleasePublishError, publishLegalRelease } from "../src/legal-release";

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
    expect(db.prepare("SELECT version, active FROM legal_releases").get()).toMatchObject({ version: "2026-08-21.1", active: 1 });
    expect(db.prepare("SELECT action, release_version, manifest_sha256 FROM legal_release_publish_events").get()).toMatchObject({ action: "PUBLISHED", release_version: "2026-08-21.1", manifest_sha256: result.manifestSha256 });
  });

  it("replays an identical active release without creating another release", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const release = { version: "2026-08-21.1", manifest: manifest() };
    const first = publishLegalRelease(db, release);
    const replay = publishLegalRelease(db, release);
    expect(replay).toMatchObject({ id: first.id, published: false, manifestSha256: first.manifestSha256 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT action FROM legal_release_publish_events ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ action: "REPLAY_VERIFIED" });
  });

  it("fails closed when a version is reused with a different manifest", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest() });
    expect(() => publishLegalRelease(db, { version: "2026-08-21.1", manifest: manifest("e".repeat(64)) })).toThrow(LegalReleasePublishError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases WHERE active = 1").get()).toMatchObject({ count: 1 });
  });
});
