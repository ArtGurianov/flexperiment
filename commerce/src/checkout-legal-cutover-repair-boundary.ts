const allowedRepairPaths = new Set([
  ".github/workflows/controlled-checkout-legal-cutover.yml",
  "Dockerfile.admin",
  "commerce/src/assert-candidate-runtime-ready.ts",
  "commerce/src/assert-checkout-legal-cutover-repair-boundary.ts",
  "commerce/src/candidate-runtime-readiness.ts",
  "commerce/src/checkout-legal-cutover-recovery.ts",
  "commerce/src/checkout-legal-cutover-repair-boundary.ts",
  "commerce/src/decide-checkout-legal-cutover-recovery.ts",
  "commerce/src/reconcile-cutover.ts",
  "scripts/controlled-production-readiness.sh",
  "scripts/set-production-deploy-ref.sh",
  "commerce/test/candidate-runtime-readiness.test.ts",
  "commerce/test/checkout-legal-cutover-recovery.test.ts",
  "commerce/test/checkout-legal-cutover-repair-boundary.test.ts",
  "commerce/test/controlled-checkout-legal-cutover-workflow.test.ts",
  "commerce/test/controlled-deploy-ref-scripts.test.ts",
  "commerce/test/controlled-production-readiness-script.test.ts",
  "commerce/test/static-release-descriptor.test.ts",
]);

/**
 * A pre-publication repair can only carry the controller hardening needed to
 * recover an already-paused release. Product, legal, contract, and migration
 * changes require a new controlled cutover and are never repairable in place.
 */
export const checkoutLegalCutoverRepairBoundaryError = (changedPaths: readonly string[]): string | undefined => {
  const unexpected = changedPaths.find((path) => !allowedRepairPaths.has(path));
  return unexpected ? `CHECKOUT_LEGAL_CUTOVER_REPAIR_SCOPE_INVALID:${unexpected}` : undefined;
};
