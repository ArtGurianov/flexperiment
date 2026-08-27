import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-r5-post-cas-recovery-deploy.yml", "utf8");

const EXPECTED_R5 = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
const EXPECTED_R3 = "97678cc19d2549146b0d4999466a4cded9320208";
const EXPECTED_OWNER = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
const EXPECTED_MIGRATION = "0036_tochka_provider_error_evidence.sql";
const EXPECTED_STATE_HASH = "2a81cf2ec0eab1f9806d4aedb627c0df98ff125aabbd76ea8faa4b37cc997962";
const EXPECTED_PROMO_RELEASE_ID = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";

describe("controlled R5 post-CAS recovery deploy workflow", () => {
  it("is manual-only, with no target/candidate inputs and no arbitrary confirmation", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).not.toContain("push:");
    expect(onBlock).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("target_sha:");
    expect(workflow).not.toContain("expected_candidate_sha:");
    expect(workflow).toContain("confirm:");
    expect(workflow).toContain('REQUIRED_CONFIRM_PHRASE: "DEPLOY-ALREADY-AUTHORIZED-R5-WHILE-PAUSED"');
    expect(workflow).toContain('[[ "$INPUT_CONFIRM" == "$REQUIRED_CONFIRM_PHRASE" ]]');
    expect(workflow).toContain("RECOVERY_DEPLOY_CONFIRM_PHRASE_MISMATCH");
  });

  it("hard-binds every identity to exact R5 (and R3 as topology baseline only), never dynamically resolved", () => {
    expect(workflow).toContain(`EXPECTED_PRODUCTION_DEPLOY: "${EXPECTED_R5}"`);
    expect(workflow).toContain(`EXPECTED_RUNTIME_CANDIDATE: "${EXPECTED_R5}"`);
    expect(workflow).toContain(`DEPLOYMENT_TARGET: "${EXPECTED_R5}"`);
    expect(workflow).toContain(`TOPOLOGY_BASELINE: "${EXPECTED_R3}"`);
    expect(workflow).toContain(`EXPECTED_OWNER_RELEASE_ID: "${EXPECTED_OWNER}"`);
    expect(workflow).toContain(`EXPECTED_MIGRATION: "${EXPECTED_MIGRATION}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_SOURCE_COMMIT: "${EXPECTED_R3}"`);
    expect(workflow).toContain(`EXPECTED_PROMO_STATE_HASH: "${EXPECTED_STATE_HASH}"`);
    // No step derives DEPLOYMENT_TARGET (or the other hard-bound identities)
    // from a ref read at runtime - origin/runtime-candidate is only ever
    // compared against the hard-bound constant, never assigned to it.
    expect(workflow).not.toMatch(/DEPLOYMENT_TARGET=["']?\$\(/);
    expect(workflow).not.toMatch(/EXPECTED_RUNTIME_CANDIDATE=["']?\$\(/);
    expect(workflow).not.toMatch(/EXPECTED_PRODUCTION_DEPLOY=["']?\$\(/);
    expect(workflow).toContain('current_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(workflow).toContain('[[ "$current_candidate_sha" == "$EXPECTED_RUNTIME_CANDIDATE" ]]');
    expect(workflow).toContain('[[ "$EXPECTED_PRODUCTION_DEPLOY" == "$EXPECTED_RUNTIME_CANDIDATE" && "$EXPECTED_RUNTIME_CANDIDATE" == "$DEPLOYMENT_TARGET" ]]');
    expect(workflow).toContain("RECOVERY_DEPLOY_HARDBOUND_TARGET_MISMATCH");
  });

  it("never mutates production-deploy: no CAS script invocation and no git push", () => {
    // The intro comment references set-production-deploy-ref.sh only to
    // explain why it is NOT called here; the workflow must never actually
    // invoke it as a command.
    expect(workflow).not.toMatch(/(^|\s)scripts\/set-production-deploy-ref\.sh(\s|"|$)/m);
    expect(workflow).not.toContain("run: scripts/set-production-deploy-ref.sh");
    expect(workflow).not.toContain("git push");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("This workflow never calls scripts/set-production-deploy-ref.sh");
    expect(workflow).toContain("scripts/read-production-deploy-ref.sh");
    expect(workflow).toContain('[[ "$current_production_deploy_sha" == "$EXPECTED_PRODUCTION_DEPLOY" ]]');
    expect(workflow).toContain("PRODUCTION_DEPLOY_UNEXPECTED_SHA");
  });

  it("never calls any release-control mutation endpoint and contains no reopen path", () => {
    expect(workflow).not.toContain("/v1/internal/release-control/acquire");
    expect(workflow).not.toContain("/v1/internal/release-control/pause");
    expect(workflow).not.toContain("/v1/internal/release-control/expectations");
    expect(workflow).not.toContain("/v1/internal/release-control/reopen");
    expect(workflow).not.toContain("release-control/candidates/acquire");
    expect(workflow).not.toContain("release-control/candidates/complete");
    expect(workflow).not.toContain("release-control/legal-publish");
    expect(workflow).toContain("No reopen step exists in this workflow");
    expect(workflow).toContain("Production remains paused");
  });

  it("asserts controller identity before anything else, mirroring the ordinary Stage A guard", () => {
    const checkout = workflow.indexOf("uses: actions/checkout@v4");
    const controllerGuard = workflow.indexOf("Assert this controller is exact, current main");
    const confirmGuard = workflow.indexOf("Assert confirmation phrase");
    expect(controllerGuard).toBeGreaterThan(checkout);
    expect(controllerGuard).toBeLessThan(confirmGuard);
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("DEPLOY_CONTROLLER_NOT_MAIN");
    expect(workflow).toContain('[[ "$CONTROLLER_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(workflow).toContain("DEPLOY_CONTROLLER_MAIN_MOVED");
  });

  it("rejects a target carrying the maintenance-only marker even though it is hard-bound", () => {
    expect(workflow).toContain(".release/maintenance-only");
    expect(workflow).toContain("RECOVERY_DEPLOY_TARGET_IS_MAINTENANCE_ONLY");
  });

  it("asserts runtime-candidate and production-deploy topology before touching Coolify", () => {
    const runtimeCandidateGuard = workflow.indexOf("Assert runtime-candidate is exactly the hard-bound target");
    const productionDeployGuard = workflow.indexOf("Assert production-deploy is already exactly the hard-bound target");
    const topologyGuard = workflow.indexOf("Assert deployment target topology relative to prior known-good production");
    const deployStep = workflow.indexOf("Deploy exact R5 via the existing Coolify webhook primitive");
    expect(runtimeCandidateGuard).toBeGreaterThan(-1);
    expect(productionDeployGuard).toBeGreaterThan(runtimeCandidateGuard);
    expect(topologyGuard).toBeGreaterThan(productionDeployGuard);
    expect(deployStep).toBeGreaterThan(topologyGuard);
    expect(workflow).toContain('scripts/inspect-runtime-candidate-topology.sh --production-deploy "$TOPOLOGY_BASELINE" --candidate "$DEPLOYMENT_TARGET"');
    expect(workflow).toContain("RECOVERY_DEPLOY_TARGET_NOT_DESCENDANT_OF_BASELINE");
    expect(workflow).toContain("RECOVERY_DEPLOY_TARGET_CONTAINS_MAINTENANCE_COMMIT");
    expect(workflow).toContain("RECOVERY_DEPLOY_TARGET_NOT_LINEAR");
  });

  it("checks the migration/legal/contract boundary before deploying", () => {
    const boundary = workflow.indexOf("Assert no migration/legal/contract boundary crossing since baseline");
    const deployStep = workflow.indexOf("Deploy exact R5 via the existing Coolify webhook primitive");
    expect(boundary).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(deployStep);
    expect(workflow).toContain('git diff --name-only -z "$TOPOLOGY_BASELINE" "$DEPLOYMENT_TARGET" -- commerce/migrations commerce/legal public/legal release-surface-contract.json');
    expect(workflow).toContain("commerce:production-deploy:assert-boundary recovery-deploy-boundary-paths.bin");
  });

  it("deploys through the existing unstaged Coolify helper, not a hand-rolled webhook call", () => {
    const deployStep = workflow.indexOf("Deploy exact R5 via the existing Coolify webhook primitive");
    const nextStep = workflow.indexOf("Allow Coolify deployments to start");
    const deploySection = workflow.slice(deployStep, nextStep);
    expect(deploySection).toContain('scripts/controlled-coolify-deploy.sh "$DEPLOYMENT_TARGET"');
    expect(deploySection).not.toContain("curl");
    expect(workflow.match(/COOLIFY_TOKEN/g)?.length).toBeGreaterThan(0);
    expect(workflow).toContain("no staged variant of this script, and none is invented here");
  });

  it("rereads runtime-candidate and production-deploy immediately before the Coolify mutation, still hard-bound", () => {
    const boundary = workflow.indexOf("Assert no migration/legal/contract boundary crossing since baseline");
    const reread = workflow.indexOf("Reread runtime-candidate and production-deploy immediately before the Coolify mutation");
    const deployStep = workflow.indexOf("Deploy exact R5 via the existing Coolify webhook primitive");
    expect(reread).toBeGreaterThan(boundary);
    expect(reread).toBeLessThan(deployStep);
    const section = workflow.slice(reread, deployStep);
    expect(section).toContain('current_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(section).toContain('[[ "$current_candidate_sha" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain("RUNTIME_CANDIDATE_MOVED_SINCE_PREFLIGHT");
    expect(section).toContain('current_production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(section).toContain('[[ "$current_production_deploy_sha" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain("PRODUCTION_DEPLOY_MOVED_SINCE_PREFLIGHT");
    // Never a dynamically substituted target - both sides of every
    // comparison in this guard are either a fresh read or the same
    // hard-bound DEPLOYMENT_TARGET constant used everywhere else.
    expect(section).not.toMatch(/DEPLOYMENT_TARGET="\$\(/);
  });

  it("polls with bounded retries (not a single fixed-delay check) until every surface converges on exact R5 while still paused", () => {
    const pollStep = workflow.indexOf("Poll until Commerce/worker/frontend/admin converge on exact R5 while still paused");
    const deployStep = workflow.indexOf("Deploy exact R5 via the existing Coolify webhook primitive");
    const initialDelay = workflow.indexOf("Allow Coolify deployments to start");
    const checkoutProof = workflow.indexOf("Prove public checkout is paused, not corrupt");
    expect(pollStep).toBeGreaterThan(initialDelay);
    expect(initialDelay).toBeGreaterThan(deployStep);
    expect(checkoutProof).toBeGreaterThan(pollStep);
    expect(workflow).toContain('POLL_ATTEMPTS: "30"');
    expect(workflow).toContain('POLL_SECONDS: "10"');
    expect(workflow).toContain('POLL_CONNECT_TIMEOUT: "3"');
    expect(workflow).toContain('POLL_MAX_TIME: "7"');
    const section = workflow.slice(pollStep, checkoutProof);
    expect(section).toContain('for attempt in $(seq 1 "$POLL_ATTEMPTS"); do');
    expect(section).toContain('sleep "$POLL_SECONDS"');
    expect(section).toContain('[[ "$attempt" == "$POLL_ATTEMPTS" ]] && { echo "RECOVERY_DEPLOY_RUNTIME_NOT_READY" >&2; exit 1; }');
    expect(section).toContain("then break; fi");
    // The generic-gate owner/paused/expected check, the paused-mode
    // readiness proof, and the frontend/admin/health/ready checks all live
    // inside the same retry loop iteration, not as separate one-shot steps.
    expect(section).toContain(".sales_paused == true and");
    expect(section).toContain('.owner_release_id == $owner and');
    expect(section).toContain('.owner_mode == "CONTROLLED_CUTOVER" and');
    expect(section).toContain(".expected.source_commit == $source and");
    expect(section).toContain(".expected.migration == $migration");
    expect(section).not.toContain(`deploy-${EXPECTED_R5}`);
    expect(section).toContain("assert-generic-production-deploy-ready.ts status.json release.json paused");
    expect(section).not.toContain("assert-generic-production-deploy-ready.ts status.json release.json open");
    expect(section).toContain("get \"$PUBLIC_FRONTEND_URL/release.json\" > frontend.json");
    expect(section).toContain("get \"$ADMIN_RELEASE_URL\" > admin.json");
    expect(section).toContain('jq -e --arg sha "$DEPLOYMENT_TARGET" \'.source_commit == $sha\' frontend.json');
    expect(section).toContain('jq -e --arg sha "$DEPLOYMENT_TARGET" \'.source_commit == $sha\' admin.json');
    expect(section).toContain('get "$PUBLIC_API_URL/healthz" > health.json');
    expect(section).toContain('get "$PUBLIC_API_URL/readyz" > ready.json');
    expect(section).toContain("jq -e '.ok == true' health.json");
    expect(section).toContain("jq -e '.ok == true' ready.json");
  });

  it("proves public checkout returns SALES_TEMPORARILY_PAUSED, not RELEASE_STATE_CORRUPT", () => {
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/public/checkouts"');
    expect(workflow).toContain('"$pause_status" == "503"');
    expect(workflow).toContain("SALES_TEMPORARILY_PAUSED");
    expect(workflow).not.toContain("RELEASE_STATE_CORRUPT");
  });

  it("proves the Promo v2 head, release id, and state hash are exactly unchanged", () => {
    expect(workflow).toContain(`EXPECTED_PROMO_RELEASE_ID: "${EXPECTED_PROMO_RELEASE_ID}"`);
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/admin/release-control/candidates/head"');
    expect(workflow).toContain(".head.release_id == $release_id and");
    expect(workflow).toContain('.head.phase == "COMPLETE"');
    expect(workflow).toContain(".head.candidate_generation == $generation");
    expect(workflow).toContain(".head.phase_sequence == $sequence");
    expect(workflow).toContain(".head.source_commit == $source");
    expect(workflow).toContain(".state_hash == $hash");
    expect(workflow).toContain("RECOVERY_DEPLOY_PROMO_HEAD_CHANGED");
  });

  it("proves provider readiness stays read-only using the actual probe() contract, not a guessed field", () => {
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/provider-readiness"');
    expect(workflow).toContain('.environment == "production"');
    // The prior draft guessed at retailers/retailersOk/retailers_ok/probeError
    // fields that do not exist on ProviderProbe - providerReadiness() returns
    // exactly TochkaProvider.probe()'s { environment } result, and probe()
    // throws (not returns an error field) on failure.
    expect(workflow).not.toContain(".probeError");
    expect(workflow).not.toContain(".retailers");
    expect(workflow).not.toContain(".retailersOk");
    expect(workflow).not.toContain(".retailers_ok");
    expect(workflow).not.toContain("/v1/internal/payments");
    expect(workflow).not.toContain("/refund");
  });

  it("takes one final fresh authority snapshot as the last executable step, after every incident proof", () => {
    const providerStep = workflow.indexOf("Prove provider readiness is read-only healthy");
    const finalStep = workflow.indexOf("Final authority snapshot remains exact R5 and paused");
    expect(finalStep).toBeGreaterThan(providerStep);
    // It really is the last step: nothing but the closing comment follows it.
    const afterFinalStep = workflow.slice(finalStep + "Final authority snapshot remains exact R5 and paused".length);
    expect(afterFinalStep).not.toMatch(/\n {6}- name:/);
    const section = workflow.slice(finalStep);
    // Fresh runtime-candidate reread, not a reuse of an earlier variable.
    expect(section).toContain("git fetch --no-tags origin runtime-candidate");
    expect(section).toContain('final_candidate_sha="$(git rev-parse origin/runtime-candidate)"');
    expect(section).toContain('[[ "$final_candidate_sha" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain("FINAL_RUNTIME_CANDIDATE_UNEXPECTED_SHA");
    // Fresh production-deploy reread via the same read-only script used earlier.
    expect(section).toContain('final_production_deploy_sha="$(scripts/read-production-deploy-ref.sh)"');
    expect(section).toContain('[[ "$final_production_deploy_sha" == "$DEPLOYMENT_TARGET" ]]');
    expect(section).toContain("FINAL_PRODUCTION_DEPLOY_UNEXPECTED_SHA");
    // Fresh generic-gate snapshot: exact deploy-R4 owner, still paused, still expecting R5/0036.
    expect(section).toContain("final-status.json");
    expect(section).toContain('.owner_release_id == $owner and');
    expect(section).toContain('.owner_mode == "CONTROLLED_CUTOVER" and');
    expect(section).toContain(".sales_paused == true and");
    expect(section).toContain(".expected.source_commit == $source and");
    expect(section).toContain(".expected.migration == $migration");
    expect(section).toContain("FINAL_GENERIC_GATE_UNEXPECTED_STATE");
    // Fresh Promo head snapshot: exact release id/gen5/R3/COMPLETE:5/hash.
    expect(section).toContain("final-candidate-head.json");
    expect(section).toContain(".head.release_id == $release_id and");
    expect(section).toContain('.head.phase == "COMPLETE" and');
    expect(section).toContain(".head.candidate_generation == $generation and");
    expect(section).toContain(".head.phase_sequence == $sequence and");
    expect(section).toContain(".head.source_commit == $source and");
    expect(section).toContain(".state_hash == $hash");
    expect(section).toContain("FINAL_PROMO_HEAD_CHANGED");
    // Does not repeat the provider probe or the checkout call - those are
    // separate semantic proofs that already ran immediately before this.
    expect(section).not.toContain("provider-readiness");
    expect(section).not.toContain("/v1/public/checkouts");
  });

  it("runs every policy script from the controller's own checkout, never a second worktree", () => {
    const checkoutSteps = [...workflow.matchAll(/uses:\s*actions\/checkout@/g)];
    expect(checkoutSteps).toHaveLength(1);
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toMatch(/git checkout ["']?\$DEPLOYMENT_TARGET["']?/);
    expect(workflow).not.toMatch(/\$DEPLOYMENT_TARGET\/scripts/);
  });

  it("uses the shared production concurrency group so it cannot overlap the ordinary Stage A workflow", () => {
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
  });
});
