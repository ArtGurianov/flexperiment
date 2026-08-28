import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-r6-same-owner-submit.yml", "utf8");

const EXPECTED_R6 = "dc28b8421ab5b02aceab77a288ddf93f28e6bd95";
const EXPECTED_R5 = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
const EXPECTED_OWNER = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";

describe("controlled R6 same-owner submit workflow", () => {
  it("is manual-only with an exact confirmation phrase, no target input", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("target_sha:");
    expect(workflow).toContain("confirm:");
    expect(workflow).toContain('REQUIRED_CONFIRM_PHRASE: "SUBMIT-R6-SAME-OWNER-CROSSING-WHILE-PAUSED"');
    expect(workflow).toContain('[[ "$INPUT_CONFIRM" == "$REQUIRED_CONFIRM_PHRASE" ]]');
  });

  it("hard-binds every identity, never dynamically resolved", () => {
    expect(workflow).toContain(`EXPECTED_RUNTIME_CANDIDATE: "${EXPECTED_R6}"`);
    expect(workflow).toContain(`EXPECTED_PRODUCTION_DEPLOY_BEFORE: "${EXPECTED_R5}"`);
    expect(workflow).toContain(`DEPLOYMENT_TARGET: "${EXPECTED_R6}"`);
    expect(workflow).toContain(`TOPOLOGY_BASELINE: "${EXPECTED_R5}"`);
    expect(workflow).toContain(`EXPECTED_OWNER_RELEASE_ID: "${EXPECTED_OWNER}"`);
    expect(workflow).toContain(`EXPECTED_MIGRATION: "${EXPECTED_MIGRATION}"`);
    expect(workflow).toContain('[[ "$EXPECTED_RUNTIME_CANDIDATE" == "$DEPLOYMENT_TARGET" ]]');
  });

  it("requires contents: write (it mutates production-deploy) and needs the Coolify secrets", () => {
    expect(workflow).toContain("permissions:\n  contents: write");
    expect(workflow).toContain("COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}");
    expect(workflow).toContain("COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL");
  });

  it("asserts controller identity and confirmation before any read or mutation", () => {
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const controllerGuard = workflow.indexOf("Assert this controller is exact, current main");
    const confirmGuard = workflow.indexOf("Assert confirmation phrase");
    const identities = workflow.indexOf("Resolve hard-bound identities");
    expect(controllerGuard).toBeGreaterThan(checkout);
    expect(controllerGuard).toBeLessThan(confirmGuard);
    expect(confirmGuard).toBeLessThan(identities);
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("SUBMIT_CONTROLLER_MAIN_MOVED");
  });

  it("rejects a target carrying the maintenance-only marker even though it is hard-bound", () => {
    expect(workflow).toContain(".release/maintenance-only");
    expect(workflow).toContain("SUBMIT_TARGET_IS_MAINTENANCE_ONLY");
  });

  it("asserts runtime-candidate=R6 and production-deploy=R5 (pre-crossing) before topology/boundary checks", () => {
    const candidateGuard = workflow.indexOf("Assert runtime-candidate is exactly the hard-bound target");
    const prodDeployGuard = workflow.indexOf("Assert production-deploy is still exactly the hard-bound pre-crossing target");
    const topology = workflow.indexOf("Assert R6 topology relative to R5");
    const boundary = workflow.indexOf("Assert no migration/legal/contract boundary crossing between R5 and R6");
    expect(candidateGuard).toBeGreaterThan(-1);
    expect(prodDeployGuard).toBeGreaterThan(candidateGuard);
    expect(topology).toBeGreaterThan(prodDeployGuard);
    expect(boundary).toBeGreaterThan(topology);
    expect(workflow).toContain("RUNTIME_CANDIDATE_UNEXPECTED_SHA");
    expect(workflow).toContain("PRODUCTION_DEPLOY_UNEXPECTED_SHA");
  });

  it("does not call GET /v1/admin/release-control/candidates/head at all - R5's known classifier defect must not gate this crossing", () => {
    // The closing comment explicitly documents that it is NOT called here -
    // this checks for an actual call to the endpoint path, not that string.
    expect(workflow).not.toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(workflow).not.toMatch(/api\s+"\$PUBLIC_API_URL\/v1\/admin\/release-control\/candidates\/head"/);
  });

  it("materializes an exact-R5 detached worktree once, before any readiness call, with its own frozen install", () => {
    const step = workflow.indexOf("Materialize exact R5 once for runtime-pinned readiness parsing");
    const nextStep = workflow.indexOf("Prove full R5 readiness before the first mutation");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('git worktree add --detach "$RUNTIME_ASSERT_DIR" "$TOPOLOGY_BASELINE"');
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && pnpm install --frozen-lockfile)');
    expect(workflow).toContain("RUNTIME_ASSERT_DIR: ${{ runner.temp }}/r5-readiness-runtime");
    // Only one worktree materialization in this workflow - never repeated.
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(1);
  });

  it("proves full R5 readiness (paused-mode assert-generic-production-deploy-ready) with a single read, not a polling loop, using the exact-R5 worktree parser", () => {
    const step = workflow.indexOf("Prove full R5 readiness before the first mutation");
    const nextStep = workflow.indexOf("Move the same owner's expectations from R5 to R6");
    const section = workflow.slice(step, nextStep);
    expect(section).not.toContain("for attempt in");
    expect(section).not.toContain("sleep ");
    expect(section).toContain('.owner_release_id == $owner and');
    expect(section).toContain('.expected.source_commit == $source and');
    // The readiness parser runs inside the exact-R5 worktree, against
    // absolute paths to the controller's own evidence files - never as a
    // bare invocation from main's own checkout (which would use main's
    // stale release-control.ts semantics).
    expect(section).toContain('(cd "$RUNTIME_ASSERT_DIR" && node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$GITHUB_WORKSPACE/status-before.json" "$GITHUB_WORKSPACE/release-before.json" paused)');
    expect(section).not.toMatch(/^\s*node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts status-before\.json/m);
    expect(section).not.toContain("assert-generic-production-deploy-ready.ts \"$GITHUB_WORKSPACE/status-before.json\" \"$GITHUB_WORKSPACE/release-before.json\" open");
    expect(section).toContain("SALES_TEMPORARILY_PAUSED");
    expect(section).toContain('.environment == "production"');
  });

  it("moves expectations via the ordinary updateExpectations endpoint, reading migration/legal from the running R5's own evidence", () => {
    const step = workflow.indexOf("Move the same owner's expectations from R5 to R6");
    const nextStep = workflow.indexOf("Prove the expectations move landed exactly as expected");
    const section = workflow.slice(step, nextStep);
    expect(section).toContain('"$PUBLIC_API_URL/v1/internal/release-control/expectations"');
    expect(section).toContain("migration: $s.expected.migration");
    expect(section).toContain("legal_version: $s.expected.legal_version");
    expect(section).toContain("legal_hashes: $s.runtime.legal_hashes");
    expect(section).toContain(`release_id: $release_id`);
    // Never a new release_id, never acquire/pause/reopen.
    expect(section).not.toContain("/v1/internal/release-control/acquire");
    expect(section).not.toContain("/v1/internal/release-control/pause");
    expect(section).not.toContain("/v1/internal/release-control/reopen");
  });

  it("verifies the post-expectations state against the pre-mutation baseline: owner_mode/migration/legal unchanged, only source_commit moved, runtime still R5", () => {
    const step = workflow.indexOf("Prove the expectations move landed exactly as expected, everything else unchanged, runtime still R5");
    const nextStep = workflow.indexOf("Freshly prove gate and refs immediately before the production-deploy CAS");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    expect(section).toContain("--slurpfile baseline status-before.json");
    // $before must bind the whole status object, not its .expected member -
    // owner_mode is a top-level status field, so $before.expected.owner_mode
    // (or worse, a $before already narrowed to .expected) would silently
    // compare against undefined and fail closed in real production.
    expect(section).toContain("$baseline[0] as $before |");
    expect(section).not.toContain("$baseline[0].expected as $before");
    expect(section).toContain(".expected.source_commit == $source and");
    expect(section).toContain(".owner_mode == $before.owner_mode and");
    expect(section).toContain(".expected.legal_version == $before.expected.legal_version and");
    expect(section).toContain(".expected.legal_manifest_sha256 == $before.expected.legal_manifest_sha256 and");
    expect(section).toContain(".runtime.source_commit == $runtime_source");
    expect(section).toContain("SALES_TEMPORARILY_PAUSED");
  });

  it("bundles a fresh gate+refs proof and the production-deploy CAS in one step, mutation literally last", () => {
    const step = workflow.indexOf("Freshly prove gate and refs immediately before the production-deploy CAS, then CAS");
    const nextStep = workflow.indexOf("- name: Freshly prove post-CAS authority immediately before Coolify");
    expect(step).toBeGreaterThan(-1);
    expect(nextStep).toBeGreaterThan(step);
    const section = workflow.slice(step, nextStep);
    // Fresh gate proof, byte-compared against the pre-mutation baseline.
    expect(section).toContain('"$PUBLIC_API_URL/v1/internal/release-control/status" > status-pre-cas.json');
    expect(section).toContain("--slurpfile baseline status-before.json");
    expect(section).toContain("$baseline[0] as $before |");
    expect(section).not.toContain("$baseline[0].expected as $before");
    expect(section).toContain(".owner_mode == $before.owner_mode and");
    expect(section).toContain(".expected.legal_version == $before.expected.legal_version and");
    expect(section).toContain(".expected.legal_manifest_sha256 == $before.expected.legal_manifest_sha256 and");
    expect(section).toContain("SUBMIT_PRE_CAS_GATE_UNEXPECTED_STATE");
    // Fresh ref rereads.
    expect(section).toContain('[[ "$current_candidate_sha" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain('[[ "$current_production_deploy_sha" == "$TOPOLOGY_BASELINE" ]]');
    expect(section).toContain("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT");
    expect(section).toContain("PRODUCTION_DEPLOY_MOVED_SINCE_PREFLIGHT");
    // The mutation is the last line, using the existing guarded CAS script.
    const lastLine = section.trim().split("\n").at(-1)?.trim();
    expect(lastLine).toBe('scripts/set-production-deploy-ref.sh "$DEPLOYMENT_TARGET"');
    expect(workflow).not.toContain("git push");
  });

  it("bundles a fresh post-CAS authority proof and the Coolify trigger in one step, mutation literally last", () => {
    const step = workflow.indexOf("Freshly prove post-CAS authority immediately before Coolify, then deploy exactly once");
    const closingComment = workflow.indexOf("# STOP.");
    expect(closingComment).toBeGreaterThan(step);
    const section = workflow.slice(step, closingComment);
    const fullFileTail = workflow.slice(step);
    // Fresh ref rereads, then a fresh gate proof including runtime still R5.
    expect(section).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain('[[ "$(git rev-parse origin/runtime-candidate)" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain('"$PUBLIC_API_URL/v1/internal/release-control/status" > status-pre-coolify.json');
    expect(section).toContain("--slurpfile baseline status-before.json");
    expect(section).toContain("$baseline[0] as $before |");
    expect(section).not.toContain("$baseline[0].expected as $before");
    expect(section).toContain(".owner_mode == $before.owner_mode and");
    expect(section).toContain(".expected.legal_version == $before.expected.legal_version and");
    expect(section).toContain(".runtime.source_commit == $runtime_source and");
    expect(section).toContain(".runtime.worker_source_commit == $runtime_source");
    expect(section).toContain("SUBMIT_PRE_COOLIFY_GATE_UNEXPECTED_STATE");
    // No polling, no readiness wait, no reopen, no candidates/head, and the
    // Coolify call is the last command, using the plain no-capture helper
    // form (this crossing does not need the capture directory).
    expect(section).not.toContain("for attempt in");
    expect(section).not.toContain("sleep ");
    expect(section).not.toContain("/v1/internal/release-control/reopen");
    expect(section).not.toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(section).not.toContain("RUNNER_TEMP");
    const lastLine = section.trim().split("\n").at(-1)?.trim();
    expect(lastLine).toBe('scripts/controlled-coolify-deploy.sh "$DEPLOYMENT_TARGET"');
    expect(fullFileTail).toContain("No convergence polling, no candidates/head check, no reopen");
  });

  it("never calls any acquire/pause/reopen/completion endpoint anywhere in the workflow", () => {
    expect(workflow).not.toContain("/v1/internal/release-control/acquire");
    expect(workflow).not.toContain("/v1/internal/release-control/pause");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).not.toContain("release-control/candidates/acquire");
    expect(workflow).not.toContain("release-control/candidates/complete");
    expect(workflow).not.toContain("release-control/legal-publish");
  });

  it("runs every ref/topology/boundary policy script from the controller's single checkout - only the runtime readiness parser uses the pinned R5 worktree", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s*actions\/checkout@/g)];
    expect(checkoutSteps).toHaveLength(1);
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toMatch(/git checkout ["']?\$DEPLOYMENT_TARGET["']?/);
    // The deliberate, narrow exception: a detached worktree exists solely to
    // pin the readiness parser to R5's own runtime semantics, never to run
    // arbitrary candidate code as this controller.
    expect(workflow.match(/git worktree add --detach/g)).toHaveLength(1);
    expect(workflow).toContain('git worktree add --detach "$RUNTIME_ASSERT_DIR" "$TOPOLOGY_BASELINE"');
  });

  it("never invokes the readiness parser as a bare command against main's own checkout, anywhere in the workflow", () => {
    // Every call must be wrapped in a subshell that cd's into the pinned
    // exact-R5 worktree first - a bare `node --import tsx
    // commerce/src/assert-generic-production-deploy-ready.ts` at the
    // default (main) working directory is exactly the defect that failed
    // this workflow's first dispatch (UNKNOWN_EXPECTED_MIGRATION), because
    // main never received R4's migration-allowlist fix.
    const bareInvocations = [...workflow.matchAll(/^\s*node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/gm)];
    expect(bareInvocations).toHaveLength(0);
    const pinnedInvocations = [...workflow.matchAll(/\(cd "\$RUNTIME_ASSERT_DIR" && node --import tsx commerce\/src\/assert-generic-production-deploy-ready\.ts/g)];
    expect(pinnedInvocations).toHaveLength(1);
  });

  it("uses the shared production concurrency group so it cannot overlap other controllers", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });
});
