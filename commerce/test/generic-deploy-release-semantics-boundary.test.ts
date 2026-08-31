import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { genericProductionDeployBoundary, genericProductionDeployBoundaryError, releaseSemanticsCategories, releaseSemanticsPaths } from "../src/generic-production-deploy-boundary";

/**
 * The boundary must answer "can this diff change how durable release state is
 * interpreted or enforced?", not merely "did migration files change?".
 *
 * R7 is the reason. migrationApplied() was a defect in release-control.ts with
 * no migration file involved, and it silently changed which releases could
 * reopen. Under the old boundary that candidate was an ordinary deploy.
 */
describe("generic deploy release-semantics boundary", () => {
  it("names only files that exist", () => {
    for (const path of releaseSemanticsPaths) {
      expect(existsSync(path), `${path} is listed as release-sensitive but does not exist`).toBe(true);
    }
  });

  /** The R7 regression, as a fixture. */
  it("refuses a candidate that changes the migration-applied predicate", () => {
    expect(genericProductionDeployBoundary(["commerce/src/release-control.ts"])).toBe("RELEASE_SEMANTICS");
    expect(genericProductionDeployBoundaryError(["commerce/src/release-control.ts"])).toBe("GENERIC_DEPLOY_RELEASE_SEMANTICS_BOUNDARY_CHANGED");
  });

  it.each([
    ["the expectation DTO", "commerce/src/types.ts"],
    ["gate enforcement", "commerce/src/sales-gate.ts"],
    ["canonical serialization behind every state and inventory hash", "commerce/src/crypto.ts"],
    ["state-machine replay", "commerce/src/release-generation.ts"],
    ["certification evidence arithmetic", "commerce/src/certification-evidence.ts"],
    ["lease and freshness timestamp parsing", "commerce/src/utc-timestamp.ts"],
  ])("refuses a candidate that changes %s", (_label, path) => {
    expect(genericProductionDeployBoundary([path])).toBe("RELEASE_SEMANTICS");
  });

  it("classifies notification legal activation and its evidence reader as compatibility semantics", () => {
    for (const path of ["commerce/src/occurrence-notification-capability.ts", "commerce/src/legal-release.ts"]) {
      expect(genericProductionDeployBoundary([path])).toBe("RELEASE_SEMANTICS");
      expect(releaseSemanticsCategories([path])).toEqual(["COMPATIBILITY"]);
    }
  });

  it("admits a change to the boundary classifier itself", () => {
    // This asserted the opposite until the authority error behind it was found.
    // The classifier is control plane: it takes effect when it merges to
    // protected main, because controllers run policy from their own checkout,
    // and production never observes it. Denying it here demanded a runtime
    // cutover purely so production-deploy would catch up and stop showing the
    // file in later diffs - servicing an abstraction leak, not safety.
    //
    // The exemption is safe only because the runtime cannot reach it, which is
    // machine-checked in control-plane-isolation.test.ts.
    expect(genericProductionDeployBoundary(["commerce/src/generic-production-deploy-boundary.ts"])).toBeUndefined();
  });

  /**
   * The other half, and the reason enforcement was extracted out of domain.ts:
   * ordinary product work must stay eligible, or the controlled cutover - real
   * money, real pause - becomes the only way to ship anything.
   */
  it.each([
    ["an admin UI change", ["apps/admin/components/orders/Orders.tsx", "apps/admin/app/globals.css"]],
    ["a public UI change", ["components/CheckoutFlow.tsx", "lib/occurrence-sales.ts"]],
    ["an email provider change", ["commerce/src/email-provider.ts", "commerce/src/email-templates.ts"]],
    ["ordinary business logic", ["commerce/src/domain.ts", "commerce/src/api.ts"]],
    ["worker and tests", ["commerce/src/worker-sweep.ts", "commerce/test/domain.test.ts"]],
  ])("keeps %s eligible for the generic path", (_label, paths) => {
    expect(genericProductionDeployBoundary(paths)).toBeUndefined();
    expect(genericProductionDeployBoundaryError(paths)).toBeUndefined();
  });

  it("still refuses the original three boundaries, and reports the most specific cause", () => {
    expect(genericProductionDeployBoundary(["commerce/migrations/0039_x.sql"])).toBe("SCHEMA");
    expect(genericProductionDeployBoundary(["public/legal/privacy-policy.md"])).toBe("LEGAL");
    expect(genericProductionDeployBoundary(["release-surface-contract.json"])).toBe("SURFACE_CONTRACT");
    // Schema outranks release semantics when a diff trips both.
    expect(genericProductionDeployBoundary(["commerce/src/release-control.ts", "commerce/migrations/0039_x.sql"])).toBe("SCHEMA");
  });

  /**
   * This one is deliberately coarse-grained. domain.ts is eligible, so a change
   * there could in principle alter enforcement - which is exactly why the
   * composition was moved to sales-gate.ts. If enforcement moves back, the
   * boundary silently stops covering it.
   */
  it("keeps enforcement out of the file the boundary lets through", () => {
    expect(releaseSemanticsPaths).toContain("commerce/src/sales-gate.ts");
    expect(releaseSemanticsPaths).not.toContain("commerce/src/domain.ts");
    expect(genericProductionDeployBoundary(["commerce/src/domain.ts"])).toBeUndefined();
  });
});
