import type Database from "better-sqlite3";
import { activateSales, salesActivationEvidenceIssue, type ProductCommand } from "../../src/catalog-control";
import { loadCommerceRuntimeConfig } from "../../src/payment-mode";

/** Local/test runtime: the scripted mock rail, with the same live sale-mode gate production uses. */
export const testCheckoutConfig = loadCommerceRuntimeConfig({ NODE_ENV: "test" });

/** A PUBLIC offer sells only with a current audited activation row for its kind. */
export function activatePublicSales(db: Database.Database, kind: ProductCommand["kind"] = "ONLINE_COURSE") {
  return activateSales(db, {
    kind, evidenceIssue: salesActivationEvidenceIssue[kind], evidenceSha256: "a".repeat(64), actor: "owner",
  }, "2026-09-29T00:00:00Z");
}
