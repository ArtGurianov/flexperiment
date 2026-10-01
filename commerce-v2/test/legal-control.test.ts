import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { activateLegalRelease, currentLegalRelease, legalManifestHash, type LegalReleaseManifest } from "../src/legal-control";
import { migrateV2 } from "../src/db";

const document = (kind: string) => ({ kind, version: "v1", sha256: "a".repeat(64), url: `https://flexperiment.ru/legal/${kind}` });
const stageA: LegalReleaseManifest = { stage: "A", documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map(document) };

describe("legal release control", () => {
  it("activates one immutable manifest at a time and audits its digest", () => {
    const db = new Database(":memory:"); migrateV2(db);
    const first = activateLegalRelease(db, { storefront: "COURSES", version: "stage-a-v1", manifest: stageA, actor: "owner" });
    expect(first.manifestHash).toBe(legalManifestHash(stageA));
    activateLegalRelease(db, { storefront: "COURSES", version: "stage-a-v2", manifest: stageA, actor: "owner" });
    expect(currentLegalRelease(db, "COURSES")?.version).toBe("stage-a-v2");
    expect(db.prepare("SELECT COUNT(*) AS count FROM legal_releases WHERE active=1").get()).toEqual({ count: 1 });
  });

  it("refuses an incomplete Stage B document set", () => {
    const db = new Database(":memory:"); migrateV2(db);
    expect(() => activateLegalRelease(db, { storefront: "COURSES", version: "stage-b-v1", manifest: { ...stageA, stage: "B" }, actor: "owner" }))
      .toThrow("LEGAL_DOCUMENT_REQUIRED:course_offer");
  });
});
