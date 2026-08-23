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

  it("verifies a prepared archive release without changing the active current-document copies", () => {
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-21.2");
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-21.2.draft.json").version).toBe("2026-08-21.2");
  });

  it("prepares the four-document analytics legal candidate without changing active .2 bytes", () => {
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
    for (const [candidatePath, activePath] of [
      ["public/legal/archive/offer/2026-08-22.1/public-offer.md", "public/legal/archive/offer/2026-08-21.2/public-offer.md"],
      ["public/legal/archive/privacy/2026-08-22.1/personal-data-consent.md", "public/legal/personal-data-consent.md"],
      ["public/legal/archive/checkout-disclosure/2026-08-22.1/disclaimer.md", "public/legal/archive/checkout-disclosure/2026-08-21.2/disclaimer.md"],
    ]) {
      expect(readFileSync(candidatePath)).toEqual(readFileSync(activePath));
    }
    const active = loadCanonicalLegalRelease("commerce/legal/production-manifest.json");
    expect(active.version).toBe("2026-08-21.2");
    expect(active.manifest.documents.PRIVACY_POLICY.sha256).toBe("7d6935b2e7ed4b8381d07ddb86748fdadafb30519de82404fbd7c0df48dde541");
    expect(readFileSync("public/legal/archive/privacy/2026-08-21.2/privacy-policy.md")).toEqual(
      readFileSync("public/legal/privacy-policy.md"),
    );
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
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-21.2");
  });

  it("prepares the Customer and Participant candidate without changing the active release", () => {
    const candidate = loadCanonicalLegalRelease("commerce/legal/production-manifest.2026-08-23.2.draft.json");
    expect(candidate.version).toBe("2026-08-23.2");
    expect(candidate.manifest.documents).toMatchObject({
      PUBLIC_OFFER: {
        version: "2026-08-23",
        archive_url: "https://flexperiment.ru/legal/archive/offer/2026-08-23.2/public-offer.md",
      },
      PRIVACY_POLICY: {
        archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-23.2/privacy-policy.md",
      },
      PD_CONSENT: {
        archive_url: "https://flexperiment.ru/legal/archive/privacy/2026-08-23.2/personal-data-consent.md",
      },
      CHECKOUT_DISCLOSURE: {
        archive_url: "https://flexperiment.ru/legal/archive/checkout-disclosure/2026-08-23.2/disclaimer.md",
      },
    });
    const offer = readFileSync("public/legal/archive/offer/2026-08-23.2/public-offer.md", "utf8");
    const privacy = readFileSync("public/legal/archive/privacy/2026-08-23.2/privacy-policy.md", "utf8");
    const consent = readFileSync("public/legal/archive/privacy/2026-08-23.2/personal-data-consent.md", "utf8");
    const disclosure = readFileSync("public/legal/archive/checkout-disclosure/2026-08-23.2/disclaimer.md", "utf8");
    expect(offer).toContain("лицу, в пользу которого заключён договор");
    expect(offer).toContain("пункта 2 статьи 430 ГК РФ");
    expect(offer).toContain("Заказчик как его законный представитель");
    expect(offer).not.toContain("приобретает участие исключительно для себя");
    expect(privacy).toContain("пунктом 5 части 1 статьи 6 Федерального закона № 152-ФЗ");
    expect(consent).toContain("не является согласием, данным мною от имени Участника");
    expect(consent).toContain("Если обработка осуществляется лицом по поручению Оператора");
    for (const document of [offer, disclosure]) {
      expect(document).toContain("младше 14 лет");
      expect(document).toContain("сопровождении совершеннолетнего взрослого");
      expect(document).not.toMatch(/0\+|14\+|16\+|18\+ участия/);
    }
    expect(createHash("sha256").update(canonicalLegalManifest(candidate.manifest)).digest("hex")).toBe(
      "bb96c89259c99d085b7277796f93525b96c43bea3e8d7e66c5b4c0f98a03bc9a",
    );
    expect(loadCanonicalLegalRelease("commerce/legal/production-manifest.json").version).toBe("2026-08-21.2");
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
    expect(createHash("sha256").update(canonicalLegalManifest(release.manifest)).digest("hex")).toBe("733252eca0c6a298e6bf662bbe54bc8d73c0c7cb03df9e173b3ce7da1aa43589");
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
