import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrapper = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");
const primitive = readFileSync(".github/actions/controlled-runtime-candidate-promotion/action.yml", "utf8");
// The dispatch wrapper owns the environment gate; the shared composite action
// owns the exact CAS primitive and is also what the v2 one-gate coordinator
// invokes.
const workflow = `${wrapper}\n${primitive}`;

describe("controlled runtime-candidate promotion workflow", () => {
  const workflowDispatch = wrapper.slice(wrapper.indexOf("\non:\n"), wrapper.indexOf("\npermissions:"));

  it("is manual, main-only, serialized, and accepts only audited exact identities", () => {
    expect(workflowDispatch).toContain("workflow_dispatch:");
    expect(workflowDispatch).not.toContain("push:");
    expect(workflowDispatch).not.toContain("schedule:");
    for (const input of ["target_sha", "expected_controller_sha", "expected_controller_tree", "expected_published_ref", "expected_runtime_candidate_sha", "expected_production_deploy_sha", "reason"]) expect(workflowDispatch).toMatch(new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain('[[ "$INPUT_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$INPUT_EXPECTED_CONTROLLER_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$INPUT_EXPECTED_CONTROLLER_TREE" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$INPUT_EXPECTED_PUBLISHED_REF" =~ ^refs/heads/runtime/');
    expect(workflow).toContain('[[ "$INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain('[[ "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_REASON_INVALID");
  });

  it("uses only a dedicated credential and exact remote CAS evidence", () => {
    expect(workflow).toContain("RUNTIME_CANDIDATE_REF_TOKEN");
    expect(workflow).not.toContain("PRODUCTION_DEPLOY_REF_TOKEN");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/runtime-candidate");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/production-deploy");
    expect(workflow).toContain("RUNTIME_CANDIDATE_CAS_MISMATCH");
    expect(workflow).toContain("PRODUCTION_DEPLOY_CAS_MISMATCH");
    expect(workflow).toContain("RUNTIME_CANDIDATE_EXPECTED_PUBLISHED_REF_UNAVAILABLE");
    expect(workflow).toContain("RUNTIME_CANDIDATE_EXPECTED_PUBLISHED_REF_MISMATCH");
    expect(workflow).toContain('git ls-remote --exit-code origin "$INPUT_EXPECTED_PUBLISHED_REF"');
    expect(workflow).not.toContain("RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH");
    expect(workflow).not.toContain("for-each-ref --format='%(refname:short)' --contains");
    expect(workflow).toContain('git push --force-with-lease="refs/heads/runtime-candidate:${INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA}"');
    expect(workflow).not.toMatch(/git push\s+--force(?:\s|$)/);
  });

  it("requires ordinary forward topology before the lease-backed update and exact post-state after it", () => {
    const topology = workflow.indexOf("Resolve exact remote refs and prove ordinary promotion topology");
    const mutation = workflow.indexOf("Attempt runtime-candidate lease-backed CAS");
    const postState = workflow.indexOf("Reconcile authoritative post-CAS refs and write audit summary");
    expect(topology).toBeGreaterThan(-1);
    expect(mutation).toBeGreaterThan(topology);
    expect(postState).toBeGreaterThan(mutation);
    // The only ancestry that decides adoption: the NEW target descends from
    // what production runs. The previous proposal's value never gates it.
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"');
    expect(workflow).not.toContain('git merge-base --is-ancestor "$actual_production_deploy" "$actual_runtime_candidate"');
    expect(workflow).not.toContain('git merge-base --is-ancestor "$actual_runtime_candidate" "$INPUT_TARGET_SHA"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_ALREADY_CURRENT");
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_CONTROLLER_SHA_MISMATCH");
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_CONTROLLER_TREE_MISMATCH");
    expect(workflow.match(/git push --force-with-lease=/g)).toHaveLength(1);
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain("set +e");
    expect(workflow).toContain("CAS_PUSH_RC=$cas_push_rc");
    expect(workflow).toContain("read_remote_ref refs/heads/runtime-candidate");
    expect(workflow).toContain("read_remote_ref refs/heads/production-deploy");
    expect(workflow).toContain('[[ "$runtime_candidate_after" == "$INPUT_TARGET_SHA" && "$production_deploy_after" == "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA" ]]');
    expect(workflow).toContain("CAS_PUSH_NOT_APPLIED");
    expect(workflow).toContain("POST_CAS_AUTHORITY_UNEXPECTED");
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_POST_STATE_UNAVAILABLE");
  });

  /**
   * Repair was used twice in its first days, which makes it a de-facto
   * production escape hatch rather than a lifecycle step. It now lives in its
   * own break-glass controller with its own approval boundary, and the
   * ordinary path must never fall back into it.
   */
  it("replaces a stale pointer through the ordinary path, needing no repair mode", () => {
    expect(workflow).not.toContain("repair_diverged_candidate");
    expect(workflow).not.toContain("INPUT_MODE");
    expect(workflow).not.toContain("RUNTIME_CANDIDATE_NOT_DESCENDANT_OF_PRODUCTION");
    // The pointer is still read - as a CAS lease, not as an authority.
    expect(workflow).toContain('git push --force-with-lease="refs/heads/runtime-candidate:${INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA}"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_CAS_MISMATCH");
  });

  it("does not couple candidate promotion to deployment or release-control mutation", () => {
    expect(workflow).not.toContain("controlled-production-deploy.yml");
    expect(workflow).not.toContain("controlled-promo-codes-cutover.yml");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("/v1/admin/release-control/");
    expect(workflow).not.toContain("COOLIFY_");
    expect(workflow).toContain("Lease-backed CAS outcome:");
  });

  it("binds the reviewed controller and one canonical publication ref immediately before CAS", () => {
    const casStep = workflow.slice(workflow.indexOf("- name: Attempt runtime-candidate lease-backed CAS"), workflow.indexOf("- name: Reconcile authoritative post-CAS refs"));
    const finalMain = casStep.indexOf("git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main");
    const controllerSha = casStep.indexOf('[[ "$CONTROLLER_SHA" == "$INPUT_EXPECTED_CONTROLLER_SHA" ]]');
    const controllerTree = casStep.indexOf('git rev-parse "${CONTROLLER_SHA}^{tree}"');
    const mainBind = casStep.indexOf('[[ "$(git rev-parse origin/main)" == "$INPUT_EXPECTED_CONTROLLER_SHA" ]]');
    const canonicalPublication = casStep.indexOf('current_published_target="$(read_remote_ref "$INPUT_EXPECTED_PUBLISHED_REF")"');
    const push = casStep.indexOf('git push --force-with-lease="refs/heads/runtime-candidate:${INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA}"');
    expect(finalMain).toBeGreaterThan(-1);
    expect(controllerSha).toBeGreaterThan(finalMain);
    expect(controllerTree).toBeGreaterThan(controllerSha);
    expect(mainBind).toBeGreaterThan(controllerTree);
    expect(canonicalPublication).toBeGreaterThan(mainBind);
    expect(push).toBeGreaterThan(canonicalPublication);
    const finalAuthority = casStep.indexOf('[[ "$current_published_target" == "$INPUT_TARGET_SHA" ]]');
    expect(finalAuthority).toBeGreaterThan(canonicalPublication);
    expect(casStep.slice(finalAuthority, push)).not.toMatch(/(?:curl|api\s|git fetch|git ls-remote)/);
  });
});
