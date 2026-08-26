import { describe, expect, it } from "vitest";
import { genericProductionDeployBoundaryError } from "../src/generic-production-deploy-boundary";

describe("generic production deploy boundary", () => {
  it("rejects adding or modifying any migration", () => {
    expect(genericProductionDeployBoundaryError(["commerce/migrations/0035_future_schema.sql"])).toBe("GENERIC_DEPLOY_REQUIRES_CONTROLLED_SCHEMA_CUTOVER");
    expect(genericProductionDeployBoundaryError(["commerce/migrations/0034_worker_sweep_evidence.sql"])).toBe("GENERIC_DEPLOY_REQUIRES_CONTROLLED_SCHEMA_CUTOVER");
  });

  it("rejects the canonical manifest and every current legal copy", () => {
    expect(genericProductionDeployBoundaryError(["commerce/legal/production-manifest.json"])).toBe("GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER");
    expect(genericProductionDeployBoundaryError(["public/legal/public-offer.md"])).toBe("GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER");
  });

  it("allows an unchanged schema/legal boundary", () => {
    expect(genericProductionDeployBoundaryError([])).toBeUndefined();
    expect(genericProductionDeployBoundaryError(["commerce/src/domain.ts", "apps/admin/app/page.tsx"])).toBeUndefined();
  });
});
