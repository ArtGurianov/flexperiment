import { describe, expect, it } from "vitest";
import { checkoutLegalCutoverRepairBoundaryError } from "../src/checkout-legal-cutover-repair-boundary";

const approvedRepairPaths = [
  ".github/workflows/controlled-checkout-legal-cutover.yml",
  "Dockerfile.admin",
  "commerce/src/assert-candidate-runtime-ready.ts",
  "commerce/src/assert-checkout-legal-cutover-repair-boundary.ts",
  "commerce/src/candidate-runtime-readiness.ts",
  "commerce/src/checkout-legal-cutover-recovery.ts",
  "commerce/src/checkout-legal-cutover-repair-boundary.ts",
  "commerce/src/decide-checkout-legal-cutover-recovery.ts",
  "commerce/src/reconcile-cutover.ts",
  "commerce/test/candidate-runtime-readiness.test.ts",
  "commerce/test/checkout-legal-cutover-recovery.test.ts",
  "commerce/test/checkout-legal-cutover-repair-boundary.test.ts",
  "commerce/test/controlled-checkout-legal-cutover-workflow.test.ts",
  "commerce/test/controlled-deploy-ref-scripts.test.ts",
  "commerce/test/controlled-production-readiness-script.test.ts",
  "commerce/test/static-release-descriptor.test.ts",
  "scripts/controlled-production-readiness.sh",
  "scripts/set-production-deploy-ref.sh",
] as const;

describe("checkout/legal pre-publication repair boundary", () => {
  it("allows the exact approved controller/recovery repair set, including the boundary bootstrap files", () => {
    expect(checkoutLegalCutoverRepairBoundaryError(approvedRepairPaths)).toBeUndefined();
  });

  it.each([
    "components/CheckoutFlow.tsx",
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
