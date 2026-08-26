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
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("RELEASE_ID: deploy-${{ github.sha }}");
    expect(workflow).toContain("TARGET_SHA: ${{ github.sha }}");
  });

  it("evaluates the tested schema/legal boundary before it can acquire or pause registrations", () => {
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(preflight);
    expect(workflow).toContain('git diff --name-only -z "$production_source" "$TARGET_SHA" -- commerce/migrations commerce/legal public/legal');
    expect(workflow).toContain("commerce:production-deploy:assert-boundary generic-deploy-boundary-paths.bin");
    expect(workflow).toContain('commerce/legal public/legal');
  });

  it("freezes release expectations from durable production evidence, never candidate helper code", () => {
    expect(workflow).toContain(".runtime as $runtime");
    expect(workflow).toContain("' durable-before.json > release.json");
    expect(workflow).toContain("GENERIC_DEPLOY_PRODUCTION_BASELINE_INVALID");
    expect(workflow).toContain('migration_expectation="inventory-sha256:');
    expect(workflow).not.toContain('migration: "0034_worker_sweep_evidence.sql"');
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
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA"');
    expect(deployHelper).toContain("only an enqueue acknowledgement");
  });

  it("proves the public pause before deploy and rechecks every surface after reopening", () => {
    const pause = workflow.indexOf("Prove public checkout pause before deployment");
    const deploy = workflow.indexOf("Deploy exact production candidate");
    const reopen = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/reopen"');
    const finalProof = workflow.indexOf("Verify post-reopen completion and all production surfaces");
    expect(pause).toBeGreaterThan(workflow.indexOf("Acquire owner and pause registrations"));
    expect(pause).toBeLessThan(deploy);
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/public/checkouts"');
    expect(workflow).toContain('"$pause_status" == "503"');
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(finalProof).toBeGreaterThan(reopen);
    const finalProofSource = workflow.slice(finalProof);
    expect(finalProofSource).toContain('"$PUBLIC_FRONTEND_URL/release.json"');
    expect(finalProofSource).toContain('"$ADMIN_RELEASE_URL"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/v1/public/legal-config"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/healthz"');
    expect(finalProofSource).toContain('"$PUBLIC_API_URL/readyz"');
  });

  it("allows only the durable owner to recover after main advances", () => {
    const status = workflow.indexOf('release-control/status" > durable-before.json');
    const owner = workflow.indexOf("owner=\"$(jq -r '.owner_release_id // empty' durable-before.json)\"");
    const freshMain = workflow.indexOf("GENERIC_DEPLOY_TARGET_IS_NOT_MAIN_HEAD");
    const ref = workflow.indexOf("Set guarded production deployment ref");
    const deploy = workflow.indexOf("Deploy exact production candidate");
    expect(status).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(status);
    expect(freshMain).toBeGreaterThan(owner);
    expect(ref).toBeGreaterThan(workflow.indexOf("Reconcile paused deployment"));
    expect(ref).toBeLessThan(deploy);
    expect(workflow).toContain('[[ -z "$owner" || "$owner" == "$RELEASE_ID" ]]');
    expect(workflow).toContain('if ! jq -e \'.complete\' completion.json >/dev/null && [[ -z "$owner" ]]; then');
  });
});
