import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-r7-same-owner-reopen.yml", "utf8");

const EXPECTED_R7 = "5ec1eadab4373fb1309dd1d323d88bf12f564220";
const EXPECTED_OWNER = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";
const EXPECTED_PROMO_RELEASE_ID = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
const EXPECTED_PROMO_SOURCE = "97678cc19d2549146b0d4999466a4cded9320208";
const EXPECTED_STATE_HASH = "2a81cf2ec0eab1f9806d4aedb627c0df98ff125aabbd76ea8faa4b37cc997962";

describe("controlled R7 same-owner reopen workflow", () => {
  it("is manual-only with an exact confirmation phrase, no target input", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("target_sha:");
    expect(workflow).toContain("confirm:");
    expect(workflow).toContain('REQUIRED_CONFIRM_PHRASE: "REOPEN-R7-DEPLOY-R4-EXACTLY-ONCE"');
    expect(workflow).toContain('[[ "$INPUT_CONFIRM" == "$REQUIRED_CONFIRM_PHRASE" ]]');
  });

  it("hard-binds exact R7 and the exact durable owner identity, never derived from a deployment target SHA", () => {
    expect(workflow).toContain(`EXPECTED_RUNTIME_CANDIDATE: "${EXPECTED_R7}"`);
    expect(workflow).toContain(`EXPECTED_PRODUCTION_DEPLOY: "${EXPECTED_R7}"`);
    expect(workflow).toContain(`EXPECTED_OWNER_RELEASE_ID: "${EXPECTED_OWNER}"`);
    expect(workflow).toContain(`EXPECTED_MIGRATION: "${EXPECTED_MIGRATION}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_RELEASE_ID: "${EXPECTED_PROMO_RELEASE_ID}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_SOURCE_COMMIT: "${EXPECTED_PROMO_SOURCE}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_STATE_HASH: "${EXPECTED_STATE_HASH}"`);
    // The exact defect controlled-production-deploy.yml has for this
    // lineage: RELEASE_ID must never be synthesized from the target SHA.
    expect(workflow).not.toContain("deploy-$TARGET_SHA");
    expect(workflow).not.toContain("deploy-$EXPECTED_PRODUCTION_DEPLOY");
    expect(workflow).not.toContain("deploy-$EXPECTED_RUNTIME_CANDIDATE");
    expect(workflow).not.toMatch(/release_id:\s*"deploy-\$/);
    expect(workflow).not.toMatch(/RELEASE_ID=deploy-\$/);
  });

  it("is contents: read with no Git write permission, and needs only the release-control token - no Coolify secrets", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("COMMERCE_RELEASE_CONTROL_TOKEN: ${{ secrets.COMMERCE_RELEASE_CONTROL_TOKEN }}");
    expect(workflow).not.toContain("COOLIFY_TOKEN");
    expect(workflow).not.toContain("COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL");
    expect(workflow).not.toContain("controlled-coolify-deploy.sh");
  });

  it("never mutates any ref and never calls acquire/pause/expectations - only reopen", () => {
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("git push");
    expect(workflow).not.toContain("/v1/internal/release-control/acquire");
    expect(workflow).not.toContain("/v1/internal/release-control/pause");
    expect(workflow).not.toContain("/v1/internal/release-control/expectations");
    expect(workflow).not.toContain("release-control/candidates/acquire");
    expect(workflow).not.toContain("release-control/candidates/complete");
  });

  it("calls /v1/internal/release-control/reopen exactly once in the entire workflow", () => {
    const reopenCalls = [...workflow.matchAll(/\/v1\/internal\/release-control\/reopen/g)];
    expect(reopenCalls).toHaveLength(1);
    expect(workflow).toContain('--data-binary @reopen-request.json "$PUBLIC_API_URL/v1/internal/release-control/reopen"');
  });

  it("materializes an exact-R7 detached worktree once, with HEAD assertion and --ignore-scripts", () => {
    const step = workflow.indexOf("Materialize exact R7 once for runtime-pinned readiness parsing");
    const nextStep = workflow.indexOf("Prove full R7 readiness before reopen");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('git worktree add --detach "$RUNTIME_ASSERT_DIR" "$EXPECTED_PRODUCTION_DEPLOY"');
    expect(section).toContain('[[ "$(git -C "$RUNTIME_ASSERT_DIR" rev-parse HEAD)" == "$EXPECTED_PRODUCTION_DEPLOY" ]]');
    expect(section).toContain("RUNTIME_ASSERT_WORKTREE_WRONG_SHA");
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && pnpm install --frozen-lockfile --ignore-scripts)');
    expect(workflow).not.toContain('pnpm install --frozen-lockfile)');
    expect(section).toContain('RUNTIME_ASSERT_DIR="$RUNNER_TEMP/r7-readiness-runtime"');
    expect(section).toContain('echo "RUNTIME_ASSERT_DIR=$RUNTIME_ASSERT_DIR" >> "$GITHUB_ENV"');
    expect(workflow).not.toMatch(/RUNTIME_ASSERT_DIR:\s*\$\{\{\s*runner\./);
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(1);
  });

  it("builds reopen-request.json field-by-field with legal_hashes explicitly pulled from runtime.legal_hashes, never copying .expected verbatim", () => {
    const step = workflow.indexOf("Prove full R7 readiness before reopen");
    const nextStep = workflow.indexOf("Freshly reprove every precondition immediately before reopen");
    const section = workflow.slice(step, nextStep);
    expect(section).toContain("legal_hashes: $s.runtime.legal_hashes");
    expect(section).not.toContain("expected: .expected");
    expect(section).not.toMatch(/\{\s*release_id:\s*\.owner_release_id/);
    expect(section).toContain('release_id: $release_id');
    expect(section).toContain('--arg release_id "$EXPECTED_OWNER_RELEASE_ID"');
    expect(section).toContain('mode: "CONTROLLED_CUTOVER"');
  });

  it("proves candidateHead/Promo state and checkout-paused before reopen, using the exact-R7 pinned parser", () => {
    const step = workflow.indexOf("Prove full R7 readiness before reopen");
    const nextStep = workflow.indexOf("Freshly reprove every precondition immediately before reopen");
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$GITHUB_WORKSPACE/status.json" "$GITHUB_WORKSPACE/reopen-request.json" paused)');
    expect(section).toContain("SALES_TEMPORARILY_PAUSED");
    expect(section).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(section).toContain(".head.release_id == $release_id and");
    expect(section).toContain('.head.phase == "COMPLETE" and');
    expect(section).toContain(".state_hash == $hash");
    expect(section).toContain('.environment == "production"');
    expect(section).not.toContain("derive-r5-migration-compat-evidence");
  });

  it("re-reads refs, status, checkout, candidateHead, and provider readiness fresh, then reopens as the literal last command - no retry loop", () => {
    const step = workflow.indexOf("Freshly reprove every precondition immediately before reopen, then reopen exactly once");
    const nextStep = workflow.indexOf("- name: Prove canonical post-reopen status");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('[[ "$(git rev-parse origin/runtime-candidate)" == "$EXPECTED_RUNTIME_CANDIDATE" ]]');
    expect(section).toContain("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT");
    expect(section).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$EXPECTED_PRODUCTION_DEPLOY" ]]');
    expect(section).toContain("PRODUCTION_DEPLOY_MOVED_SINCE_PREFLIGHT");
    expect(section).toContain("--slurpfile baseline status.json");
    expect(section).toContain("$baseline[0] as $before |");
    expect(section).toContain("SALES_TEMPORARILY_PAUSED");
    expect(section).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(section).toContain('.environment == "production"');
    // No polling/retry construct anywhere around the mutation.
    expect(section).not.toContain("for attempt in");
    expect(section).not.toContain("sleep ");
    // The mutation is the literal last command in the step.
    const lastLine = section.trim().split("\n").at(-1)?.trim();
    expect(lastLine).toBe('api -X POST -H \'Content-Type: application/json\' --data-binary @reopen-request.json "$PUBLIC_API_URL/v1/internal/release-control/reopen" > reopened.json');
  });

  it("requires the canonical post-reopen status: owner null, mode null, paused false - no invented assertions", () => {
    const step = workflow.indexOf("Prove canonical post-reopen status");
    const nextStep = workflow.indexOf("Prove all surfaces and the Promo head remain exact R7 after reopen");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain(".sales_paused == false and .owner_release_id == null and .owner_mode == null");
    expect(section.match(/\.sales_paused == false and \.owner_release_id == null and \.owner_mode == null/g)).toHaveLength(2);
  });

  it("repeats the exact Promo head/state_hash proof after reopen, unchanged", () => {
    const step = workflow.indexOf("Prove all surfaces and the Promo head remain exact R7 after reopen");
    const nextStep = workflow.indexOf("Post-reopen checkout smoke");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head" > candidate-head-post.json');
    expect(section).toContain(".head.release_id == $release_id and");
    expect(section).toContain(".state_hash == $hash");
    expect(section).toContain("FINAL_PROMO_HEAD_CHANGED");
  });

  it("post-reopen checkout smoke rejects paused/corrupt/server-error outcomes but allows ordinary validation errors", () => {
    const step = workflow.indexOf("Post-reopen checkout smoke");
    expect(step).toBeGreaterThan(-1);
    const section = workflow.slice(step);
    expect(section).toContain('[[ "$smoke_status" -lt 500 ]]');
    expect(section).toContain("REOPEN_SMOKE_UNEXPECTED_SERVER_ERROR");
    expect(section).toContain('[[ "$error_code" != "SALES_TEMPORARILY_PAUSED" ]]');
    expect(section).toContain("REOPEN_SMOKE_STILL_PAUSED");
    expect(section).toContain('[[ "$error_code" != "RELEASE_STATE_CORRUPT" ]]');
    expect(section).toContain("REOPEN_SMOKE_STATE_CORRUPT");
  });

  it("uses the shared production concurrency group, same as every other controller", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });

  it("never invokes the readiness parser as a bare command against main's own checkout", () => {
    const bareInvocations = [...workflow.matchAll(/^\s*node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/gm)];
    expect(bareInvocations).toHaveLength(0);
    const pinnedInvocations = [...workflow.matchAll(/\(cd "\$RUNTIME_ASSERT_DIR" && node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/g)];
    expect(pinnedInvocations).toHaveLength(1);
  });
});
