import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { legalManifestHash, type LegalReleaseManifest } from "./legal-control";
import type { Storefront } from "./origins";

const kinds = ["personal_data", "account_terms", "marketing_consent"] as const;
export type AuthenticatedConsentInput = {
  storefront: Storefront; releaseVersion: string; manifestSha256: string; actionKey: string;
  personalDataConsent: boolean; accountTermsAccepted: boolean; marketingConsent: boolean;
};
type Release = { id: string; version: string; manifest: LegalReleaseManifest; manifestSha256: string };
const activeRelease = (db: Database.Database, storefront: Storefront): Release | null => {
  const row = db.prepare("SELECT id,version,manifest_json FROM legal_releases WHERE storefront=? AND active=1")
    .get(storefront) as { id: string; version: string; manifest_json: string } | undefined;
  if (!row) return null;
  const manifest = JSON.parse(row.manifest_json) as LegalReleaseManifest;
  if (kinds.some(kind => manifest.documents.filter(document => document.kind === kind).length !== 1)) {
    throw new Error("LEGAL_RELEASE_INCOMPLETE");
  }
  return { id: row.id, version: row.version, manifest, manifestSha256: legalManifestHash(manifest) };
};
const verifiedUser = (db: Database.Database, customerId: string) => db.prepare(`SELECT u.id FROM customers c
  JOIN "user" u ON u.id=c.auth_user_id WHERE c.id=? AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized`)
  .get(customerId) as { id: string } | undefined;

/** Latest explicit account choice wins; invalid/stale new evidence must not revive legacy grants. */
export function authenticatedMarketingChoice(db: Database.Database, customerId: string): boolean | undefined {
  const latest = db.prepare(`SELECT e.granted,e.document_version,e.document_sha256,a.auth_user_id,a.storefront,a.legal_release_id
    FROM authenticated_consent_events e JOIN authenticated_consent_actions a ON a.id=e.action_id
    WHERE a.customer_id=? AND e.kind='marketing_consent' ORDER BY e.sequence DESC LIMIT 1`)
    .get(customerId) as { granted: number; document_version: string; document_sha256: string; auth_user_id: string;
      storefront: Storefront; legal_release_id: string } | undefined;
  if (!latest) return undefined;
  const user = verifiedUser(db, customerId);
  const release = activeRelease(db, latest.storefront);
  const document = release?.manifest.documents.find(candidate => candidate.kind === "marketing_consent");
  return Boolean(user && user.id === latest.auth_user_id && release?.id === latest.legal_release_id
    && document?.version === latest.document_version && document.sha256 === latest.document_sha256 && latest.granted === 1);
}

/** Read-only status of NEW authenticated events; historical legacy/intent rows never qualify. */
export function authenticatedConsentStatus(db: Database.Database, customerId: string, storefront: Storefront) {
  const user = verifiedUser(db, customerId);
  const release = activeRelease(db, storefront);
  const choices: Record<typeof kinds[number], boolean> = { personal_data: false, account_terms: false, marketing_consent: false };
  if (user && release) {
    for (const kind of kinds) {
      const document = release.manifest.documents.find(candidate => candidate.kind === kind)!;
      const event = db.prepare(`SELECT e.granted FROM authenticated_consent_events e JOIN authenticated_consent_actions a ON a.id=e.action_id
        WHERE a.customer_id=? AND a.auth_user_id=? AND a.storefront=? AND a.legal_release_id=?
          AND e.kind=? AND e.document_version=? AND e.document_sha256=? ORDER BY e.sequence DESC LIMIT 1`)
        .get(customerId, user.id, storefront, release.id, kind, document.version, document.sha256) as { granted: number } | undefined;
      choices[kind] = event?.granted === 1;
    }
  }
  return { storefront, verifiedAccount: Boolean(user), releaseVersion: release?.version ?? null,
    manifestSha256: release?.manifestSha256 ?? null, requiredChoicesConfirmed: choices.personal_data && choices.account_terms,
    choices, documents: release?.manifest.documents ?? [] };
}

/** Caller must derive customerId from an active session, never from the request body. */
export function recordAuthenticatedConsents(db: Database.Database, customerId: string, input: AuthenticatedConsentInput,
  now = new Date().toISOString()) {
  if (!input || !["COURSES", "LAB"].includes(input.storefront) || input.personalDataConsent !== true || input.accountTermsAccepted !== true
    || typeof input.marketingConsent !== "boolean" || typeof input.actionKey !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(input.actionKey)
    || typeof input.releaseVersion !== "string" || !input.releaseVersion || typeof input.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(input.manifestSha256)) {
    throw new Error("AUTHENTICATED_CONSENT_INPUT_INVALID");
  }
  return db.transaction(() => {
    const user = verifiedUser(db, customerId);
    if (!user) throw new Error("VERIFIED_ACCOUNT_REQUIRED");
    const release = activeRelease(db, input.storefront);
    if (!release) throw new Error("LEGAL_RELEASE_NOT_FOUND");
    if (release.version !== input.releaseVersion || release.manifestSha256 !== input.manifestSha256) throw new Error("LEGAL_RELEASE_STALE");
    const hash = createHash("sha256").update(JSON.stringify([release.id, input.personalDataConsent, input.accountTermsAccepted, input.marketingConsent])).digest("hex");
    const prior = db.prepare(`SELECT id,request_sha256,auth_user_id FROM authenticated_consent_actions WHERE customer_id=? AND storefront=? AND action_key=?`)
      .get(customerId, input.storefront, input.actionKey) as { id: string; request_sha256: string; auth_user_id: string } | undefined;
    if (prior && (prior.request_sha256 !== hash || prior.auth_user_id !== user.id)) throw new Error("CONSENT_ACTION_KEY_CONFLICT");
    const actionId = prior?.id ?? randomUUID();
    if (!prior) {
      db.prepare(`INSERT INTO authenticated_consent_actions(id,customer_id,auth_user_id,storefront,legal_release_id,action_key,request_sha256,recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(actionId, customerId, user.id, input.storefront, release.id, input.actionKey, hash, now);
      for (const kind of kinds) {
        const document = release.manifest.documents.find(candidate => candidate.kind === kind)!;
        db.prepare(`INSERT INTO authenticated_consent_events(action_id,kind,granted,document_version,document_sha256)
          VALUES (?,?,?,?,?)`).run(actionId, kind, kind === "marketing_consent" ? Number(input.marketingConsent) : 1, document.version, document.sha256);
      }
    }
    return { actionId, replayed: Boolean(prior), status: authenticatedConsentStatus(db, customerId, input.storefront) };
  }).immediate();
}
