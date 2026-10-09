import type Database from "better-sqlite3";
import { activateSales, salesActivationEvidenceIssue, type ProductCommand } from "../../src/catalog-control";
import { draftFiscalPolicy, qualifyFiscalPolicy } from "../../src/fiscal-policy";
import { loadCommerceRuntimeConfig } from "../../src/payment-mode";

/** Local/test runtime: the scripted mock rail, with the same live sale-mode gate production uses. */
export const testCheckoutConfig = loadCommerceRuntimeConfig({ NODE_ENV: "test" });

/** A PUBLIC offer sells only with a current audited activation row for its kind. */
export function activatePublicSales(db: Database.Database, kind: ProductCommand["kind"] = "ONLINE_COURSE") {
  return activateSales(db, {
    // A kind no acceptance qualifies (COURSE_BUNDLE) is refused by activateSales itself.
    kind, evidenceIssue: salesActivationEvidenceIssue[kind] ?? "", evidenceSha256: "a".repeat(64), actor: "owner",
  }, "2026-09-29T00:00:00Z");
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
    qualifyFiscalPolicy(db, { policyId, actor: "owner", legalBasis: { offerTermsRef: "test-offer-terms", counselRef: "test-counsel", evidenceSha256: "c".repeat(64) } },
      "2026-09-29T00:00:00Z");
  }
}
