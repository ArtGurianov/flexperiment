import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(".github/workflows/controlled-topology-normalization.yml", "utf8");

describe("controlled topology normalization", () => {
  it("is manual-only and binds a supplied frozen main target", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toMatch(/^\s*push:/m);
    expect(source).toContain('[[ "$TARGET_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(source).toContain('[[ "$(git rev-parse "${TARGET_SHA}^{tree}")" == "$TARGET_TREE" ]]');
    expect(source).not.toContain('TARGET_SHA="$(git rev-parse HEAD)"');
  });

  it("keeps the one-time waiver controller-covered and production-base-bound", () => {
    expect(source).toContain("BASE_SHA: acfef97f15b45995e0f98a8ac0c649802c2bca9c");
    expect(source).toContain('git merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA" || { echo "NORMALIZATION_CONTROLLER_OLDER_THAN_TARGET" >&2; exit 1; }');
    expect(source).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$BASE_SHA"');
  });

  it("independently rejects every excluded boundary class", () => {
    for (const code of [
      "TOPOLOGY_NORMALIZATION_SCHEMA_CHANGED",
      "TOPOLOGY_NORMALIZATION_LEGAL_CHANGED",
      "TOPOLOGY_NORMALIZATION_SURFACE_CONTRACT_CHANGED",
      "TOPOLOGY_NORMALIZATION_COMPATIBILITY_CHANGED",
      "TOPOLOGY_NORMALIZATION_UNEXPECTED_RELEASE_SEMANTICS",
    ]) expect(source).toContain(code);
    expect(source).toContain('git diff --name-only -z "$BASE_SHA" "$TARGET_SHA" > boundary-paths.bin');
  });

  it("uses the controlled cutover primitives without applying migrations directly", () => {
    expect(source).toContain("scripts/controlled-coolify-deploy.sh");
    expect(source).toContain("scripts/controlled-production-readiness.sh");
    expect(source).not.toContain("commerce:migrate");
    expect(source).not.toContain("commerce/src/migrate.ts");
  });

  it("classifies every exact same-owner restart state before any mutation", () => {
    const classifier = source.slice(
      source.indexOf("- name: Classify durable normalization state"),
      source.indexOf("- name: Prove the Agent Referrals fence before any mutation"),
    );
    for (const state of [
      "DEPLOYMENT_STATE=FRESH",
      "DEPLOYMENT_STATE=OWNED_ACQUIRED_UNPAUSED",
      "DEPLOYMENT_STATE=OWNED_PRE_CAS",
      "DEPLOYMENT_STATE=OWNED_NEEDS_DEPLOY",
      "DEPLOYMENT_STATE=OWNED_CONVERGED",
      "DEPLOYMENT_STATE=ALREADY_COMPLETE",
    ]) expect(classifier).toContain(state);

    // Lost acquire response: held owner but no pause remains resumable.
    expect(classifier).toContain('if jq -e \'.sales_paused == false\' status-before.json');
    expect(classifier).toContain("TOPOLOGY_NORMALIZATION_ACQUIRED_UNPAUSED_POINTER_MISMATCH");
    // After CAS, live TARGET evidence selects convergence; otherwise the held
    // owner is allowed one bounded deployment retry.
    expect(classifier).toContain('.runtime.source_commit == $target and .runtime.worker_source_commit == $target');

    const pause = source.slice(source.indexOf("- name: Pause sales"), source.indexOf("- name: Prove public checkout pause"));
    expect(pause).toContain("env.DEPLOYMENT_STATE == 'FRESH' || env.DEPLOYMENT_STATE == 'OWNED_ACQUIRED_UNPAUSED'");
    const deploy = source.slice(source.indexOf("- name: Deploy exact TARGET"), source.indexOf("- name: Prove an already-converged"));
    for (const state of ["FRESH", "OWNED_ACQUIRED_UNPAUSED", "OWNED_PRE_CAS", "OWNED_NEEDS_DEPLOY"]) expect(deploy).toContain(`env.DEPLOYMENT_STATE == '${state}'`);
    expect(source).toContain("if: env.DEPLOYMENT_STATE == 'OWNED_CONVERGED'");
  });

  it("pins the live BASE rather than copying legal or runtime facts from status", () => {
    for (const identity of [
      "BASE_LEGAL_VERSION: \"2026-08-28.1\"",
      "BASE_LEGAL_MANIFEST_SHA256: fb879a80c48a50c41694d83118e5f8004a4fec5fbf36f954b15f4b678f4efe02",
      "AR_EXPECTED_STATE: ACTIVE",
      "AR_EXPECTED_REVISION: \"4\"",
      "AR_EXPECTED_OWNER: agent-referrals-activation-ce66d23fdcea5fc84018be43cf428270ea889ee8",
      "TOPOLOGY_NORMALIZATION_RUNTIME_CANDIDATE_NOT_BASE",
      "TOPOLOGY_NORMALIZATION_BASE_RUNTIME_IDENTITY_MISMATCH",
      "TOPOLOGY_NORMALIZATION_BASE_SCHEMA_INVENTORY_MISMATCH",
      "TOPOLOGY_NORMALIZATION_BASE_INTEGRITY_CHECK_FAILED",
    ]) expect(source).toContain(identity);
    expect(source).not.toContain('.runtime as $r | {release_id:$id,mode:"CONTROLLED_CUTOVER"');
    expect(source).toContain("git fetch --no-tags origin runtime-candidate");
  });
});
