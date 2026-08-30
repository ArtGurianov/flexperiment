import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/controlled-email-delivery-outcome-cutover.yml", "utf8");
const at = (needle: string) => workflow.indexOf(needle);

/**
 * The controller for migration 0039.
 *
 * Its ordering is safety-critical in both directions, which is unusual and easy
 * to get backwards:
 *
 *   latch OFF before certify    certification places a real 1-RUB order and the
 *                               emergency gate is absolute, so a latch set too
 *                               early fails the payment, not the workflow
 *   latch ON  before complete   completeCandidate clears the release gate, so
 *                               without the latch sales open before the new
 *                               durable semantics have been inspected
 */
describe("controlled email delivery-outcome cutover", () => {
  it("runs from the production environment on the shared cutover concurrency group", () => {
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
  });

  it("admits abort at the stage validator, not merely in the options list", () => {
    // The seam. `options:` and a real abort stage both existed while the first
    // dispatcher rejected the value, so selecting abort exited immediately with
    // STAGE_INVALID - an exit path that looked present and was unreachable.
    const validator = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("STAGE_INVALID"));
    expect(validator).toHaveLength(1);
    expect(validator[0], "the stage validator rejects abort").toContain('"$INPUT_STAGE" == abort');
    for (const stage of ["prepare", "certify", "classify_runtime_readiness_defect", "complete"]) {
      expect(validator[0]).toContain(`"$INPUT_STAGE" == ${stage}`);
    }
  });

  it("offers an abort, which is the exit the 12h09m pause did not have", () => {
    expect(workflow).toContain("options: [prepare, certify, classify_runtime_readiness_defect, abort, complete]");
    expect(workflow).toContain("/v1/internal/release-control/candidates/abort");
  });

  it("presents a CAS token when aborting rather than deciding reversibility itself", () => {
    // release-control owns that decision: certified, production moved, or
    // migration state changed each refuse with their own code.
    const abort = workflow.slice(at("Abort a still-reversible candidate"), at("Complete only a certified authoritative candidate"));
    expect(abort).toContain("expected_state_hash: $current[0].state_hash");
    expect(abort).toContain("ABORT_REPLAY=already-aborted");
  });

  describe("emergency latch ordering", () => {
    it("reconfirms the latch is clear at certify", () => {
      const certify = workflow.slice(at("Reconfirm the emergency stop is still clear"), at("Activate or reconcile the certification lease"));
      expect(certify).toContain(".emergency_sales_paused == false");
      expect(certify).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_LATCH_BLOCKS_CERTIFICATION");
    });

    it("requires the latch to be set before completing", () => {
      const complete = workflow.slice(at("Complete only a certified authoritative candidate"));
      expect(complete).toContain(".emergency_sales_paused == true");
      expect(complete).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_LATCH_REQUIRED_BEFORE_COMPLETE");
    });

    it("checks the latch before it completes, not after", () => {
      const complete = workflow.slice(at("Complete only a certified authoritative candidate"));
      const gate = complete.indexOf("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_LATCH_REQUIRED_BEFORE_COMPLETE");
      const post = complete.indexOf("/v1/internal/release-control/candidates/complete");
      expect(gate).toBeGreaterThan(-1);
      expect(post).toBeGreaterThan(gate);
    });

    it("proves the capability exists and the stop is clear, while abort is still available", () => {
      const handshake = workflow.slice(at("Prove the emergency stop capability exists and is clear"), at("Classify an explicitly evidenced deployed runtime-readiness defect"));
      expect(handshake).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_CAPABILITY_MISSING_AFTER_DEPLOY");
      expect(handshake).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_LATCH_SET_TOO_EARLY");
      // Existence is asserted separately: an absent field must never read as
      // false, and the currently deployed runtime genuinely lacks it.
      expect(handshake).toContain(`has("emergency_sales_paused")`);
      expect(handshake).toContain(".emergency_sales_paused == false");
      // Runs at prepare, so a failure lands at DEPLOYED_READ_ONLY.
      expect(handshake).toContain("env.INPUT_STAGE == 'prepare'");
    });

    it("orders the certify gate before the complete gate", () => {
      expect(at("Reconfirm the emergency stop is still clear"))
        .toBeLessThan(at("Complete only a certified authoritative candidate"));
    });

    it("never latches or clears the gate itself", () => {
      // Latching is an admin operation. A release controller holding admin
      // credentials could also refund, cancel and mutate - far wider authority
      // than driving a release needs, and the exact conflation this programme
      // has spent its time removing.
      expect(workflow).not.toContain("/v1/admin/emergency-sales/pause");
      expect(workflow).not.toContain("/v1/admin/emergency-sales/reopen");
    });

    it("fails closed when the latch cannot be observed at all", () => {
      // An older runtime without the field would make every latch check read as
      // absent rather than false, which must not silently pass.
      const observability = workflow.split("EMAIL_DELIVERY_OUTCOME_CUTOVER_EMERGENCY_STATE_NOT_OBSERVABLE").length - 1;
      expect(observability).toBeGreaterThanOrEqual(2);
    });

    it("treats both latch states as healthy when replaying a completed generation", () => {
      // A crash between COMPLETE and unlatching must resolve to "closed,
      // awaiting verification" - not to corrupt release state, and not to an
      // automatic reopen.
      const complete = workflow.slice(at("Complete only a certified authoritative candidate"));
      expect(complete).toContain("COMPLETE_REPLAY_EMERGENCY_LATCH=$latched");
    });
  });

  describe("candidate binding", () => {
    it("requires 0039 in the candidate's own migration inventory", () => {
      expect(workflow).toContain(`has("0039_email_delivery_outcome.sql")`);
      expect(workflow).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_MIGRATION_0039_MISSING");
    });

    it("derives the expectation from the candidate, never a filename allowlist", () => {
      // The inventory form is the durable authority now, proven in production.
      // Reintroducing per-migration filename knowledge would walk that back.
      expect(workflow).not.toContain("0039_email_delivery_outcome.sql\": [");
      expect(workflow).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_MIGRATION_BASELINE_MISSING");
    });

    it("verifies the applied migration against the candidate's own hash", () => {
      expect(workflow).toContain(`.runtime.migration_versions | index("0039_email_delivery_outcome.sql")`);
      expect(workflow).toContain(`.runtime.migration_source_hashes["0039_email_delivery_outcome.sql"]`);
    });

    it("pins an authority head that already contains the migration", () => {
      expect(workflow).toContain("AUTHORITY_HEAD_MIN_SHA=fd09fa5881de1e4bb7ba399a998e4797804061f5");
    });

    it("refuses to let a schema cutover move legal state", () => {
      expect(workflow).toContain("EMAIL_DELIVERY_OUTCOME_CUTOVER_ACTIVE_MANIFEST_ALREADY_PROMOTED");
    });
  });

  it("proves the pause before it deploys", () => {
    expect(at("Prove public checkout is paused before candidate deployment"))
      .toBeLessThan(at("Deploy the exact paused generation"));
  });
});
