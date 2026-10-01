import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type LegalDocument = {
  kind: string;
  version: string;
  sha256: string;
  url: string;
};

export type LegalReleaseManifest = {
  stage: "A" | "B";
  documents: LegalDocument[];
};

const stageARequired = ["privacy", "personal_data", "account_terms", "marketing_consent"];
const stageBRequired = [...stageARequired, "course_offer", "receipt_contact", "fiscal_items", "refund_terms"];

export const legalManifestHash = (manifest: LegalReleaseManifest) => createHash("sha256")
  .update(JSON.stringify({ ...manifest, documents: [...manifest.documents].sort((left, right) => left.kind.localeCompare(right.kind)) }))
  .digest("hex");

export function activateLegalRelease(
  db: Database.Database,
  input: { storefront: "COURSES" | "LAB"; version: string; manifest: LegalReleaseManifest; actor: string },
  now = new Date().toISOString(),
) {
  if (!input.version.trim() || !input.actor.trim()) throw new Error("LEGAL_RELEASE_INPUT_INVALID");
  const required = input.manifest.stage === "B" ? stageBRequired : stageARequired;
  const byKind = new Map(input.manifest.documents.map((document) => [document.kind, document]));
  for (const kind of required) if (!byKind.has(kind)) throw new Error(`LEGAL_DOCUMENT_REQUIRED:${kind}`);
  for (const document of input.manifest.documents) {
    if (!document.version.trim() || !/^https:\/\//.test(document.url) || !/^[a-f0-9]{64}$/.test(document.sha256)) {
      throw new Error(`LEGAL_DOCUMENT_INVALID:${document.kind}`);
    }
  }
  const id = randomUUID();
  const manifestHash = legalManifestHash(input.manifest);
  const activate = db.transaction(() => {
    db.prepare("UPDATE legal_releases SET active=0 WHERE storefront=? AND active=1").run(input.storefront);
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active,created_at)
      VALUES (?,?,?,?,?,1,?)`).run(id, input.storefront, input.version.trim(), JSON.stringify(input.manifest), now, now);
    db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.actor, "LEGAL_RELEASE_ACTIVATED", "LEGAL_RELEASE", `${input.storefront}:${input.version}`,
        JSON.stringify({ stage: input.manifest.stage, manifestHash }), now);
  });
  activate.immediate();
  return { id, storefront: input.storefront, version: input.version.trim(), stage: input.manifest.stage, manifestHash, effectiveAt: now };
}

export function currentLegalRelease(db: Database.Database, storefront: "COURSES" | "LAB") {
  const row = db.prepare(`SELECT version,manifest_json AS manifest,effective_at AS effectiveAt
    FROM legal_releases WHERE storefront=? AND active=1`).get(storefront) as { version: string; manifest: string; effectiveAt: string } | undefined;
  return row ? { ...row, manifest: JSON.parse(row.manifest) as LegalReleaseManifest } : null;
}
