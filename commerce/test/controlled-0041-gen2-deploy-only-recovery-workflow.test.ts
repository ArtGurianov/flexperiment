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
