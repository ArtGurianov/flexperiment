import type Database from "better-sqlite3";
import { activateLegalRelease, legalManifestHash, type LegalReleaseManifest } from "../../src/legal-control";
import { recordAuthenticatedConsents } from "../../src/authenticated-consents";
import { stageALegalManifest } from "./legal";

/** Synthetic positive test fixture only. Never runtime admission or launch legal material. */
export function confirmSyntheticAccount(db: Database.Database, customerId: string) {
  const customer = db.prepare("SELECT email_normalized,auth_user_id FROM customers WHERE id=?").get(customerId) as { email_normalized: string; auth_user_id: string | null };
  if (!customer) throw new Error("SYNTHETIC_CUSTOMER_MISSING");
  const userId = customer.auth_user_id ?? `synthetic-user-${customerId}`;
  if (!customer.auth_user_id) {
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run(userId, "Synthetic", customer.email_normalized);
    db.prepare("UPDATE customers SET auth_user_id=? WHERE id=?").run(userId, customerId);
  }
  let release = db.prepare("SELECT version,manifest_json FROM legal_releases WHERE storefront='COURSES' AND active=1").get() as { version: string; manifest_json: string } | undefined;
  if (!release) {
    activateLegalRelease(db, { storefront: "COURSES", version: "synthetic-required-v1", manifest: stageALegalManifest, actor: "isolated-test" });
    release = { version: "synthetic-required-v1", manifest_json: JSON.stringify(stageALegalManifest) };
  }
  let manifest = JSON.parse(release.manifest_json) as LegalReleaseManifest;
  if (!Array.isArray(manifest.documents)) {
    manifest = stageALegalManifest;
    db.prepare("UPDATE legal_releases SET manifest_json=? WHERE storefront='COURSES' AND active=1").run(JSON.stringify(manifest));
  }
  recordAuthenticatedConsents(db, customerId, { storefront: "COURSES", releaseVersion: release.version,
    manifestSha256: legalManifestHash(manifest), actionKey: `synthetic-required-${customerId}`, personalDataConsent: true,
    accountTermsAccepted: true, marketingConsent: false });
}
