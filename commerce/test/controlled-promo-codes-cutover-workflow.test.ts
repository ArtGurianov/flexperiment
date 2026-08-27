import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-promo-codes-cutover.yml", "utf8");

describe("controlled promo codes v0 cutover workflow", () => {
  it("is manual, serialized with production, and keeps controller and source identities distinct", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("stage:");
    expect(workflow).toContain("options: [prepare, complete]");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("CONTROLLER_SHA: ${{ github.sha }}");
    expect(workflow).toContain("INPUT_TARGET_SHA: ${{ inputs.target_sha }}");
    expect(workflow).toContain("git merge-base --is-ancestor \"$target_sha\" \"$CONTROLLER_SHA\"");
    expect(workflow).toContain("RELEASE_ID=promo-codes-v0:$target_sha");
    expect(workflow).toContain("AUTHORITY_HEAD_MIN_SHA=91c78c9545820698cb2433f426b75bd5e1ca262c");
    expect(workflow).toContain("PROMO_CUTOVER_AUTHORITY_HEAD_RUNTIME_REQUIRED");
  });

  it("rejects partial certification authority inputs and binds the source to the promo v0 surface and bytes", () => {
    for (const input of ["certification_occurrence_id", "certification_promo_id", "certification_idempotency_key_hash", "certification_lease_seconds"]) expect(workflow).toContain(input);
    expect(workflow).toContain("PROMO_CUTOVER_CERTIFICATION_INPUTS_PARTIAL");
    expect(workflow).toContain("PROMO_CUTOVER_CERTIFICATION_HASH_INVALID");
    expect(workflow).toContain("PROMO_CUTOVER_CERTIFICATION_LEASE_INVALID");
    expect(workflow).toContain('checkout_contract_version == "promo-codes-v0"');
    expect(workflow).toContain('admin_contract_version == "promo-codes-v0"');
    expect(workflow).toContain('has("0035_promo_codes_v0.sql")');
    expect(workflow).toContain("PROMO_MIGRATION_INVENTORY");
    expect(workflow).toContain("PROMO_CUTOVER_PRODUCTION_MIGRATION_SOURCE_MISMATCH");
    expect(workflow).toContain("PROMO_CUTOVER_APPLIED_MIGRATION_PREFIX_INVALID");
    expect(workflow).toContain("$candidate_names[0:($applied | length)] == $applied");
    expect(workflow).toContain('git diff --no-ext-diff --name-status "$production_source" "$EFFECTIVE_TARGET_SHA" -- commerce/migrations');
    expect(workflow).toContain('awk \'NF > 0 && $1 != "A" { exit 1 }\'');
  });

  it("uses legacy acquire/status only before the feature is deployed, then reads server-issued heads and CAS hashes", () => {
    const acquire = workflow.indexOf("Acquire generation one or read its authoritative state");
    const deploy = workflow.indexOf("Deploy the exact paused generation");
    const reconcile = workflow.indexOf("Reconcile deployed candidate and enter read-only phase");
    const authorityHeadGate = workflow.indexOf("PROMO_CUTOVER_AUTHORITY_HEAD_RUNTIME_REQUIRED");
    const prefixGate = workflow.indexOf("PROMO_CUTOVER_APPLIED_MIGRATION_PREFIX_INVALID");
    expect(acquire).toBeGreaterThan(-1);
    expect(authorityHeadGate).toBeGreaterThan(-1);
    expect(prefixGate).toBeGreaterThan(-1);
    expect(authorityHeadGate).toBeLessThan(acquire);
    expect(prefixGate).toBeLessThan(acquire);
    expect(deploy).toBeGreaterThan(acquire);
    expect(reconcile).toBeGreaterThan(deploy);
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/acquire"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(workflow).toContain("PROMO_CUTOVER_HEAD_READ_UNAVAILABLE");
    expect(workflow).toContain("expected_state_hash: $current[0].state_hash");
    expect(workflow).not.toContain("releaseStateHash(");
    expect(workflow).toContain("worker_last_successful_sweep_at");
    expect(workflow).toContain("$runtime.legal_hashes == $head.legal_baseline.legal_hashes");
    expect(workflow).toContain('"$PUBLIC_FRONTEND_URL/release.json"');
    expect(workflow).toContain('"$ADMIN_RELEASE_URL"');
    expect(workflow).toContain('"$PUBLIC_API_URL/healthz"');
    expect(workflow).toContain('"$PUBLIC_API_URL/readyz"');
    expect(workflow.indexOf('"$PUBLIC_API_URL/healthz"')).toBeLessThan(workflow.indexOf('to_phase: "DEPLOYED_READ_ONLY"'));
  });

  it("enforces the paused deploy, two-pass certification, retry, recovery, and certified-only completion sequence", () => {
    const pause = workflow.indexOf("Prove public checkout is paused before candidate deployment");
    const deploy = workflow.indexOf("Deploy the exact paused generation");
    const phase = workflow.indexOf("Reconcile deployed candidate and enter read-only phase");
    const certification = workflow.indexOf("Activate or reconcile the certification lease");
    const complete = workflow.indexOf("Complete only a certified authoritative candidate");
    expect(pause).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(pause);
    expect(phase).toBeGreaterThan(deploy);
    expect(certification).toBeGreaterThan(phase);
    expect(complete).toBeGreaterThan(certification);
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(workflow).toContain('to_phase: "DEPLOYED_READ_ONLY"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/certification/activate"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/certification/retry"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/adopt"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/complete"');
    expect(workflow).toContain("PROMO_CUTOVER_CERTIFICATION_ALREADY_STARTED");
    expect(workflow).toContain("scripts/set-production-deploy-ref.sh");
    expect(workflow).toContain("scripts/controlled-coolify-deploy.sh");
    expect(workflow).not.toContain("git push");
  });
});
