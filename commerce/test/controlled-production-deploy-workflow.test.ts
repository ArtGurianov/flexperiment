import { spawnSync } from "node:child_process";
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
    expect(workflow).toContain('mode: "CONTROLLED_CUTOVER"');
    expect(workflow).not.toContain('mode: "ROLLING"');
  });

  it("binds surface proofs to the exact candidate contract identifiers", () => {
    expect(workflow).toContain("release-surface-contract.json");
    expect(workflow).toContain("CHECKOUT_CONTRACT_VERSION=$checkout_contract_version");
    expect(workflow).toContain("ADMIN_CONTRACT_VERSION=$admin_contract_version");
    expect(workflow).toContain('.checkout_contract_version == $contract');
    expect(workflow).toContain('.admin_contract_version == $contract');
    expect(workflow).not.toContain('.checkout_contract_version == "age-band-v1"');
    expect(workflow).not.toContain('.admin_contract_version == "age-band-v1"');
  });

  it("evaluates the tested schema/legal boundary before it can acquire or pause registrations", () => {
    const preflight = workflow.indexOf("Preflight immutable generic-deploy boundaries");
    const acquire = workflow.indexOf("Acquire owner and pause registrations");
    expect(preflight).toBeGreaterThan(-1);
    expect(acquire).toBeGreaterThan(preflight);
    expect(workflow).toContain('git diff --name-only -z "$production_source" "$TARGET_SHA" -- commerce/migrations commerce/legal public/legal');
    expect(workflow).toContain("commerce:production-deploy:assert-boundary generic-deploy-boundary-paths.bin");
    expect(workflow).toContain('commerce/legal public/legal');
    expect(workflow).not.toContain("GENERIC_DEPLOY_REQUIRES_CONTROLLED_LEGAL_CUTOVER");
  });

  it("freezes release expectations from durable production evidence, never candidate helper code", () => {
    expect(workflow).toContain(".runtime as $runtime");
    expect(workflow).toContain('.expected.migration | select(type == "string" and test("^[0-9]{4}_.+\\\\.sql$"))');
    expect(workflow).toContain("migration: $migration");
    expect(workflow).toContain("' durable-before.json > release.json");
    expect(workflow).toContain("GENERIC_DEPLOY_PRODUCTION_BASELINE_INVALID");
    expect(workflow).not.toContain('migration_expectation="inventory-sha256:');
    expect(workflow).not.toContain('migration: "inventory-sha256:');
    expect(workflow).not.toContain("commerce:production-deploy:payload");
    expect(workflow).toContain("commerce/legal/production-manifest.json >/dev/null || { echo \"GENERIC_DEPLOY_LEGAL_CANONICAL_MANIFEST_MISMATCH\"");
  });

  it("keeps the runtime migration inventory equal to the deployed source before acquire", () => {
    const sourceInventory = workflow.indexOf('git ls-tree -r --name-only "$production_source" -- commerce/migrations');
    const inventoryMismatch = workflow.indexOf("GENERIC_DEPLOY_PRODUCTION_MIGRATION_INVENTORY_MISMATCH");
    const releaseRequest = workflow.indexOf("' durable-before.json > release.json");
    expect(sourceInventory).toBeGreaterThan(workflow.indexOf("commerce:production-deploy:assert-boundary generic-deploy-boundary-paths.bin"));
    expect(inventoryMismatch).toBeGreaterThan(sourceInventory);
    expect(inventoryMismatch).toBeLessThan(releaseRequest);
    expect(workflow).toContain('[[ "$migration_inventory" == "$source_migration_inventory" ]]');
  });

  it("accepts the top-level document hashes in the canonical candidate manifest", () => {
    const manifestPath = "commerce/legal/production-manifest.json";
    const candidate = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string; documents: Record<string, { sha256: string }> };
    const expected = {
      legal_version: candidate.version,
      legal_hashes: Object.fromEntries(Object.entries(candidate.documents).map(([name, document]) => [name, document.sha256])),
    };
    const filter = `
      . as $candidate | $expected as $expected |
      $candidate.version == $expected.legal_version and
      {
        PUBLIC_OFFER: $candidate.documents.PUBLIC_OFFER.sha256,
        PRIVACY_POLICY: $candidate.documents.PRIVACY_POLICY.sha256,
        PD_CONSENT: $candidate.documents.PD_CONSENT.sha256,
        CHECKOUT_DISCLOSURE: $candidate.documents.CHECKOUT_DISCLOSURE.sha256
      } == $expected.legal_hashes
    `;
    const result = spawnSync("jq", ["-e", "--argjson", "expected", JSON.stringify(expected), filter, manifestPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(workflow).toContain("$candidate.documents.PUBLIC_OFFER.sha256");
    expect(workflow).not.toContain("$candidate.manifest.documents.PUBLIC_OFFER.sha256");
  });

  it("validates each preflight JSON input before parsing or slurping it", () => {
    const statusFetch = workflow.indexOf('release-control/status" > durable-before.json');
    const statusValidation = workflow.indexOf("validate_json durable-before.json DURABLE_BEFORE");
    const completionFetch = workflow.indexOf('completion/$RELEASE_ID" > completion.json');
    const completionValidation = workflow.indexOf("validate_json completion.json COMPLETION");
    const releaseWrite = workflow.indexOf("' durable-before.json > release.json");
    const releaseValidation = workflow.indexOf("validate_json release.json RELEASE_REQUEST");
    const manifestValidation = workflow.indexOf("validate_json commerce/legal/production-manifest.json CANONICAL_LEGAL_MANIFEST");
    expect(workflow).toContain('${label}_INVALID_JSON');
    expect(workflow).toContain("printf '%s_PREFIX_HEX=' \"$label\"");
    expect(statusValidation).toBeGreaterThan(statusFetch);
    expect(completionValidation).toBeGreaterThan(completionFetch);
    expect(releaseValidation).toBeGreaterThan(releaseWrite);
    expect(manifestValidation).toBeGreaterThan(releaseValidation);
    expect(manifestValidation).toBeLessThan(workflow.indexOf('jq -e --slurpfile request release.json --arg source_sha'));
  });

  it("keeps reconciliation output off the pnpm lifecycle stdout channel", () => {
    const preflightReconcile = workflow.indexOf("pnpm exec tsx commerce/src/reconcile-generic-production-deploy.ts durable-before.json completion.json release.json > reconciliation.json");
    const preflightValidation = workflow.indexOf("validate_json reconciliation.json RECONCILIATION");
    const pausedReconcile = workflow.indexOf("pnpm exec tsx commerce/src/reconcile-generic-production-deploy.ts status.json completion.json release.json > reconciliation.json");
    const pausedValidation = workflow.indexOf('jq -e \'type == "object"\' reconciliation.json >/dev/null || { echo "RECONCILIATION_INVALID_JSON"');
    expect(workflow).not.toContain("pnpm commerce:production-deploy:reconcile");
    expect(preflightValidation).toBeGreaterThan(preflightReconcile);
    expect(pausedValidation).toBeGreaterThan(pausedReconcile);
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

  it("waits for a newly dispatched Coolify deployment, then uses bounded fresh polling before reopening", () => {
    const readiness = workflow.indexOf('scripts/controlled-production-readiness.sh release.json');
    const reopen = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/reopen"');
    const dispatch = workflow.indexOf("COOLIFY_DEPLOY_DISPATCHED=1");
    const settlingDelay = workflow.indexOf('sleep "$INITIAL_READINESS_DELAY_SECONDS"');
    expect(workflow).toContain('POLL_CONNECT_TIMEOUT: "3"');
    expect(workflow).toContain('POLL_MAX_TIME: "7"');
    expect(workflow).toContain('INITIAL_READINESS_DELAY_SECONDS: "60"');
    expect(workflow).toContain("timeout-minutes: 12");
    expect(workflow).not.toContain("pnpm commerce:production-deploy:assert-ready");
    expect(dispatch).toBeGreaterThan(workflow.indexOf("Deploy exact production candidate"));
    expect(settlingDelay).toBeGreaterThan(dispatch);
    expect(workflow).toContain('[[ "${COOLIFY_DEPLOY_DISPATCHED:-0}" == "1" ]]');
    expect(readiness).toBeGreaterThan(workflow.indexOf("Prove all surfaces and guarded reopen"));
    expect(readiness).toBeGreaterThan(settlingDelay);
    expect(readiness).toBeLessThan(reopen);
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
