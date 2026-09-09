import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-release-control-v2-benign.yml", "utf8");
const promotion = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");
const deploy = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");
const promotionPrimitive = readFileSync(".github/actions/controlled-runtime-candidate-promotion/action.yml", "utf8");
const deployPrimitive = readFileSync(".github/actions/controlled-production-deploy/action.yml", "utf8");

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function assertCompositeMetadata(source: string): void {
  expect(source).toContain("runs:\n  using: composite");
  const steps = source.split(/^ {6}- /m).slice(1);
  expect(steps.length).toBeGreaterThan(0);
  for (const step of steps) {
    if (/(?:^|\n {8})run:/.test(step)) {
      expect(step).toMatch(/(?:^|\n) {8}shell: bash(?:\n|$)/);
    }
  }
}

describe("Release Control v2 BENIGN orchestration", () => {
  it("keeps both shared production primitives valid composite actions", () => {
    assertCompositeMetadata(promotionPrimitive);
    assertCompositeMetadata(deployPrimitive);
    expect(deployPrimitive).not.toContain("timeout-minutes:");
  });

  it("is manual-only and rejects every packet that is not an exact execution-eligible BENIGN packet", () => {
    const onBlock = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).not.toContain("push:");
    expect(onBlock).not.toContain("schedule:");
    const preflight = section(workflow, "Bind exact current main", "\n\n  execute:");
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
    const preflight = section(workflow, "Bind exact current main", "\n\n  execute:");
    for (const requirement of [
      "RELEASE_CONTROL_V2_CONTROLLER_SHA_MISMATCH",
      "RELEASE_CONTROL_V2_CONTROLLER_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CONTROLLER_MAIN_MOVED",
      "RELEASE_CONTROL_V2_BASE_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CANDIDATE_TREE_MISMATCH",
      "RELEASE_CONTROL_V2_CANDIDATE_PARENT_MISMATCH",
      "RELEASE_CONTROL_V2_CANDIDATE_IS_MAINTENANCE_ONLY",
      "RELEASE_CONTROL_V2_MATERIALIZATION_PACKET_MISMATCH",
      "RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MISMATCH",
      "RELEASE_CONTROL_V2_PRODUCTION_DEPLOY_BASE_MISMATCH",
      "RELEASE_CONTROL_V2_DIFF_MANIFEST_MISMATCH",
      "RELEASE_CONTROL_V2_CERTIFICATE_MISMATCH",
    ]) expect(preflight).toContain(requirement);
    expect(preflight).toContain("validate-release-control-v2-packet.ts");
    expect(preflight).toContain("verify-release-control-v2-materialization.ts");
    expect(preflight).toContain('git diff --name-only -z "$base_sha" "$candidate_sha"');
    expect(preflight).toContain('readFileSync(process.argv[1]).toString("utf8").split("\\0")');
    const baselineRebind = preflight.indexOf("RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MISMATCH");
    const manifest = preflight.indexOf("git diff --name-only -z");
    expect(baselineRebind).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(baselineRebind);
  });

  it("creates only a deterministic immutable publication ref with a dedicated token and lease", () => {
    const publish = section(workflow, "Create or reconcile exact immutable BENIGN publication", "- uses: ./.github/actions/controlled-runtime-candidate-promotion");
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

  it("passes the complete sealed ordinary-deploy interface only after promotion", () => {
    const executeStart = workflow.indexOf("  execute:");
    expect(executeStart, "missing execute job marker").toBeGreaterThanOrEqual(0);
    const execute = workflow.slice(executeStart);
    const promotion = execute.indexOf("uses: ./.github/actions/controlled-runtime-candidate-promotion");
    const ordinaryMode = execute.indexOf("Select ordinary exact candidate deploy");
    const deploy = execute.indexOf("uses: ./.github/actions/controlled-production-deploy");
    expect(promotion).toBeGreaterThan(-1);
    expect(ordinaryMode).toBeGreaterThan(promotion);
    expect(deploy).toBeGreaterThan(ordinaryMode);
    for (const binding of [
      "INPUT_EXPECTED_CANDIDATE_SHA: ${{ needs.preflight.outputs.candidate_sha }}",
      "INPUT_EXPECTED_CONTROLLER_SHA: ${{ needs.preflight.outputs.controller_sha }}",
      "INPUT_EXPECTED_CONTROLLER_TREE: ${{ needs.preflight.outputs.controller_tree }}",
      "INPUT_EXPECTED_PRODUCTION_DEPLOY_SHA: ${{ needs.preflight.outputs.base_sha }}",
      'POLL_ATTEMPTS: "30"',
      'POLL_SECONDS: "10"',
      'POLL_CONNECT_TIMEOUT: "3"',
      'POLL_MAX_TIME: "7"',
      'INITIAL_READINESS_DELAY_SECONDS: "60"',
    ]) expect(execute).toContain(binding);
    const ordinaryBinding = section(execute, "Select ordinary exact candidate deploy", "- uses: ./.github/actions/controlled-production-deploy");
    expect(ordinaryBinding).toContain('echo "INPUT_TARGET_SHA=" >> "$GITHUB_ENV"');
  });

  it("rebinds the sealed base refs immediately before its first mutable publication", () => {
    const execute = workflow.slice(workflow.indexOf("Rebind exact ordinary authority before any publication"), workflow.indexOf("Create or reconcile exact immutable BENIGN publication"));
    expect(execute).toContain("RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MOVED");
    expect(execute).toContain("RELEASE_CONTROL_V2_PRODUCTION_DEPLOY_BASE_MOVED");
    expect(execute).toContain('[[ "$(git rev-parse "${TARGET_SHA}^")" == "$BASE_SHA" ]]');
    expect(execute).toContain("verify-release-control-v2-materialization.ts");
    expect(execute.indexOf("verify-release-control-v2-materialization.ts")).toBeLessThan(execute.indexOf("RELEASE_CONTROL_V2_RUNTIME_CANDIDATE_BASE_MOVED"));
    expect(execute).not.toContain("git push");
  });

  it("reconstructs instead of fetching a candidate object, before either job can publish", () => {
    const preflight = section(workflow, "Bind exact current main", "\n\n  execute:");
    const execute = section(workflow, "Rebind exact ordinary authority before any publication", "Create or reconcile exact immutable BENIGN publication");
    for (const source of [preflight, execute]) {
      expect(source).toContain("verify-release-control-v2-materialization.ts");
      expect(source).toContain("cmp --silent packet.json reconstructed-packet.json");
    }
    expect(preflight).not.toContain('git fetch --no-tags origin "$base_sha" "$candidate_sha"');
    expect(execute).not.toContain('git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main "$BASE_SHA" "$TARGET_SHA"');
  });

  it("blocks maintenance artifacts after reconstruction in both jobs before the publication step", () => {
    const preflight = section(workflow, "Bind exact current main", "\n\n  execute:");
    const execute = section(workflow, "Rebind exact ordinary authority before any publication", "Create or reconcile exact immutable BENIGN publication");
    for (const source of [preflight, execute]) {
      const reconstruction = source.indexOf("verify-release-control-v2-materialization.ts");
      const marker = source.indexOf("RELEASE_CONTROL_V2_CANDIDATE_IS_MAINTENANCE_ONLY");
      expect(reconstruction).toBeGreaterThan(-1);
      expect(marker).toBeGreaterThan(reconstruction);
    }
    expect(preflight.indexOf("RELEASE_CONTROL_V2_CANDIDATE_IS_MAINTENANCE_ONLY")).toBeLessThan(preflight.indexOf('echo "base_sha=$base_sha"'));
    expect(execute.indexOf("RELEASE_CONTROL_V2_CANDIDATE_IS_MAINTENANCE_ONLY")).toBeLessThan(workflow.indexOf("Create or reconcile exact immutable BENIGN publication"));
  });

  it("keeps all non-BENIGN lanes packet-only by construction", () => {
    for (const lane of ["MIGRATION", "LEGAL", "FINANCIAL", "ATTRIBUTION", "RELEASE_CONTROL", "SURFACE", "COMPATIBILITY"]) {
      expect(workflow).not.toContain(`policy_lanes == ["${lane}"]`);
    }
  });
});
