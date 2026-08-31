import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-0041-gen2-email-recovery.yml", "utf8");
const retiredBridge = readFileSync("scripts/controlled-0041-offline-bridge.sh", "utf8");
const v1Reader = readFileSync("scripts/read-0041-offline-bridge-receipt-from-pinned-volume.sh", "utf8");
const v2Writer = readFileSync("scripts/write-offline-bridge-receipt-v2.sh", "utf8");
const v2Reader = readFileSync("scripts/read-offline-bridge-receipt-v2.sh", "utf8");
const terminalCleanup = readFileSync("docs/release/0041_TERMINAL_CLEANUP.md", "utf8");
const all0041Workflows = readdirSync(".github/workflows")
  .filter((name) => name.includes("0041"))
  .map((name) => readFileSync(`.github/workflows/${name}`, "utf8"));

describe("0041 post-bridge Gen2 email recovery controller", () => {
  it("hard-binds the spent epoch to exact Gen2 rather than controller ancestry", () => {
    expect(workflow).toContain("68f80a411b7f286928ef10826ed225228098d246");
    expect(workflow).toContain("0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34");
    expect(workflow).toContain("outbox-attempt-authority-v1:68f80a411b7f286928ef10826ed225228098d246");
    expect(workflow).toContain("EXPECTED_GENERATION: '2'");
    expect(workflow).toContain('git rev-parse "$GEN2_RUNTIME_SHA^"');
    expect(workflow).not.toContain('git merge-base --is-ancestor "$GEN2_RUNTIME_SHA" "$CONTROLLER_SHA"');
    expect(workflow).toContain("0041_GEN2_EMAIL_RECOVERY_PRODUCTION_DEPLOY_NOT_GEN2");
    expect(workflow).toContain("PUBLIC_API_URL: ${{ vars.PUBLIC_API_URL }}");
    expect(workflow).not.toContain("PUBLIC_API_URL: ${{ secrets.PUBLIC_API_URL }}");
    expect(workflow).toContain(".runtime.source_commit == $source");
    expect(workflow).toContain(".runtime.worker_source_commit == $source");
  });

  it("keeps fresh certification fenced and exact-order bound", () => {
    const prepare = workflow.indexOf("Prepare a fresh Gen2 certification lease");
    const certify = workflow.indexOf("Record fresh Gen2 certification evidence");
    const unfence = workflow.indexOf("Unfence only a certified Gen2 order");
    expect(prepare).toBeGreaterThan(0);
    expect(certify).toBeGreaterThan(prepare);
    expect(unfence).toBeGreaterThan(certify);
    expect(workflow).toContain('from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/certification/activate"');
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/certification/certify"');
    expect(workflow).toContain(".outbox_authority.email_dispatch_paused == true");
    expect(workflow).toContain(".queued_unstarted == true and .target_defect == null");
    expect(workflow).toContain(".order_id == $order_id");
    expect(workflow).not.toContain("/candidates/certification/retry");
  });

  it("unfences only with an exact CAS and requires accepted dispatch after its durable boundary", () => {
    const unfence = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/outbox-dispatch/unfence"');
    const proof = workflow.indexOf(".dispatched_after_unfence == true", unfence);
    expect(unfence).toBeGreaterThan(0);
    expect(proof).toBeGreaterThan(unfence);
    expect(workflow).toContain("expected_revision: 7");
    expect(workflow).toContain('jq -e --arg release_id "$RELEASE_ID" \'.emergency_sales_paused == false and .outbox_authority.email_dispatch_paused == true and .outbox_authority.dispatch_owner_release_id == $release_id and .outbox_authority.revision == 7 and .outbox_authority.dispatch.drained == true\' status.json');
    expect(workflow).toContain(".revision == 8");
    expect(workflow).toContain(".attempts.defects | to_entries | map(.value == 0) | all");
    expect(workflow).toContain("0041_GEN2_EMAIL_RECOVERY_DISPATCH_NOT_ACCEPTED_AFTER_UNFENCE");
  });

  it("contains a failed or unresolved unfence without mutating its evidence", () => {
    const contain = workflow.indexOf("Re-fence an unsuccessful Gen2 certification dispatch");
    const fence = workflow.indexOf('"$PUBLIC_API_URL/v1/internal/release-control/outbox-dispatch/fence"', contain);
    expect(contain).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(contain);
    expect(workflow).toContain(".dispatched_after_unfence != true");
    expect(workflow).toContain("expected_revision: 8");
    expect(workflow).toContain(".revision == 9");
    expect(workflow).toContain(".dispatch.drained == true");
    expect(workflow).not.toContain("post-activation-email-provider-defect");
    expect(workflow).not.toContain("classify_pre_activation_defect");
  });

  it("makes complete a separately guarded future boundary", () => {
    const complete = workflow.indexOf("Complete only after a separate GO");
    expect(complete).toBeGreaterThan(0);
    expect(workflow).toContain(".emergency_sales_paused == true");
    expect(workflow).toContain(".email_dispatch_paused == false");
    expect(workflow).toContain("0041_GEN2_EMAIL_RECOVERY_COMPLETE_DISPATCH_PROOF_MISSING");
    expect(workflow).toContain('"$PUBLIC_API_URL/v1/internal/release-control/candidates/complete"');
    expect(workflow).toContain('echo "GEN2_EMAIL_RECOVERY_COMPLETE_REPLAY=1" >> "$GITHUB_ENV"');
    expect(workflow).toContain("if: env.INPUT_STAGE == 'complete' && env.GEN2_EMAIL_RECOVERY_COMPLETE_REPLAY != '1'");
    expect(workflow).toContain('.head.phase == "COMPLETE" and .head.candidate_generation == $generation and .head.source_commit == $source');
    expect(workflow.indexOf("GEN2_EMAIL_RECOVERY_COMPLETE_REPLAY=1")).toBeLessThan(complete);
  });

  it("binds every jq release-id predicate to the controller release id", () => {
    for (const line of workflow.split("\n").filter((candidate) => candidate.includes("jq") && candidate.includes("$release_id"))) {
      expect(line).toContain('--arg release_id "$RELEASE_ID"');
    }
  });

  it("cannot deploy, restart, bridge, or mutate the original failed attempt", () => {
    expect(workflow).not.toContain("controlled-coolify-deploy.sh");
    expect(workflow).not.toContain("docker ");
    expect(workflow).not.toContain("gen1-to-gen2-post-activation-email-bridge.ts");
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("outbox_attempt SET");
    expect(workflow).not.toContain("workflow_call");
  });
});

describe("offline bridge receipt retirement and v2 substrate", () => {
  it("keeps historical v1 evidence readable without changing it", () => {
    expect(v1Reader).toContain('readonly DATABASE_VOLUME_NAME="jmawd0cmudtiwtquptyvhm0l_commerce-data"');
    expect(v1Reader).toContain('"$(field schema_version)" == 1');
    expect(v1Reader).toContain("0041_OFFLINE_BRIDGE_RECEIPT_VALID");
    expect(v1Reader).not.toContain("docker volume ls");
  });

  it("writes schema v2 with durable storage identity only after exact substrate inspection", () => {
    expect(v2Writer).toContain("COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID");
    expect(v2Writer).toContain('readonly RECEIPT_NAME=".offline-bridge-${receipt_id}.receipt"');
    expect(v2Writer).toContain('[[ "$receipt_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ && "$receipt_id" != *..* && "$receipt_id" != */* ]]');
    expect(v2Writer).toContain('"schema_version", "2"');
    expect(v2Writer).toContain('["bridge_receipt_id", process.env.receipt_id]');
    expect(v2Writer).toContain('"database_storage_kind", "docker_volume"');
    expect(v2Writer).toContain('"database_volume_name", process.env.volume_name');
    expect(v2Writer).toContain('"database_destination", process.env.database_destination');
    expect(v2Writer).toContain("docker volume inspect");
    expect(v2Writer).toContain("OFFLINE_BRIDGE_RECEIPT_V2_SUBSTRATE_MISMATCH");
    expect(v2Writer).not.toContain("docker volume ls");
  });

  it("reads v2 from its receipt-bound exact volume without original containers", () => {
    expect(v2Reader).toContain("COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID");
    expect(v2Reader).toContain('readonly RECEIPT_NAME=".offline-bridge-${receipt_id}.receipt"');
    expect(v2Reader).toContain('"$(field bridge_receipt_id)" == "$receipt_id"');
    expect(v2Reader).toContain("docker volume inspect");
    expect(v2Reader).toContain('"$(field schema_version)" == 2');
    expect(v2Reader).toContain('"$(field database_volume_name)" == "$expected_volume_name"');
    expect(v2Reader).toContain('"$mounted_name" != "$expected_volume_name"');
    expect(v2Reader).toContain('"$mounted_source" != "$database_directory"');
    expect(v2Reader).toContain("OFFLINE_BRIDGE_RECEIPT_V2_LIVE_MOUNT");
    expect(v2Reader).toContain("OFFLINE_BRIDGE_RECEIPT_V2_VOLUME_NOT_EXACT");
    expect(v2Reader).toContain('COMMERCE_DATABASE_PATH="$database_directory/commerce.sqlite"');
    expect(v2Reader).not.toContain("docker ps --all");
    expect(v2Reader).not.toContain("docker volume ls");
    expect(v2Reader).not.toContain("docker run");
  });

  it("keeps v2 receipt creation idempotent per bridge identity while allowing distinct identities", () => {
    expect(v2Writer).toContain('openSync(receiptPath, "wx", 0o600)');
    expect(v2Writer).toContain('readFileSync(receiptPath, "utf8") !== receipt');
    expect(v2Writer).toContain('join(process.env.database_directory, process.env.RECEIPT_NAME)');
    expect(v2Reader).not.toContain("readdir");
    expect(v2Reader).not.toContain("find ");
  });

  it("retires spent mutation/deploy entrypoints but preserves read-only evidence until COMPLETE", () => {
    expect(retiredBridge).toContain("0041_OFFLINE_BRIDGE_RETIRED_AFTER_GEN2_DEPLOYMENT");
    expect(retiredBridge).not.toContain("docker update");
    expect(retiredBridge).not.toContain("docker stop");
    expect(retiredBridge).not.toContain("gen1-to-gen2-post-activation-email-bridge.ts");
    expect(existsSync(".github/workflows/controlled-0041-gen2-deploy-only-recovery.yml")).toBe(false);
    expect(all0041Workflows).toHaveLength(1);
    expect(all0041Workflows[0]).not.toContain("controlled-coolify-deploy.sh");
    expect(all0041Workflows[0]).not.toContain("docker start");
    expect(all0041Workflows[0]).not.toContain("docker restart");
    expect(all0041Workflows[0]).not.toContain("gen1-to-gen2-post-activation-email-bridge.ts");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_SSH_PRIVATE_KEY");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_SSH_KNOWN_HOSTS");
    expect(terminalCleanup).toContain("GEN1_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA");
    expect(terminalCleanup).toContain("/root/flexperiment-0041-tools/node");
    expect(terminalCleanup).toContain("HISTORICAL — DO NOT EXECUTE");
    expect(terminalCleanup).toContain("Remove the accidental inherited `.release/maintenance-only` marker from");
    expect(terminalCleanup).toContain("d899d0a2ee1e1b618fe10403ca83aacf7018db93");
  });
});
