import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrapper = readFileSync(".github/workflows/controlled-generic-runtime-publication.yml", "utf8");
const primitive = readFileSync(".github/actions/controlled-generic-runtime-publication/action.yml", "utf8");
const workflow = `${wrapper}\n${primitive}`;

describe("controlled generic runtime publication", () => {
  const workflowDispatch = wrapper.slice(wrapper.indexOf("\non:\n"), wrapper.indexOf("\npermissions:"));

  it("is manual, main-only, serialized and sealed to exact controller, target, topology and Test evidence", () => {
    expect(workflowDispatch).toContain("workflow_dispatch:");
    expect(workflowDispatch).not.toContain("push:");
    expect(workflowDispatch).not.toContain("schedule:");
    for (const input of ["target_sha", "expected_controller_sha", "expected_controller_tree", "expected_production_deploy_sha", "expected_test_run_id"]) expect(workflowDispatch).toMatch(new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_CONTROLLER_MOVED");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_CONTROLLER_TREE_MISMATCH");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_TARGET_NOT_COVERED_BY_CONTROLLER");
    expect(workflow).toContain("+refs/heads/runtime-candidate:refs/remotes/origin/runtime-candidate");
    expect(workflow).toContain("+refs/heads/production-deploy:refs/remotes/origin/production-deploy");
    expect(workflow).toContain("scripts/inspect-runtime-candidate-topology.sh");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_TARGET_TOPOLOGY_INELIGIBLE");
  });

  it("requires a successful push Test run for the exact target, not an arbitrary green check", () => {
    expect(workflow).toContain('"$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/runs/$INPUT_EXPECTED_TEST_RUN_ID"');
    expect(workflow).toContain('.name == "Test"');
    expect(workflow).toContain('.event == "push"');
    expect(workflow).toContain('.head_branch == "main"');
    expect(workflow).toContain('.head_sha == $target_sha');
    expect(workflow).toContain('.head_repository.full_name == $repository');
    expect(workflow).toContain('.conclusion == "success"');
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_TEST_EVIDENCE_INVALID");
  });

  it("creates only its deterministic immutable ref through a dedicated publication credential", () => {
    expect(workflow).toContain("refs/heads/runtime/generic-$INPUT_TARGET_SHA");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_REF_TOKEN");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_REF_TOKEN_REQUIRED");
    expect(workflow).not.toContain("RUNTIME_CANDIDATE_REF_TOKEN");
    expect(workflow).not.toContain("PRODUCTION_DEPLOY_REF_TOKEN");
    expect(workflow).toContain('git push --force-with-lease="${PUBLISH_REF}:" origin "${INPUT_TARGET_SHA}:${PUBLISH_REF}"');
    expect(workflow).not.toMatch(/git push\s+--force(?:\s|$)/);
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_REF_CONFLICT");
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_READBACK_MISMATCH");
  });

  it("proves that publication did not promote, deploy, mutate release-control, or move mutable authority", () => {
    expect(workflow).toContain("GENERIC_RUNTIME_PUBLICATION_AUTHORITY_MOVED");
    expect(workflow).toContain("runtime-candidate: unchanged");
    expect(workflow).toContain("production-deploy: unchanged");
    expect(workflow).not.toContain("controlled-runtime-candidate-promotion");
    expect(workflow).not.toContain("controlled-production-deploy");
    expect(workflow).not.toContain("COOLIFY_");
    expect(workflow).not.toContain("release-control/");
  });
});
