import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-release-control-v2-benign.yml", "utf8");
const promotion = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");
const deploy = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");

describe("Release Control v2 BENIGN orchestration", () => {
  it("is manual-only and rejects every packet that is not an exact execution-eligible BENIGN packet", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).not.toContain("push:");
    expect(onBlock).not.toContain("schedule:");
    const preflight = workflow.slice(workflow.indexOf("Bind exact current main"), workflow.indexOf("  publish:"));
    for (const requirement of [
      '.policy_lanes == ["BENIGN"]',
      '.decision == "ADMIT_BENIGN_SHADOW"',
      '.required_authority == "NONE"',
      '(.stop_conditions | length) == 0',
      '.activation_required == false',
      '.generated_workflows == []',
      '.historical_synthesis == false',
      '.mutation_plan == null',
      "RELEASE_CONTROL_V2_PACKET_NOT_EXECUTION_ELIGIBLE",
    ]) expect(preflight).toContain(requirement);
  });

  it("rebinds controller and certifies all packet identities, topology, and manifest before any consequence", () => {
    const preflight = workflow.slice(workflow.indexOf("Bind exact current main"), workflow.indexOf("  publish:"));
    for (const requirement of [
      "RELEASE_CONTROL_V2_CONTROLLER_SHA_MISMATCH",
      "RELEASE_CONTROL_V2_CONTROLLER_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CONTROLLER_MAIN_MOVED",
      "RELEASE_CONTROL_V2_BASE_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CANDIDATE_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CANDIDATE_NOT_DESCENDANT",
      "RELEASE_CONTROL_V2_CANDIDATE_NOT_LINEAR",
      "RELEASE_CONTROL_V2_CANDIDATE_CONTAINS_MAINTENANCE",
      "RELEASE_CONTROL_V2_DIFF_MANIFEST_MISMATCH",
      "RELEASE_CONTROL_V2_CERTIFICATE_MISMATCH",
    ]) expect(preflight).toContain(requirement);
    expect(preflight).toContain("validate-release-control-v2-packet.ts");
  });

  it("creates only a deterministic immutable publication ref with a dedicated token and lease", () => {
    const publish = workflow.slice(workflow.indexOf("Create or reconcile exact immutable BENIGN publication"), workflow.indexOf("  promote:"));
    expect(publish).toContain("RELEASE_CONTROL_V2_CANDIDATE_REF_TOKEN");
    expect(publish).not.toContain("RUNTIME_CANDIDATE_REF_TOKEN");
    expect(publish).not.toContain("PRODUCTION_DEPLOY_REF_TOKEN");
    expect(workflow).toContain('[[ "$candidate_publication_ref" == "refs/heads/runtime/release-control-v2-$candidate_sha" ]]');
    expect(publish).toContain('git push --force-with-lease="$PUBLICATION_REF:"');
    expect(publish).toContain("RELEASE_CONTROL_V2_PUBLICATION_READBACK_MISMATCH");
    expect(publish).not.toContain("controlled-coolify-deploy.sh");
    expect(publish).not.toContain("/activate");
  });

  it("delegates promotion and deployment to the existing guarded controllers instead of implementing a second engine", () => {
    expect(workflow).toContain("uses: ./.github/workflows/controlled-runtime-candidate-promotion.yml");
    expect(workflow).toContain("uses: ./.github/workflows/controlled-production-deploy.yml");
    expect(workflow).not.toContain("controlled-coolify-deploy.sh");
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("/agent-referrals/activate");
    expect(promotion).toContain("workflow_call:");
    expect(deploy).toContain("workflow_call:");
  });

  it("keeps all non-BENIGN lanes packet-only by construction", () => {
    for (const lane of ["MIGRATION", "LEGAL", "FINANCIAL", "ATTRIBUTION", "RELEASE_CONTROL", "SURFACE", "COMPATIBILITY"]) {
      expect(workflow).not.toContain(`policy_lanes == ["${lane}"]`);
    }
  });
});
