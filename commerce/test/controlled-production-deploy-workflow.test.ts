import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");
const deployHelper = readFileSync("scripts/controlled-coolify-deploy.sh", "utf8");

describe("generic controlled production deploy workflow", () => {
  it("runs for every push to main under the shared protected production lock", () => {
    expect(workflow).toContain("push:\n    branches:\n      - main");
    expect(workflow).not.toContain("paths:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("RELEASE_ID: deploy-${{ github.sha }}");
    expect(workflow).toContain("TARGET_SHA: ${{ github.sha }}");
  });

  it("rejects every migration and legal-tree change before it can acquire or pause registrations", () => {
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(preflight);
    expect(workflow).toContain('git diff --quiet "$production_source" "$TARGET_SHA" -- commerce/migrations');
    expect(workflow).toContain("GENERIC_DEPLOY_REQUIRES_CONTROLLED_SCHEMA_CUTOVER");
    expect(workflow).toContain('git diff --quiet "$production_source" "$TARGET_SHA" -- commerce/legal public/legal');
    expect(workflow).toContain("GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER");
    expect(workflow).toContain('commerce/legal public/legal');
  });

  it("freezes release expectations from durable production evidence, never candidate helper code", () => {
    expect(workflow).toContain(".runtime as $runtime");
    expect(workflow).toContain("' durable-before.json > release.json");
    expect(workflow).toContain("GENERIC_DEPLOY_PRODUCTION_BASELINE_INVALID");
    expect(workflow).not.toContain("commerce:production-deploy:payload");
    expect(workflow).toContain("commerce/legal/production-manifest.json >/dev/null || { echo \"GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER\"");
  });

  it("uses a candidate-bound durable owner without legal promotion or CI writes", () => {
    expect(workflow).toContain('"$owner" == "$RELEASE_ID"');
    expect(workflow).toContain("GENERIC_DEPLOY_BLOCKED_BY_RELEASE_OWNER");
    expect(workflow).toContain("GENERIC_DEPLOY_OWNER_EXPECTATIONS_MISMATCH");
    expect(workflow).toContain('scripts/controlled-coolify-deploy.sh "$TARGET_SHA"');
    expect(workflow).toContain("completion/$RELEASE_ID");
    expect(workflow).toContain('"$PUBLIC_FRONTEND_URL/release.json"');
    expect(workflow).toContain('"$ADMIN_RELEASE_URL"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/public/legal-config"');
    expect(workflow).not.toContain("PUBLISH_LEGAL");
    expect(workflow).not.toContain("CREATE_PROMOTION");
    expect(workflow).not.toContain("legal-publish");
    expect(workflow).not.toContain("git push");
    expect(deployHelper).toContain("only an enqueue acknowledgement");
  });
});
