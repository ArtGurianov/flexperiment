import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { canonicalLegalManifest, type LegalManifest } from "../src/legal-manifest";
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

  it("verifies the active archive release and a prepared historical candidate", () => {
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-25.1");
    expect(JSON.parse(readFileSync("commerce/legal/production-manifest.2026-08-21.2.draft.json", "utf8"))).toMatchObject({
      version: "2026-08-21.2",
    });
  });

  it("preserves the four-document analytics legal candidate as an immutable historical release", () => {
    const candidate = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-22.1.draft.json");
    expect(candidate.version).toBe("2026-08-22.1");
    expect(Object.keys(candidate.manifest.documents)).toEqual([
      "PUBLIC_OFFER",
      "PRIVACY_POLICY",
      "PD_CONSENT",
      "CHECKOUT_DISCLOSURE",
    ]);
    expect(candidate.manifest.documents.PRIVACY_POLICY.version).toBe("2026-08-22");
    expect(candidate.manifest.documents.PD_CONSENT).toMatchObject({
      version: "2026-08-12",
      sha256: "8ef14cdd772813635f6bf1f43d758b9f2383283df3d905fd2d43965e671f1b11",
      archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-22.1/personal-data-consent.md",
    });
    expect(readFileSync("public/legal/archive/privacy/2026-08-22.1/privacy-policy.md")).not.toEqual(
      readFileSync("public/legal/archive/privacy/2026-08-21.2/privacy-policy.md"),
    );
    const active = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-23.2.draft.json");
    expect(active.version).toBe("2026-08-23.2");
    expect(active.manifest.documents.PRIVACY_POLICY.sha256).toBe("97ac1add022f8ca4f870647c7abc525cf9b32a6edcc12fcd2484339769497864");
    expect(createHash("sha256").update(readFileSync("public/legal/archive/privacy/2026-08-23.2/privacy-policy.md")).digest("hex"))
      .toBe("97ac1add022f8ca4f870647c7abc525cf9b32a6edcc12fcd2484339769497864");
  });

  it("prepares the city-interest legal candidate without changing the active release", () => {
    const candidate = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-23.1.draft.json");
    expect(candidate.version).toBe("2026-08-23.1");
    expect(candidate.manifest.documents.PRIVACY_POLICY).toMatchObject({
      version: "2026-08-23",
      archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-23.1/privacy-policy.md",
    });
    expect(candidate.manifest.documents.PD_CONSENT).toMatchObject({
      version: "2026-08-23",
      archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-23.1/personal-data-consent.md",
    });
    expect(readFileSync("public/legal/archive/privacy/2026-08-23.1/privacy-policy.md", "utf8")).toContain(
      "уведомления о появлении мастер-класса Flexperiment в выбранном им городе",
    );
    expect(readFileSync("public/legal/archive/privacy/2026-08-23.1/personal-data-consent.md", "utf8")).toContain(
      "если я направил соответствующий запрос через форму на Сайте",
    );
    expect(createHash("sha256").update(canonicalLegalManifest(candidate.manifest)).digest("hex")).toBe(
      "c62da8ac3ed8f119f4d46b1aa7864d7df2494bd7a3499fab2080bb696e8739cb",
    );
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-25.1");
  });

  it("keeps the booking-time age-band draft immutable after promotion", () => {
    const candidate = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-25.1.draft.json");
    expect(candidate.version).toBe("2026-08-25.1");
    expect(candidate.manifest.documents).toMatchObject({
      PUBLIC_OFFER: {
        version: "2026-08-25",
        archive_url: "https://flexperiment.ru/legal/archive/offer/2026-08-25.1/public-offer.md",
      },
      PRIVACY_POLICY: {
        archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-25.1/privacy-policy.md",
      },
      PD_CONSENT: {
        archive_url: "https://flexperiment.ru/legal/archive/personal-data-consent/2026-08-25.1/personal-data-consent.md",
      },
      CHECKOUT_DISCLOSURE: {
        archive_url: "https://flexperiment.ru/legal/archive/checkout-disclosure/2026-08-25.1/disclaimer.md",
      },
    });
    const offer = readFileSync("public/legal/archive/offer/2026-08-25.1/public-offer.md", "utf8");
    const privacy = readFileSync("public/legal/archive/privacy/2026-08-25.1/privacy-policy.md", "utf8");
    const consent = readFileSync("public/legal/archive/personal-data-consent/2026-08-25.1/personal-data-consent.md", "utf8");
    const disclosure = readFileSync("public/legal/archive/checkout-disclosure/2026-08-25.1/disclaimer.md", "utf8");
    expect(offer).toContain("лицу, в пользу которого заключён договор");
    expect(offer).toContain("пункта 2 статьи 430 ГК РФ");
    expect(offer).toContain("Заказчик как его законный представитель");
    expect(offer).not.toContain("приобретает участие исключительно для себя");
    expect(privacy).toContain("пунктом 5 части 1 статьи 6 Федерального закона № 152-ФЗ");
    expect(consent).toContain("не является согласием, данным мною от имени Участника");
    expect(consent).toContain("Если обработка осуществляется лицом по поручению Оператора");
    expect(privacy).toContain("категорию возраста");
    expect(privacy).toContain("не запрашивается и не сохраняется в заказе; запрос с таким полем отклоняется");
    expect(consent).toContain("Категория возраста фиксируется на момент оформления заказа");
    for (const document of [offer, disclosure]) {
      expect(document).toContain("не исполнилось 14 лет");
      expect(document).toContain("сопровождении совершеннолетнего взрослого");
      expect(document).not.toMatch(/0\+|14\+|16\+|18\+ участия/);
    }
    expect(createHash("sha256").update(canonicalLegalManifest(candidate.manifest)).digest("hex")).toBe(
      "b839689ec7fed1e0b899c4d6298d32297f0142b6e572985cf9eb47a4830ebb47",
    );
    expect(JSON.parse(readFileSync("commerce/legal/production-manifest.2026-08-25.1.draft.json", "utf8"))).toMatchObject({
      publish_time: "PENDING_AUTHORITATIVE_PUBLISH_TIMESTAMP",
    });
    const active = loadCanonicalLegalRelease("commerce/legal/production-manifest.json");
    expect(active.version).toBe("2026-08-25.1");
    expect(() => verifyCurrentLegalSourceHashes(active.manifest)).not.toThrow();
  });

  it("prepares an anonymous checkout candidate without changing the active legal release", () => {
    const candidate = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-26.1.draft.json");
    expect(candidate.version).toBe("2026-08-26.1");
    expect(candidate.manifest.documents.PRIVACY_POLICY).toMatchObject({
      version: "2026-08-26",
      archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-26.1/privacy-policy.md",
    });
    expect(candidate.manifest.documents.PD_CONSENT).toMatchObject({
      version: "2026-08-26",
      archive_url: "https://flexperiment.ru/legal/archive/personal-data-consent/2026-08-26.1/personal-data-consent.md",
    });
    const privacy = readFileSync("public/legal/archive/privacy/2026-08-26.1/privacy-policy.md", "utf8");
    const consent = readFileSync("public/legal/archive/personal-data-consent/2026-08-26.1/personal-data-consent.md", "utf8");
    expect(privacy).toContain("Оператор не собирает имя Заказчика или Участника через форму оформления заказа");
    expect(consent).toContain("Оператор не собирает имя Участника");
    expect(privacy).toContain("исторические сведения заказа");
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-25.1");
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
    expect(release.version).toBe("2026-08-25.1");
    expect(release.manifest.documents.PUBLIC_OFFER.sha256).toBe("bd20b056a269ed1286c6ea35a728fbfd58e90a2f845b72ac112fe3544ec9ecaf");
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
});
