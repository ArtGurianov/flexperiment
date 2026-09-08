import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-release-control-v2-benign.yml", "utf8");
const promotion = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");
const deploy = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");
const promotionPrimitive = readFileSync(".github/actions/controlled-runtime-candidate-promotion/action.yml", "utf8");
const deployPrimitive = readFileSync(".github/actions/controlled-production-deploy/action.yml", "utf8");

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
      "RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MISMATCH",
      "RELEASE_CONTROL_V2_PRODUCTION_DEPLOY_BASE_MISMATCH",
      "RELEASE_CONTROL_V2_DIFF_MANIFEST_MISMATCH",
      "RELEASE_CONTROL_V2_CERTIFICATE_MISMATCH",
    ]) expect(preflight).toContain(requirement);
    expect(preflight).toContain("validate-release-control-v2-packet.ts");
    expect(preflight).toContain('git diff --name-only -z "$base_sha" "$candidate_sha"');
    expect(preflight).toContain('readFileSync(process.argv[1]).toString("utf8").split("\\0")');
    const baselineRebind = preflight.indexOf("RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MISMATCH");
    const manifest = preflight.indexOf("git diff --name-only -z");
    expect(baselineRebind).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(baselineRebind);
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

  it("uses the shared guarded promotion and deploy primitives beneath one production approval", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow.match(/environment: production/g)).toHaveLength(1);
    expect(workflow).toContain("uses: ./.github/actions/controlled-runtime-candidate-promotion");
    expect(workflow).toContain("uses: ./.github/actions/controlled-production-deploy");
    expect(promotion).toContain("uses: ./.github/actions/controlled-runtime-candidate-promotion");
    expect(deploy).toContain("uses: ./.github/actions/controlled-production-deploy");
    expect(promotionPrimitive).not.toContain("controlled-production-deploy.yml");
    expect(deployPrimitive).toContain("controlled-coolify-deploy.sh");
    expect(deployPrimitive).toContain("set-production-deploy-ref.sh");
    expect(promotionPrimitive).not.toContain("environment:");
    expect(deployPrimitive).not.toContain("environment:");
    expect(workflow).not.toContain("/agent-referrals/activate");
    expect(promotion).toContain("workflow_dispatch:");
    expect(deploy).toContain("workflow_dispatch:");
  });

  it("restores the standard write credential only after the narrow candidate CAS before the shared deploy primitive", () => {
    const promotion = workflow.indexOf("uses: ./.github/actions/controlled-runtime-candidate-promotion");
    const credential = workflow.indexOf("Bind generic deployment credential after candidate promotion");
    const deploy = workflow.indexOf("uses: ./.github/actions/controlled-production-deploy");
    expect(workflow).toContain("RELEASE_CONTROL_V2_DEPLOYMENT_GITHUB_TOKEN_REQUIRED");
    expect(promotion).toBeGreaterThan(-1);
    expect(credential).toBeGreaterThan(promotion);
    expect(deploy).toBeGreaterThan(credential);
  });

  it("rebinds the sealed base refs immediately before its first mutable publication", () => {
    const execute = workflow.slice(workflow.indexOf("Rebind exact ordinary authority before any publication"), workflow.indexOf("Create or reconcile exact immutable BENIGN publication"));
    expect(execute).toContain("RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MOVED");
    expect(execute).toContain("RELEASE_CONTROL_V2_PRODUCTION_DEPLOY_BASE_MOVED");
    expect(execute).toContain('git merge-base --is-ancestor "$BASE_SHA" "$TARGET_SHA"');
    expect(execute).not.toContain("git push");
  });

  it("keeps all non-BENIGN lanes packet-only by construction", () => {
    for (const lane of ["MIGRATION", "LEGAL", "FINANCIAL", "ATTRIBUTION", "RELEASE_CONTROL", "SURFACE", "COMPATIBILITY"]) {
      expect(workflow).not.toContain(`policy_lanes == ["${lane}"]`);
    }
  });
});
