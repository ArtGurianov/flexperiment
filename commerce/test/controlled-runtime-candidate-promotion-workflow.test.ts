import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");

describe("controlled runtime-candidate promotion workflow", () => {
  const workflowDispatch = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));

  it("is manual, main-only, serialized, and accepts only audited exact identities", () => {
    expect(workflowDispatch).toContain("workflow_dispatch:");
    expect(workflowDispatch).not.toContain("push:");
    expect(workflowDispatch).not.toContain("schedule:");
    for (const input of ["target_sha", "expected_runtime_candidate_sha", "expected_production_deploy_sha", "reason"]) expect(workflowDispatch).toMatch(new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain('[[ "$INPUT_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]');
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
    expect(workflow).toContain("RUNTIME_CANDIDATE_PRE_CAS_FETCH_MISMATCH");
    expect(workflow).toContain("PRODUCTION_DEPLOY_PRE_CAS_FETCH_MISMATCH");
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH");
    expect(workflow).toContain("refs/remotes/origin/runtime/*");
    expect(workflow).toContain('git push --force-with-lease="refs/heads/runtime-candidate:${INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA}"');
    expect(workflow).not.toMatch(/git push\s+--force(?:\s|$)/);
  });

  it("requires ordinary forward topology before the lease-backed update and exact post-state after it", () => {
    const topology = workflow.indexOf("Resolve exact remote refs and prove ordinary promotion topology");
    const reconfirm = workflow.indexOf("Reconfirm exact CAS inputs immediately before promotion");
    const mutation = workflow.indexOf("Attempt runtime-candidate lease-backed CAS");
    const postState = workflow.indexOf("Reconcile authoritative post-CAS refs and write audit summary");
    expect(topology).toBeGreaterThan(-1);
    expect(reconfirm).toBeGreaterThan(topology);
    expect(mutation).toBeGreaterThan(reconfirm);
    expect(postState).toBeGreaterThan(mutation);
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$actual_runtime_candidate"');
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_runtime_candidate" "$INPUT_TARGET_SHA"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_ALREADY_CURRENT");
    expect(workflow.match(/git push --force-with-lease=/g)).toHaveLength(1);
    expect(workflow).toContain("set -uo pipefail");
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
   * A cutover that advances production-deploy without touching
   * runtime-candidate leaves the candidate no longer descending from
   * production, which blocks every generic deploy - and the ordinary path
   * cannot repair it, because it validates that same property first.
   */
  it("repairs a diverged candidate only while it is genuinely diverged", () => {
    expect(workflow).toContain("options: [ordinary, repair_diverged_candidate]");
    expect(workflow).toContain("RUNTIME_CANDIDATE_PROMOTION_MODE_INVALID");
    // Self-disabling: refuses on a healthy candidate, so it can never become a
    // general force primitive.
    expect(workflow).toContain("RUNTIME_CANDIDATE_REPAIR_NOT_DIVERGED");

    // The target must descend from production-deploy in BOTH modes - that is
    // the invariant repair exists to restore, never one it may waive.
    const targetDescendsProduction = 'git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"';
    const guarded = workflow.slice(workflow.indexOf('if [[ "$INPUT_MODE" == ordinary ]]'));
    expect(workflow.indexOf(targetDescendsProduction)).toBeLessThan(workflow.indexOf('if [[ "$INPUT_MODE" == ordinary ]]'));
    // Only the two assertions about the *current* candidate are mode-scoped.
    expect(guarded).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$actual_runtime_candidate"');
    expect(guarded).toContain('git merge-base --is-ancestor "$actual_runtime_candidate" "$INPUT_TARGET_SHA"');

    // Repair still requires a published runtime branch, the CAS lease, and an
    // audited mode - it relaxes nothing else.
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH");
    expect(workflow.match(/git push --force-with-lease=/g)).toHaveLength(1);
    expect(workflow).toContain('echo "- Mode: $INPUT_MODE"');
  });

  it("does not couple candidate promotion to deployment or release-control mutation", () => {
    expect(workflow).not.toContain("controlled-production-deploy.yml");
    expect(workflow).not.toContain("controlled-promo-codes-cutover.yml");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("/v1/admin/release-control/");
    expect(workflow).not.toContain("COOLIFY_");
    expect(workflow).toContain("Lease-backed CAS outcome:");
  });
});
