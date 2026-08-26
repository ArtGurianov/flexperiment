import { describe, expect, it } from "vitest";
import { checkoutLegalCutoverRepairBoundaryError } from "../src/checkout-legal-cutover-repair-boundary";

describe("checkout/legal pre-publication repair boundary", () => {
  it("allows only the controller hardening and the admin Docker build repair", () => {
    expect(checkoutLegalCutoverRepairBoundaryError([
      ".github/workflows/controlled-checkout-legal-cutover.yml",
      "Dockerfile.admin",
      "commerce/src/checkout-legal-cutover-recovery.ts",
      "scripts/set-production-deploy-ref.sh",
      "commerce/test/checkout-legal-cutover-recovery.test.ts",
    ])).toBeUndefined();
  });

  it.each([
    "commerce/legal/production-manifest.2026-08-26.1.draft.json",
    "public/legal/public-offer.md",
    "release-surface-contract.json",
    "commerce/src/domain.ts",
    "app/page.tsx",
    "apps/admin/app/page.tsx",
    "commerce/migrations/0035_unexpected.sql",
  ])("rejects product or release boundary changes: %s", (path) => {
    expect(checkoutLegalCutoverRepairBoundaryError(["Dockerfile.admin", path])).toBe(`CHECKOUT_LEGAL_CUTOVER_REPAIR_SCOPE_INVALID:${path}`);
  });
});
