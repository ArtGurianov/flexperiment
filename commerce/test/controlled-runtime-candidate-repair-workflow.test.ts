import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repair = readFileSync(".github/workflows/controlled-runtime-candidate-repair.yml", "utf8");
const ordinary = readFileSync(".github/workflows/controlled-runtime-candidate-promotion.yml", "utf8");

/**
 * Repair moved out of the ordinary promotion controller after being used twice
 * in its first days. At that rate it is a production escape hatch, and an
 * escape hatch sharing an approval boundary with routine actions is one
 * mis-click from being routine itself.
 */
describe("break-glass runtime candidate repair workflow", () => {
  it("is named and gated as break glass, not as a lifecycle action", () => {
    expect(repair).toContain("name: BREAK GLASS - runtime candidate repair");
    // Its own environment, so approval can be required independently of the
    // ordinary production boundary.
    expect(repair).toContain("environment: production-break-glass");
    expect(ordinary).toContain("environment: production");
    expect(ordinary).not.toContain("production-break-glass");
    // Same serialization group: a repair must not run beside a cutover.
    expect(repair).toContain("group: flexperiment-production-controlled-cutover");
  });

  it("refuses to run on a healthy candidate", () => {
    expect(repair).toContain("RUNTIME_CANDIDATE_REPAIR_NOT_DIVERGED");
    expect(repair).toContain('if git merge-base --is-ancestor "$actual_production_deploy" "$actual_runtime_candidate"; then');
  });

  it("waives only the two current-candidate assertions", () => {
    // Still required: descent from production, published provenance, CAS lease.
    expect(repair).toContain('git merge-base --is-ancestor "$actual_production_deploy" "$INPUT_TARGET_SHA"');
    expect(repair).toContain("RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH");
    expect(repair.match(/git push --force-with-lease=/g)).toHaveLength(1);
    expect(repair).toContain("RUNTIME_CANDIDATE_CAS_MISMATCH");
    expect(repair).toContain("PRODUCTION_DEPLOY_CAS_MISMATCH");
    // Waived, because the current candidate is what is broken.
    expect(repair).not.toContain('git merge-base --is-ancestor "$actual_runtime_candidate" "$INPUT_TARGET_SHA"');
  });

  it("records a complete audit trail, and refuses without an incident reference", () => {
    expect(repair).toContain("incident_reference:");
    expect(repair).toContain("RUNTIME_CANDIDATE_REPAIR_INCIDENT_REFERENCE_INVALID");
    for (const field of ["$GITHUB_ACTOR", "$GITHUB_RUN_ID", "$INPUT_INCIDENT_REFERENCE", "$INPUT_REASON", "$INPUT_TARGET_SHA", "$ACTUAL_RUNTIME_CANDIDATE", "$ACTUAL_PRODUCTION_DEPLOY"]) {
      expect(repair, `audit summary must record ${field}`).toContain(field);
    }
  });

  it("never deploys or mutates release-control state", () => {
    for (const forbidden of ["release-control/", "COOLIFY", "production-deploy:refs/heads/production-deploy", "PRODUCTION_DEPLOY_REF_TOKEN"]) {
      expect(repair, `repair must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });
});
