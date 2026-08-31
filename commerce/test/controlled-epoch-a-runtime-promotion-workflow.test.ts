import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EPOCH_A_PRODUCTION_BASE_SHA, EPOCH_A_RUNTIME_SHA, EPOCH_A_RUNTIME_TAG_OBJECT, EPOCH_A_RUNTIME_TAG_REF } from "../src/epoch-a-runtime-promotion";

const workflow = readFileSync(".github/workflows/controlled-epoch-a-runtime-promotion.yml", "utf8");
const setter = readFileSync("scripts/set-production-deploy-ref.sh", "utf8");
const policy = readFileSync("commerce/src/epoch-a-runtime-promotion.ts", "utf8");
const at = (needle: string) => {
  const index = workflow.indexOf(needle);
  expect(index, `workflow contains ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe("controlled Epoch A dormant runtime promotion", () => {
  it("is a production-gated, manually dispatched, hard-bound compatibility controller", () => {
    const dispatch = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).toContain("options: [prepare, complete]");
    expect(dispatch).not.toContain("target_sha:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(`EPOCH_A_RUNTIME_SHA: ${EPOCH_A_RUNTIME_SHA}`);
    expect(workflow).toContain(`EPOCH_A_PRODUCTION_BASE_SHA: ${EPOCH_A_PRODUCTION_BASE_SHA}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_REF: ${EPOCH_A_RUNTIME_TAG_REF}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_OBJECT: ${EPOCH_A_RUNTIME_TAG_OBJECT}`);
    expect(workflow).toContain('[[ "$(git rev-parse "$EPOCH_A_RUNTIME_TAG_REF")" == "$EPOCH_A_RUNTIME_TAG_OBJECT" ]]');
    expect(workflow).toContain('[[ "$(git rev-parse "$EPOCH_A_RUNTIME_TAG_REF^{}")" == "$EPOCH_A_RUNTIME_SHA" ]]');
    expect(workflow).toContain('[[ "$(git rev-list --parents -n 1 "$EPOCH_A_RUNTIME_SHA" | awk \'NF == 2 {print $2}\')" == "$EPOCH_A_PRODUCTION_BASE_SHA" ]]');
    expect(workflow).toContain("EPOCH_A_CONTROLLER_CONTAMINATES_R");
    expect(workflow).toContain(".release/maintenance-only");
  });

  it("uses runtime-candidate only to admit a fresh acquire, never same-owner recovery", () => {
    const candidateChecks = workflow.match(/git fetch --no-tags origin refs\/heads\/runtime-candidate/g) ?? [];
    expect(candidateChecks).toHaveLength(2);
    expect(at("Prove fresh runtime-candidate declaration before acquire")).toBeLessThan(at("Reconfirm candidate immediately before acquire"));
    expect(at("Reconfirm candidate immediately before acquire")).toBeLessThan(at("Acquire owner and pause sales"));
    expect(workflow).toContain("EPOCH_A_FRESH_OWNER_POINTER_NOT_BASE");
  });

  it("never checks out or executes the candidate tree", () => {
    expect(workflow).not.toContain("git worktree add");
    expect(workflow).not.toContain("RUNTIME_ASSERT_DIR");
    expect(workflow).not.toContain("Materialize exact R readiness parser");
    expect(workflow).toContain("EPOCH_A_CONTROLLER_CAPABILITY_CLOSURE_MISMATCH");
  });

  it("keeps pre-B legal evidence and dormant capability as a separate compatibility proof", () => {
    expect(workflow).toContain("EPOCH_A_PRE_B_LEGAL_OR_DORMANCY_INVALID");
    expect(workflow).toContain("occurrence_notifications_available == false");
    expect(policy).toContain("EPOCH_A_FUTURE_LEGAL_RELEASE_ACTIVE");
    expect(workflow).toContain("assert-epoch-a-runtime-promotion-ready.ts");
    expect(workflow).toContain("EPOCH_A_R_CROSSES_SCHEMA_LEGAL_OR_SURFACE_BOUNDARY");
    expect(workflow).toContain("EPOCH_A_MIGRATION_0038_HASH_CHANGED");
    expect(workflow).toContain("EPOCH_A_R_LEGAL_SOURCE_BASELINE_MISMATCH");
    expect(workflow).toContain("EPOCH_A_R_LEGAL_SOURCE_CONVERGENCE_MISMATCH");
  });

  it("pauses before the CAS/deploy seam and never automatically reopens during prepare", () => {
    const acquire = at("Acquire owner and pause sales");
    const pause = at("Prove pause and independently unchanged emergency state");
    const cas = at("CAS production-deploy from Gen2 to exact R");
    const deploy = at("Enqueue exact R deployment");
    const convergence = at("Prove R convergence and dormant product evidence");
    const complete = at("Complete only after explicit GO and fresh dormant evidence");
    expect(acquire).toBeLessThan(pause);
    expect(pause).toBeLessThan(cas);
    expect(cas).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(convergence);
    expect(convergence).toBeLessThan(complete);
    expect(workflow).toContain("env.INPUT_STAGE == 'complete' && env.EPOCH_A_ACTION == 'READY_TO_COMPLETE'");
    expect(workflow).not.toContain("/v1/admin/emergency-sales/");
  });

  it("takes a full fresh compatibility snapshot before spending the pointer CAS", () => {
    const preCas = at("Reprove Epoch A compatibility authority immediately before CAS or R deployment");
    const cas = at("CAS production-deploy from Gen2 to exact R");
    expect(at("Prove pause and independently unchanged emergency state")).toBeLessThan(preCas);
    expect(preCas).toBeLessThan(cas);
    expect(workflow).toContain("EPOCH_A_PRE_CAS_DURABLE_AUTHORITY_MISMATCH");
    expect(workflow).toContain("EPOCH_A_PRE_CAS_LEGAL_OR_DORMANCY_INVALID");
    expect(workflow).toContain("EPOCH_A_PRE_DEPLOY_POINTER_UNEXPECTED");
    expect(workflow).toContain("EPOCH_A_PRE_CAS_RUNTIME_NOT_BASE");
    expect(workflow).toContain(".expected == ($request[0].expected | del(.legal_hashes))");
    expect(workflow).toContain("env.PRODUCTION_POINTER_PRE_CAS == env.EPOCH_A_PRODUCTION_BASE_SHA");
  });

  it("uses an expected-old-pointer CAS and has no rollback or old 0041 path", () => {
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$EPOCH_A_RUNTIME_SHA" "$EPOCH_A_PRODUCTION_BASE_SHA"');
    expect(setter).toContain('expected_previous_source_commit="${2:-}"');
    expect(setter).toContain("PRODUCTION_DEPLOY_EXPECTED_PREVIOUS_POINTER_MISMATCH");
    expect(workflow).not.toContain("controlled-0041");
    expect(workflow).not.toContain("classify_pre_activation_defect");
    expect(workflow).not.toContain("git push --force");
  });
});
