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
    expect(workflow).toContain("group: controlled-runtime-candidate-promotion");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: write");
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
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/runtime-candidate");
    expect(workflow).toContain("git ls-remote --exit-code origin refs/heads/production-deploy");
    expect(workflow).toContain("RUNTIME_CANDIDATE_CAS_MISMATCH");
    expect(workflow).toContain("PRODUCTION_DEPLOY_CAS_MISMATCH");
    expect(workflow).toContain("RUNTIME_CANDIDATE_PRE_CAS_FETCH_MISMATCH");
    expect(workflow).toContain("PRODUCTION_DEPLOY_POST_CAS_MISMATCH");
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH");
    expect(workflow).toContain("refs/remotes/origin/runtime/*");
    expect(workflow).toContain('git push --force-with-lease="refs/heads/runtime-candidate:${INPUT_EXPECTED_RUNTIME_CANDIDATE_SHA}"');
    expect(workflow).not.toMatch(/git push\s+--force(?:\s|$)/);
  });

  it("requires ordinary forward topology before the lease-backed update and exact post-state after it", () => {
    const topology = workflow.indexOf("Resolve exact remote refs and prove ordinary promotion topology");
    const reconfirm = workflow.indexOf("Reconfirm exact CAS inputs immediately before promotion");
    const mutation = workflow.indexOf("Advance runtime candidate by exact lease-backed CAS");
    const postState = workflow.indexOf("Prove exact post-promotion refs and write audit summary");
    expect(topology).toBeGreaterThan(-1);
    expect(reconfirm).toBeGreaterThan(topology);
    expect(mutation).toBeGreaterThan(reconfirm);
    expect(postState).toBeGreaterThan(mutation);
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$actual_runtime_candidate"');
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$actual_runtime_candidate" "$INPUT_TARGET_SHA"');
    expect(workflow).toContain("RUNTIME_CANDIDATE_TARGET_ALREADY_CURRENT");
    expect(workflow).toContain('[[ "$runtime_candidate_after" == "$INPUT_TARGET_SHA" ]]');
    expect(workflow).toContain('[[ "$production_deploy_after" == "$INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA" ]]');
  });

  it("does not couple candidate promotion to deployment or release-control mutation", () => {
    expect(workflow).not.toContain("controlled-production-deploy.yml");
    expect(workflow).not.toContain("controlled-promo-codes-cutover.yml");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("/v1/admin/release-control/");
    expect(workflow).not.toContain("COOLIFY_");
    expect(workflow).toContain("Lease-backed CAS update: PASS");
  });
});
