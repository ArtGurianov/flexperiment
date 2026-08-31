import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EPOCH_A_PRODUCTION_BASE_SHA, EPOCH_A_RUNTIME_SHA, EPOCH_A_RUNTIME_TAG_OBJECT, EPOCH_A_RUNTIME_TAG_REF } from "../src/epoch-a-runtime-promotion";

const workflow = readFileSync(".github/workflows/verify-epoch-a-prepare-preflight.yml", "utf8");

describe("Epoch A prepare preflight verifier", () => {
  it("is manually dispatched, production-approved, and read-only by GitHub permission", () => {
    const dispatch = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).not.toContain("inputs:");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("COMMERCE_RELEASE_CONTROL_TOKEN: ${{ secrets.COMMERCE_RELEASE_CONTROL_TOKEN }}");
    expect(workflow).not.toContain("PRODUCTION_DEPLOY_REF_TOKEN");
    expect(workflow).not.toContain("COOLIFY_");
  });

  it("hard-binds the controller, protected R tag, candidate, and still-deployed Gen2", () => {
    expect(workflow).toContain(`EPOCH_A_RUNTIME_SHA: ${EPOCH_A_RUNTIME_SHA}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_REF: ${EPOCH_A_RUNTIME_TAG_REF}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_OBJECT: ${EPOCH_A_RUNTIME_TAG_OBJECT}`);
    expect(workflow).toContain('EPOCH_A_RUNTIME_TAG_RULESET_ID: "21915288"');
    expect(workflow).toContain(`EPOCH_A_PRODUCTION_BASE_SHA: ${EPOCH_A_PRODUCTION_BASE_SHA}`);
    expect(workflow).toContain('[[ "$CONTROLLER_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(workflow).toContain('[[ "$(git rev-parse origin/runtime-candidate)" == "$EPOCH_A_RUNTIME_SHA" ]]');
    expect(workflow).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$EPOCH_A_PRODUCTION_BASE_SHA" ]]');
    expect(workflow).toContain('[[ "$(git rev-parse "$EPOCH_A_RUNTIME_TAG_REF^{}")" == "$EPOCH_A_RUNTIME_SHA" ]]');
    expect(workflow).toContain("RUNTIME_CANDIDATE_NOT_R");
    expect(workflow).toContain("PRODUCTION_DEPLOY_NOT_GEN2");
    expect(workflow).toContain("RUNTIME_TAG_PROTECTION_MISMATCH");
    expect(workflow).not.toContain(".bypass_actors == []");
    expect(workflow).toContain("GitHub omits bypass_actors");
  });

  it("requires authenticated durable replay/projection, legal, authority, inventory, and Gen2 convergence evidence", () => {
    expect(workflow).toContain('api "$PUBLIC_API_URL/v1/internal/release-control/status" > status.json');
    expect(workflow).toContain('api "$PUBLIC_API_URL/v1/admin/release-control/candidates/head" > candidate-head.json');
    expect(workflow).toContain('api "$PUBLIC_API_URL/v1/public/legal-config" > legal-config.json');
    expect(workflow).toContain("canonicalMigrationInventory(versions)");
    expect(workflow).toContain('EPOCH_A_MIGRATION_COUNT: "41"');
    expect(workflow).toContain("EPOCH_A_0038_SHA256");
    expect(workflow).toContain(".runtime.migration_source_hashes == $hashes");
    expect(workflow).toContain(".head.phase == \"COMPLETE\" and .head.phase_sequence == 7");
    expect(workflow).toContain(".outbox_authority.attempt_authority == \"ATTEMPT\"");
    expect(workflow).toContain(".outbox_authority.email_dispatch_paused == false");
    expect(workflow).toContain("occurrence_notifications_available == false");
    expect(workflow).toContain("EPOCH_A_PREPARE_EMERGENCY_SALES_PAUSED");
    expect(workflow).toContain("EPOCH_A_PREPARE_READY");
    expect(workflow).toContain("EPOCH_A_PREPARE_BLOCKED:");
  });

  it("has no durable mutation, deploy, or authority-changing path", () => {
    for (const forbidden of [
      "api -X POST", "api -X PUT", "api -X PATCH", "api -X DELETE", "curl -X POST", "curl -X PUT", "curl -X PATCH", "curl -X DELETE",
      "set-production-deploy-ref.sh", "git push", "controlled-coolify-deploy", "/acquire", "/pause", "/reopen", "/legal-publish",
      "emergency-sales", "controlled-runtime-candidate-promotion", "git worktree add", "RUNTIME_ASSERT_DIR",
    ]) expect(workflow).not.toContain(forbidden);
  });
});
