import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const absent = [
  ".github/workflows/controlled-0041-gen2-email-recovery.yml",
  "scripts/controlled-0041-offline-bridge.sh",
  "scripts/read-0041-offline-bridge-receipt.sh",
  "scripts/read-0041-offline-bridge-receipt-from-pinned-volume.sh",
  "commerce/src/assert-gen1-to-gen2-offline-bridge.ts",
  "commerce/src/gen1-to-gen2-post-activation-email-bridge.ts",
  "commerce/test/controlled-0041-gen2-email-recovery-workflow.test.ts",
  "commerce/test/gen1-to-gen2-post-activation-email-bridge.test.ts",
  ".release/maintenance-only",
];

const terminalCleanup = readFileSync("docs/release/0041_TERMINAL_CLEANUP.md", "utf8");
const bridgeHistory = readFileSync("docs/release/0041_OFFLINE_GEN1_TO_GEN2_BRIDGE.md", "utf8");
const recoveryHistory = readFileSync("docs/release/0041_POST_BRIDGE_GEN2_EMAIL_RECOVERY.md", "utf8");
const releaseControl = readFileSync("commerce/src/release-control.ts", "utf8");
const releaseGeneration = readFileSync("commerce/src/release-generation.ts", "utf8");
const v2Writer = readFileSync("scripts/write-offline-bridge-receipt-v2.sh", "utf8");
const v2Reader = readFileSync("scripts/read-offline-bridge-receipt-v2.sh", "utf8");

describe("0041 terminal cleanup", () => {
  it("removes every dedicated bridge and recovery execution entrypoint", () => {
    for (const path of absent) expect(existsSync(path), path).toBe(false);
    expect(releaseControl).not.toContain("gen1PostActivationEmailToGen2Bridge");
    expect(releaseControl).not.toContain("bridgeGen1PostActivationEmailDefectToGen2");
  });

  it("retains immutable ledger replay semantics and reusable receipt-v2 substrate", () => {
    expect(releaseGeneration).toContain("POST_ACTIVATION_EMAIL_PROVIDER_DEFECT");
    expect(releaseGeneration).toContain("parsePostActivationEmailProviderDefectEvidence");
    expect(v2Writer).toContain("COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID");
    expect(v2Reader).toContain("COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID");
  });

  it("leaves a non-executable audit record and explicit post-merge operator checklist", () => {
    for (const document of [terminalCleanup, bridgeHistory, recoveryHistory]) {
      expect(document).toContain("HISTORICAL - DO NOT EXECUTE");
    }
    expect(bridgeHistory).toContain("68f80a411b7f286928ef10826ed225228098d246");
    expect(bridgeHistory).toContain("0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34");
    expect(bridgeHistory).toContain("d899d0a2ee1e1b618fe10403ca83aacf7018db93");
    expect(recoveryHistory).toContain("COMPLETE");
    expect(recoveryHistory).toContain("sequence `7`");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_SSH_PRIVATE_KEY");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_SSH_KNOWN_HOSTS");
    expect(terminalCleanup).toContain("/root/flexperiment-0041-tools/node");
    expect(terminalCleanup).toContain("emergency sales latch still `true`");
  });
});
