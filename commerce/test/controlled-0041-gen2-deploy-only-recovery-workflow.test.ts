import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-0041-gen2-deploy-only-recovery.yml", "utf8");
const offlineBridge = readFileSync("scripts/controlled-0041-offline-bridge.sh", "utf8");
const receiptReader = readFileSync("scripts/read-0041-offline-bridge-receipt.sh", "utf8");

describe("0041 Gen2 deploy-only recovery workflow", () => {
  it("hard-binds GEN2 and offers no path to restart GEN1 or run the bridge", () => {
    expect(workflow).toContain("GEN2_RUNTIME_SHA: 0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34");
    expect(workflow).toContain("GEN1_RUNTIME_SHA: 68f80a411b7f286928ef10826ed225228098d246");
    expect(workflow).not.toContain("target_sha:");
    expect(workflow).not.toContain("replacement_sha:");
    expect(workflow).not.toContain("gen1-to-gen2-post-activation-email-bridge.ts");
    expect(workflow).toContain("GEN2_DEPLOY_OLD_RUNTIME_FORBIDDEN");
    expect(workflow).toContain("scripts/read-0041-offline-bridge-receipt.sh");
  });

  it("binds the separately reviewed Gen2 runtime without requiring squash-controller ancestry", () => {
    expect(workflow).not.toContain('git merge-base --is-ancestor "$GEN2_RUNTIME_SHA" "$CONTROLLER_SHA"');
    expect(workflow).not.toContain("GEN2_DEPLOY_CONTROLLER_OLDER_THAN_TARGET");
    expect(workflow).toContain('[[ "$(git rev-parse "$GEN2_RUNTIME_SHA^")" == "$GEN1_RUNTIME_SHA" ]]');
    expect(workflow).toContain('git cat-file -e "$GEN2_RUNTIME_SHA^{commit}"');
    expect(workflow).toContain('GEN2_DEPLOY_TARGET_IS_MAINTENANCE_ONLY');
  });

  it("pins Node and validates every post-CAS dependency before receipt or CAS", () => {
    const substratePreflight = workflow.indexOf("Validate deployment and convergence substrate before CAS");
    const receiptProof = workflow.indexOf("Prove the durable offline bridge receipt");
    const pointerCas = workflow.indexOf("CAS production-deploy to Gen2 before any webhook");
    expect(workflow).toContain("OFFLINE_BRIDGE_NODE_BIN: /root/flexperiment-0041-tools/node");
    expect(workflow).toContain("COMMERCE_GEN1_TO_GEN2_BRIDGE_NODE_BIN=$OFFLINE_BRIDGE_NODE_BIN");
    expect(substratePreflight).toBeGreaterThanOrEqual(0);
    expect(substratePreflight).toBeLessThan(receiptProof);
    expect(substratePreflight).toBeLessThan(pointerCas);
    for (const name of [
      "COOLIFY_TOKEN", "COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL", "COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL",
      "COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL", "COMMERCE_RELEASE_CONTROL_TOKEN", "PUBLIC_API_URL",
      "PUBLIC_FRONTEND_URL", "ADMIN_RELEASE_URL",
    ]) expect(workflow).toContain(name);
    expect(workflow).toContain("require_https_url");
    expect(receiptReader).toContain("COMMERCE_GEN1_TO_GEN2_BRIDGE_NODE_BIN");
    const nodeValidation = receiptReader.indexOf("0041_OFFLINE_RECEIPT_NODE_BIN_INVALID");
    const verifier = receiptReader.indexOf('"$node_bin" --import tsx commerce/src/assert-gen1-to-gen2-offline-bridge.ts');
    expect(nodeValidation).toBeGreaterThanOrEqual(0);
    expect(receiptReader).not.toContain("node --import tsx");
    expect(receiptReader.indexOf('cd "$maintenance_worktree"')).toBeLessThan(verifier);
    expect(nodeValidation).toBeLessThan(verifier);
  });

  it("requires an executable stop and no-restart proof before the offline DB mutation", () => {
    const disableRestart = offlineBridge.indexOf("docker update --restart=no");
    const stop = offlineBridge.indexOf("docker stop --time 30");
    const proof = offlineBridge.indexOf("assert_gen1_readers_stopped", stop);
    const mutation = offlineBridge.indexOf("gen1-to-gen2-post-activation-email-bridge.ts");
    expect(disableRestart).toBeGreaterThanOrEqual(0);
    expect(offlineBridge.indexOf("expected_state_hash=")).toBeGreaterThanOrEqual(0);
    expect(offlineBridge.indexOf("expected_state_hash=")).toBeLessThan(disableRestart);
    expect(offlineBridge).toContain('COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH="$expected_state_hash"');
    expect(stop).toBeGreaterThan(disableRestart);
    expect(proof).toBeGreaterThan(stop);
    expect(mutation).toBeGreaterThan(proof);
    expect(offlineBridge).toContain("0041_OFFLINE_BRIDGE_UNEXPECTED_LIVE_DATABASE_READER");
    expect(receiptReader).toContain("0041_OFFLINE_RECEIPT_LIVE_DATABASE_READER");
    expect(receiptReader).toContain("0041_OFFLINE_RECEIPT_RESTART_PATH_ENABLED");
    expect(receiptReader).toContain("stat -c '%u:%a'");
    expect(offlineBridge).toContain("0041_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_MISMATCH");
    expect(receiptReader).toContain("GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH");
    expect(offlineBridge).toContain('readonly MAIN_CONTROLLER_SHA="1f76c0eb73958e89356ff830036b8ef1c8b49c5b"');
    expect(receiptReader).toContain('"1f76c0eb73958e89356ff830036b8ef1c8b49c5b $GEN2_RUNTIME_SHA"');
    expect(offlineBridge).not.toContain("6500586395034516495a2dcaec868d4b577b853f");
    expect(receiptReader).not.toContain("6500586395034516495a2dcaec868d4b577b853f");
  });

  it("reads the stopped-volume receipt before CAS and cannot webhook Gen1", () => {
    const receiptProof = workflow.indexOf("Prove the durable offline bridge receipt");
    const pointerCas = workflow.indexOf("CAS production-deploy to Gen2 before any webhook");
    const deploy = workflow.indexOf('scripts/controlled-coolify-deploy.sh "$GEN2_RUNTIME_SHA"');
    expect(receiptProof).toBeGreaterThanOrEqual(0);
    expect(pointerCas).toBeGreaterThan(receiptProof);
    expect(deploy).toBeGreaterThan(pointerCas);
    expect(workflow.slice(0, deploy)).not.toContain("/v1/internal/release-control/");
    expect(workflow).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$GEN1_RUNTIME_SHA" ]]');
    expect(workflow).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$GEN2_RUNTIME_SHA" ]]');
    expect(workflow).toContain("OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA");
  });
});
