import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalLegalManifest, parseLegalManifest } from "../legal-manifest";

/**
 * What legal configuration this database is actually bound to.
 *
 * The digest is recomputed from the parsed manifest rather than hashed off the
 * stored text. The two agree today because publication writes the canonical
 * form, but hashing the column would make readiness depend on how a row was
 * spelled instead of on what it says - and a re-serialization that changed
 * nothing legally would read as a different legal release.
 *
 * An absent or unreadable active release answers undefined. Readiness turns
 * that into a refusal to admit, which is the correct direction: a runtime whose
 * legal binding cannot be established has not converged on anything.
 */
export const activeLegalBinding = (db: Database.Database): { readonly version: string; readonly manifestSha256: string } | undefined => {
  const row = db.prepare("SELECT version, manifest_json FROM legal_releases WHERE active = 1")
    .get() as { version: string; manifest_json: string } | undefined;
  if (!row) return undefined;
  try {
    const canonical = canonicalLegalManifest(parseLegalManifest(JSON.parse(row.manifest_json)));
    return { version: row.version, manifestSha256: createHash("sha256").update(canonical).digest("hex") };
  } catch {
    return undefined;
  }
};
