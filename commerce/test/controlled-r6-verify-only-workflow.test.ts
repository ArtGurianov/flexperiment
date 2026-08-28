import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-r6-verify-only.yml", "utf8");

const EXPECTED_R6 = "dc28b8421ab5b02aceab77a288ddf93f28e6bd95";
const EXPECTED_OWNER = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";
const EXPECTED_PROMO_RELEASE_ID = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
const EXPECTED_PROMO_SOURCE = "97678cc19d2549146b0d4999466a4cded9320208";
const EXPECTED_STATE_HASH = "2a81cf2ec0eab1f9806d4aedb627c0df98ff125aabbd76ea8faa4b37cc997962";

describe("controlled R6 verify-only workflow", () => {
  it("is manual-only, purely read-only, with contents: read and no Coolify secrets", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("COOLIFY_TOKEN");
    expect(workflow).not.toContain("COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("controlled-coolify-deploy.sh");
  });

  it("never mutates any ref and never calls a release-control mutation endpoint", () => {
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("/v1/internal/release-control/acquire");
    expect(workflow).not.toContain("/v1/internal/release-control/pause");
    expect(workflow).not.toContain("/v1/internal/release-control/expectations");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).not.toContain("release-control/candidates/acquire");
    expect(workflow).not.toContain("release-control/candidates/complete");
  });

  it("hard-binds runtime-candidate and production-deploy to exact R6, and the owner/migration/Promo identities", () => {
    expect(workflow).toContain(`EXPECTED_RUNTIME_CANDIDATE: "${EXPECTED_R6}"`);
    expect(workflow).toContain(`EXPECTED_PRODUCTION_DEPLOY: "${EXPECTED_R6}"`);
    expect(workflow).toContain(`EXPECTED_OWNER_RELEASE_ID: "${EXPECTED_OWNER}"`);
    expect(workflow).toContain(`EXPECTED_MIGRATION: "${EXPECTED_MIGRATION}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_RELEASE_ID: "${EXPECTED_PROMO_RELEASE_ID}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_SOURCE_COMMIT: "${EXPECTED_PROMO_SOURCE}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_STATE_HASH: "${EXPECTED_STATE_HASH}"`);
  });

  it("asserts controller identity, confirmation phrase, and both refs before polling", () => {
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const controllerGuard = workflow.indexOf("Assert this controller is exact, current main");
    const confirmGuard = workflow.indexOf("Assert confirmation phrase");
    const refsGuard = workflow.indexOf("Assert runtime-candidate and production-deploy are already exact R6");
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R6 while still paused");
    expect(controllerGuard).toBeGreaterThan(checkout);
    expect(controllerGuard).toBeLessThan(confirmGuard);
    expect(confirmGuard).toBeLessThan(refsGuard);
    expect(refsGuard).toBeLessThan(poll);
    expect(workflow).toContain("VERIFY_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain("VERIFY_CONFIRM_PHRASE_MISMATCH");
  });

  it("polls with a bounded, short budget whose failure means only not-converged-yet", () => {
    expect(workflow).toContain('POLL_ATTEMPTS: "18"');
    expect(workflow).toContain('POLL_SECONDS: "10"');
    const poll = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R6 while still paused");
    const checkoutProof = workflow.indexOf("Prove public checkout is paused, not corrupt");
    const section = workflow.slice(poll, checkoutProof);
    expect(section).toContain('for attempt in $(seq 1 "$POLL_ATTEMPTS"); do');
    expect(section).toContain("VERIFY_RUNTIME_NOT_CONVERGED_YET");
    expect(section).toContain("assert-generic-production-deploy-ready.ts status.json release.json paused");
    expect(section).not.toContain("assert-generic-production-deploy-ready.ts status.json release.json open");
  });

  it("proves candidates/head is a clean 200 with the exact historical Promo head - this is exactly what R6 fixes", () => {
    const step = workflow.indexOf("Prove candidates/head is now a clean 200 with the exact historical Promo head");
    expect(step).toBeGreaterThan(-1);
    const section = workflow.slice(step);
    expect(section).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(section).toContain(".head.release_id == $release_id and");
    expect(section).toContain('.head.phase == "COMPLETE" and');
    expect(section).toContain(".state_hash == $hash");
  });

  it("takes one final fresh authority snapshot as the last executable step, after every incident proof, and never reopens", () => {
    const providerStep = workflow.indexOf("Prove provider readiness is read-only healthy");
    const finalStep = workflow.indexOf("Final authority snapshot remains exact R6 and paused");
    expect(finalStep).toBeGreaterThan(providerStep);
    const afterFinalStep = workflow.slice(finalStep + "Final authority snapshot remains exact R6 and paused".length);
    expect(afterFinalStep).not.toMatch(/\n {6}- name:/);
    const section = workflow.slice(finalStep);
    expect(section).toContain('final_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(section).toContain("FINAL_RUNTIME_CANDIDATE_UNEXPECTED_SHA");
    expect(section).toContain('final_production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(section).toContain("FINAL_PRODUCTION_DEPLOY_UNEXPECTED_SHA");
    expect(section).toContain("FINAL_GENERIC_GATE_UNEXPECTED_STATE");
    expect(section).toContain("FINAL_PROMO_HEAD_CHANGED");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).toContain("No reopen step exists in this workflow");
  });

  it("uses the shared production concurrency group, same as every other controller", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("runs every policy script from the controller's own checkout, never a second worktree", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s*actions\/checkout@/g)];
    expect(checkoutSteps).toHaveLength(1);
    expect(workflow).toContain("ref: ${{ github.sha }}");
  });
});
