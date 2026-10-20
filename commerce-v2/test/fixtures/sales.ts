import type Database from "better-sqlite3";
import type { ProductCommand } from "../../src/catalog-control";
import { draftFiscalPolicy, qualifyFiscalPolicy } from "../../src/fiscal-policy";
import { legalManifestHash } from "../../src/legal-control";
import { recordOwnerLegalDecision } from "../../src/owner-legal-decision";
import type { Storefront } from "../../src/origins";
import { loadCommerceRuntimeConfig, type CommerceRuntimeConfig } from "../../src/payment-mode";
import type { StorefrontSwitchDocument } from "../../src/storefront-switch";

type TestSwitch = { generation: number; storefronts: StorefrontSwitchDocument["storefronts"]; raw?: string | Error };
const switches = new WeakMap<Database.Database, TestSwitch>();
const switchOf = (db: Database.Database) => {
  let current = switches.get(db);
  // Unrelated tests sell as before: both storefronts open at generation 1. Stop tests close them.
  if (!current) switches.set(db, current = { generation: 1, storefronts: { COURSES: { state: "OPEN", openSince: 1 }, LAB: { state: "OPEN", openSince: 1 } } });
  return current;
};

/** The owner's switch document as scripts/v2/storefront-switch.py writes it, for a test database. */
export function testStorefrontSwitchDocument(db: Database.Database, scope: StorefrontSwitchDocument["scope"] = "local"): StorefrontSwitchDocument {
  const current = switchOf(db);
  return { schema: "flexperiment.storefront-switch/1", scope, generation: current.generation,
    changedAt: "2026-10-19T09:00:00.000Z", changedBy: "owner", reason: "synthetic test switch", evidenceIssue: "ART-319",
    storefronts: current.storefronts };
}

/** Each change is a new generation; reopening a storefront starts a new opening, as the host tool does. */
export function setTestStorefronts(db: Database.Database, changes: Partial<Record<Storefront, "OPEN" | "CLOSED">>) {
  const current = switchOf(db);
  current.generation += 1;
  delete current.raw;
  for (const [storefront, state] of Object.entries(changes) as [Storefront, "OPEN" | "CLOSED"][]) {
    if (state === "CLOSED") current.storefronts[storefront] = { state: "CLOSED" };
    else if (current.storefronts[storefront].state !== "OPEN") current.storefronts[storefront] = { state: "OPEN", openSince: current.generation };
  }
  return current.generation;
}

/** Replaces what the source returns (bytes, or a read failure) until the next setTestStorefronts. */
export function setTestStorefrontSwitchRaw(db: Database.Database, raw: string | Error) { switchOf(db).raw = raw; }

/** The config with a synthetic switch of its own scope, standing in for the server's read-only host file. */
export function withTestStorefrontSwitch<T extends Pick<CommerceRuntimeConfig, "deployEnvironment">>(config: T) {
  const scope = config.deployEnvironment === "production" ? "production" : config.deployEnvironment === "staging" ? "canary" : "local";
  return { ...config, storefrontSwitch: (db: Database.Database) => {
    const current = switchOf(db);
    if (current.raw instanceof Error) throw current.raw;
    return current.raw ?? JSON.stringify(testStorefrontSwitchDocument(db, scope));
  } };
}

/** Local/test runtime: the scripted mock rail, with the same live sale-mode gate and switch production uses. */
export const testCheckoutConfig = withTestStorefrontSwitch(loadCommerceRuntimeConfig({ NODE_ENV: "test" }));

/** Opens the storefront of this product kind on the owner's switch (no-op while it is open). */
export function openTestStorefront(db: Database.Database, kind: ProductCommand["kind"] = "ONLINE_COURSE") {
  const storefront: Storefront = kind === "LAB" ? "LAB" : "COURSES";
  if (switchOf(db).storefronts[storefront].state !== "OPEN") setTestStorefronts(db, { [storefront]: "OPEN" });
}

/**
 * A QUALIFIED fiscal policy for every offer that has none, on test evidence: a paid offer sells only
 * under one (ART-233). Production qualifies each offer on its own legal basis in the Control Room.
 */
export function qualifyTestFiscalPolicies(db: Database.Database) {
  // Independent synthetic merchant text, never derived from title or the fiscal policy below.
  // This helper is test-only; migration/seed/production never fills a missing purpose.
  db.prepare("UPDATE offers SET payment_purpose='Synthetic merchant offer purpose' WHERE payment_purpose IS NULL").run();
  const offers = db.prepare(`SELECT offer.offer_ref,product.kind,product.product_ref FROM offers offer
    JOIN products product ON product.id=offer.product_id
    WHERE NOT EXISTS (SELECT 1 FROM fiscal_policy_versions p WHERE p.offer_ref=offer.offer_ref AND p.status='QUALIFIED')`)
    .all() as { offer_ref: string; kind: ProductCommand["kind"]; product_ref: string }[];
  for (const offer of offers) {
    const { policyId } = draftFiscalPolicy(db, {
      offerRef: offer.offer_ref, kind: offer.kind, itemName: `Услуга ${offer.product_ref}`,
      taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE", actor: "owner",
    }, "2026-09-29T00:00:00Z");
    qualifyTestFiscalPolicy(db, policyId, "owner", "2026-09-29T00:00:00Z");
  }
}

/** Explicitly synthetic approvals: fixtures never run in a seed, migration or live operator. */
export function testOwnerLegalDecision(db: Database.Database, policyId: string, actor = "owner", now = "2026-09-30T10:00:00Z") {
  const policy = db.prepare("SELECT product_kind FROM fiscal_policy_versions WHERE id=?").get(policyId) as { product_kind: string };
  const release = db.prepare("SELECT id,manifest_json FROM legal_releases WHERE active=1 AND storefront=?")
    .get(policy?.product_kind === "LAB" ? "LAB" : "COURSES") as { id: string; manifest_json: string } | undefined;
  const documents = release ? JSON.parse(release.manifest_json).documents as { kind: string; url: string; sha256: string }[] : [];
  const terms = documents.find(d => d.kind === "course_offer");
  const refund = documents.find(d => d.kind === "refund_terms");
  return recordOwnerLegalDecision(db, { policyId, legalReleaseId: release?.id ?? "missing",
    legalManifestSha256: release ? legalManifestHash(JSON.parse(release.manifest_json)) : "0".repeat(64), actor, decidedBy: actor, decidedAt: now,
    offerTermsRef: terms?.url ?? "synthetic:offer", offerTermsSha256: terms?.sha256 ?? "a".repeat(64),
    refundTermsRef: refund?.url ?? "synthetic:refund", refundTermsSha256: refund?.sha256 ?? "b".repeat(64),
    norms: [{ reference: "SYNTHETIC TEST LAW", url: "https://example.test/law" }],
    facts: "Synthetic test facts", reasoning: "Synthetic test fiscal rationale", riskAssessment: "Synthetic test risks",
    approvalRef: "synthetic:owner-approval", evidenceSha256: "c".repeat(64),
  }, now);
}
export function qualifyTestFiscalPolicy(db: Database.Database, policyId: string, actor = "owner", now = "2026-09-30T10:00:00Z") {
  const decision = testOwnerLegalDecision(db, policyId, actor, now);
  return qualifyFiscalPolicy(db, { policyId, actor, ownerLegalDecisionId: decision.ownerLegalDecisionId }, now);
}
