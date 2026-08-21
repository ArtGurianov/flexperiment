import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, legalDocumentIds, parseLegalManifest, type LegalDocumentId, type LegalManifest } from "./legal-manifest";

const currentSourcePaths: Record<LegalDocumentId, string> = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
};

export class LegalReleasePublishError extends Error {}
export type CanonicalLegalRelease = { version: string; manifest: LegalManifest };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export const parseCanonicalLegalRelease = (raw: unknown): CanonicalLegalRelease => {
  if (!raw || typeof raw !== "object") throw new LegalReleasePublishError("Canonical legal release must be a JSON object.");
  const version = (raw as Record<string, unknown>).version;
  if (typeof version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new LegalReleasePublishError("Canonical legal release version must be 1-64 safe identifier characters.");
  try { return { version, manifest: parseLegalManifest(raw) }; }
  catch (error) { throw new LegalReleasePublishError(error instanceof Error ? error.message : "Canonical legal manifest is invalid."); }
};

const archiveSourcePath = (document: LegalManifest["documents"][LegalDocumentId]) => {
  const url = new URL(document.archive_url);
  if (url.origin !== "https://flexperiment.ru" || !url.pathname.startsWith("/legal/archive/")) return undefined;
  return `public${url.pathname}`;
};

export const verifyLegalSourceHashes = (manifest: LegalManifest, root = process.cwd()) => {
  for (const id of legalDocumentIds) {
    // A versioned local archive is the publish authority whenever present. This
    // permits its immutable bytes to be deployed and verified before activation
    // without pre-emptively changing a non-versioned convenience page.
    const sourcePath = archiveSourcePath(manifest.documents[id]) ?? currentSourcePaths[id];
    const actual = sha256(readFileSync(resolve(root, sourcePath)));
    if (actual !== manifest.documents[id].sha256) throw new LegalReleasePublishError(`Canonical manifest hash does not match ${sourcePath}.`);
  }
};

/**
 * Checks the immutable archive bytes that an active checkout release actually
 * exposes. It is intentionally separate from publication and writes nothing.
 */
export const verifyLegalArchiveHashes = async (manifest: LegalManifest, request: typeof fetch = fetch) => {
  for (const id of legalDocumentIds) {
    const document = manifest.documents[id];
    let response: Response;
    try {
      response = await request(document.archive_url, { redirect: "error" });
    } catch (error) {
      throw new LegalReleasePublishError(`Unable to fetch archive for ${id}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!response.ok) throw new LegalReleasePublishError(`Archive for ${id} returned HTTP ${response.status}.`);
    const actual = sha256(Buffer.from(await response.arrayBuffer()));
    if (actual !== document.sha256) throw new LegalReleasePublishError(`Archive hash does not match the active manifest for ${id}.`);
  }
};

export const loadCanonicalLegalRelease = (filename = process.env.COMMERCE_LEGAL_MANIFEST_PATH ?? "commerce/legal/production-manifest.json") => {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(process.cwd(), filename), "utf8")); }
  catch (error) { throw new LegalReleasePublishError(`Unable to read canonical legal release manifest at ${filename}: ${error instanceof Error ? error.message : "unknown error"}`); }
  const release = parseCanonicalLegalRelease(raw);
  verifyLegalSourceHashes(release.manifest);
  return release;
};

export const publishLegalRelease = (db: Database.Database, release: CanonicalLegalRelease) => {
  const manifestJson = canonicalLegalManifest(release.manifest);
  const manifestSha256 = sha256(manifestJson);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT id, manifest_json, active FROM legal_releases WHERE version = ?").get(release.version) as { id: string; manifest_json: string; active: number } | undefined;
    if (existing) {
      let existingManifest: LegalManifest;
      try { existingManifest = parseLegalManifest(JSON.parse(existing.manifest_json)); }
      catch { throw new LegalReleasePublishError(`Existing legal release ${release.version} has an invalid manifest.`); }
      if (canonicalLegalManifest(existingManifest) !== manifestJson) throw new LegalReleasePublishError(`Legal release version ${release.version} already exists with a different manifest.`);
      if (existing.active !== 1) throw new LegalReleasePublishError(`Legal release version ${release.version} exists but is inactive; publish a new release version instead.`);
      db.prepare("INSERT INTO legal_release_publish_events(id, legal_release_id, release_version, manifest_sha256, action) VALUES (?, ?, ?, ?, 'REPLAY_VERIFIED')").run(randomUUID(), existing.id, release.version, manifestSha256);
      db.exec("COMMIT");
      return { id: existing.id, version: release.version, manifestSha256, published: false };
    }
    db.prepare("UPDATE legal_releases SET active = 0 WHERE active = 1").run();
    const releaseId = randomUUID();
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, datetime('now'), ?, 1)").run(releaseId, release.version, manifestJson);
    db.prepare("INSERT INTO legal_release_publish_events(id, legal_release_id, release_version, manifest_sha256, action) VALUES (?, ?, ?, ?, 'PUBLISHED')").run(randomUUID(), releaseId, release.version, manifestSha256);
    db.exec("COMMIT");
    return { id: releaseId, version: release.version, manifestSha256, published: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
