import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const certificationScript = resolve(repositoryRoot, "certification.sh");
const recoveryPlanner = resolve(repositoryRoot, "scripts/certification-recovery.sh");

function plan(mode: string, phase: string, pendingOperation: string, baseline: string, salesCleanedAt = "") {
  return execFileSync("bash", ["-lc", `source '${recoveryPlanner}'; certification_recovery_action '${mode}' '${phase}' '${pendingOperation}' '${baseline}' '${salesCleanedAt}'`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function pendingOperationPhaseIsValid(operation: string, phase: string) {
  try {
    execFileSync("bash", ["-lc", `source '${recoveryPlanner}'; certification_pending_operation_phase_valid '${operation}' '${phase}'`], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function helperSucceeds(name: string, ...args: string[]) {
  try {
    execFileSync("bash", ["-lc", `source ${JSON.stringify(recoveryPlanner)}; ${name} ${args.map((argument) => JSON.stringify(argument)).join(" ")}`], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

describe("production certification runbook checkpoints", () => {
  it("keeps the pre-dispatch checkout identity and distinct crash checkpoints", () => {
    const source = readFileSync(certificationScript, "utf8");
    const occurrenceCreated = source.indexOf('if [[ "$PHASE" == OCCURRENCE_CREATED ]]');
    const occurrencePublished = source.indexOf('if [[ "$PHASE" == OCCURRENCE_PUBLISHED ]]');
    const occurrenceOpen = source.indexOf('if [[ "$PHASE" == OCCURRENCE_OPEN ]]');
    const quoteReady = source.indexOf('if [[ "$PHASE" == QUOTE_READY ]]');
    const checkoutSubmitting = source.indexOf('if [[ "$PHASE" == CHECKOUT_SUBMITTING ]]');
    const checkoutCreated = source.indexOf('if [[ "$PHASE" == CHECKOUT_CREATED');

    expect(source).toContain("QUOTE_READY CHECKOUT_SUBMITTING CHECKOUT_CREATED");
    expect(source).toContain("CHECKOUT_REQUEST_SHA256");
    expect(source).toContain("OCCURRENCE_CREATED OCCURRENCE_PUBLISHED OCCURRENCE_OPEN");
    expect(source).toContain("certification_recovery_action");
    expect(occurrenceCreated).toBeGreaterThan(-1);
    expect(occurrenceCreated).toBeLessThan(occurrencePublished);
    expect(occurrencePublished).toBeLessThan(occurrenceOpen);
    expect(source.slice(occurrenceCreated, occurrencePublished)).toContain("refresh_occurrence");
    expect(source.slice(occurrencePublished, occurrenceOpen)).toContain("refresh_occurrence");
    expect(quoteReady).toBeLessThan(checkoutSubmitting);
    expect(checkoutSubmitting).toBeLessThan(checkoutCreated);
    expect(source.slice(checkoutSubmitting, checkoutCreated)).toContain("replay_checkout");
    expect(source).toContain("recover_existing_checkout");
    expect(source).toContain("Opening existing real payment URL without printing it.");
    expect([...source.matchAll(/\/v1\/public\/checkout-context/g)]).toHaveLength(1);
    expect(source).toContain("assert_cleanup_evidence");
    expect(source).toContain("assert_occurrence_availability 0");
    expect(source).toContain("assert_occurrence_availability 1");
    expect(source).toContain("assert_final_refund_evidence");
    expect(source).toContain("assert_final_email_evidence");
    expect(source).toContain("assert_certification_order_identity");
    expect(source).toContain("customer_adult_confirmed_at");
    expect(source).toContain("certification_pending_operation_phase_valid");
    expect(source).toContain("SALES_CLEANUP_STARTED_AT");
    expect(source).toContain("HUMAN_TICKET_VERIFIED_AT");
    expect(source).toContain("SALES_CLEANED_AT");
    expect(source).toContain("stat.S_IMODE");
    expect(source).not.toContain('source "$STATE_FILE"');
    expect(source).not.toContain('SALES_CLEANUP_STARTED_AT=""');
  });

  it("plans a monotonic emergency cleanup while retaining only post-dispatch financial recovery", () => {
    expect(plan("run", "NEW", "CREATE_OCCURRENCE", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "OCCURRENCE_CREATED", "PUBLISH_OCCURRENCE", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "CHECKOUT_SUBMITTING", "", "VERIFIED")).toBe("CONTINUE");
    expect(plan("run", "CHECKOUT_CREATED", "", "VERIFIED")).toBe("CONTINUE");
    expect(plan("run", "REFUND_EMAIL_DELIVERED", "", "VERIFIED")).toBe("CLEAN_OCCURRENCE");
    expect(plan("run", "OCCURRENCE_CLEANED", "", "VERIFIED")).toBe("WRITE_MANIFEST");
    expect(plan("run", "COMPLETE", "", "VERIFIED")).toBe("REPORT_COMPLETE");
    expect(plan("cleanup", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED")).toBe("CLEANUP_ONLY");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "OCCURRENCE_CREATED", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "PUBLISH_OCCURRENCE", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "OCCURRENCE_CREATED", "CREATE_OCCURRENCE", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "NEW", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CLEANUP_REQUIRED");
    expect(plan("run", "CHECKOUT_CREATED", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CONTINUE");
    expect(plan("run", "CHECKOUT_SUBMITTING", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CONTINUE");
    expect(plan("run", "PAYMENT_PROVEN", "", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("CONTINUE");
    expect(plan("run", "OCCURRENCE_CREATED", "PUBLISH_OCCURRENCE", "MISMATCH")).toBe("BLOCKED_BASELINE");
  });

  it("accepts only the phase-bound allowlist for a pending mutation", () => {
    expect(pendingOperationPhaseIsValid("CREATE_OCCURRENCE", "NEW")).toBe(true);
    expect(pendingOperationPhaseIsValid("PUBLISH_OCCURRENCE", "OCCURRENCE_CREATED")).toBe(true);
    expect(pendingOperationPhaseIsValid("OPEN_SALES", "OCCURRENCE_PUBLISHED")).toBe(true);
    expect(pendingOperationPhaseIsValid("CANCEL_BOOKING", "TICKET_EMAIL_DELIVERED")).toBe(true);
    expect(pendingOperationPhaseIsValid("CANCEL_BOOKING", "NEW")).toBe(false);
    expect(pendingOperationPhaseIsValid("OPEN_SALES", "OCCURRENCE_CREATED")).toBe(false);
    expect(pendingOperationPhaseIsValid("PUBLISH_OCCURRENCE", "OCCURRENCE_PUBLISHED")).toBe(false);
  });

  it("rejects mismatched cleanup targets and order bindings before destructive commands", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-certification-evidence-"));
    const occurrence = resolve(directory, "occurrence.json");
    const evidence = resolve(directory, "evidence.json");
    try {
      writeFileSync(occurrence, JSON.stringify({ city_slug: "kemerovo", title: "FLEXPERIMENT — Кемерово — production E2E test-run", timezone: "Asia/Novokuznetsk", price_kopecks: 100, capacity: 1 }));
      expect(helperSucceeds("certification_occurrence_identity_valid", occurrence, "kemerovo", "FLEXPERIMENT — Кемерово — production E2E test-run")).toBe(true);
      expect(helperSucceeds("certification_occurrence_identity_valid", occurrence, "kemerovo", "FLEXPERIMENT — Кемерово — production E2E another-run")).toBe(false);

      writeFileSync(evidence, JSON.stringify({
        order: { id: "order", public_status_id: "status", occurrence_id: "occurrence", amount_kopecks: 100, currency: "RUB" },
        payment: { id: "payment" }, booking: { id: "booking" }, ticket: { id: "ticket" },
      }));
      expect(helperSucceeds("certification_order_identity_valid", evidence, "order", "status", "occurrence", "payment", "booking", "ticket")).toBe(true);
      expect(helperSucceeds("certification_order_identity_valid", evidence, "other-order", "status", "occurrence", "payment", "booking", "ticket")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires one final delivered email with non-contradictory provider evidence", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-certification-email-"));
    const evidence = resolve(directory, "email-evidence.json");
    const writeEvidence = (outbox: unknown[], events: unknown[]) => writeFileSync(evidence, JSON.stringify({ email_outbox: outbox, email_provider_events: events }));
    const outbox = { id: "mail", type: "TICKET", payload_ref: "ticket", status: "DELIVERED", job_id: "job" };
    const delivered = { outbox_id: "mail", status: "DELIVERED", provider_status: "delivered", job_id: "job" };
    try {
      writeEvidence([outbox], [delivered]);
      expect(helperSucceeds("certification_email_evidence_row", evidence, "TICKET", "ticket")).toBe(true);

      writeEvidence([outbox, { ...outbox, id: "mail-duplicate" }], [delivered]);
      expect(helperSucceeds("certification_email_evidence_row", evidence, "TICKET", "ticket")).toBe(false);

      writeEvidence([outbox], [delivered, { outbox_id: "mail", status: "BOUNCED", provider_status: "soft_bounced", job_id: "job" }]);
      expect(helperSucceeds("certification_email_evidence_row", evidence, "TICKET", "ticket")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary resume file without executing its contents", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-certification-state-"));
    const state = resolve(directory, "malicious.json");
    const marker = resolve(directory, "must-not-exist");
    try {
      writeFileSync(state, JSON.stringify({
        RUN_ID: "test-run",
        PHASE: "NEW",
        EXPECTED_SOURCE_COMMIT: "test-commit",
        EVIL: `$(touch ${marker})`,
      }));
      chmodSync(state, 0o600);

      let failure: unknown;
      try {
        execFileSync("bash", [certificationScript, "--resume", state], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect((failure as { stderr: string }).stderr).toContain("resume state is not a valid allowlisted JSON object");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a phase-incompatible persisted command before admin login or mutation", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-certification-state-"));
    const state = resolve(directory, "phase-mismatch.json");
    try {
      writeFileSync(state, JSON.stringify({
        RUN_ID: "test-run",
        PHASE: "NEW",
        EXPECTED_SOURCE_COMMIT: "test-commit",
        PENDING_OPERATION: "CANCEL_BOOKING",
        ORDER_ID: "order-id",
        BOOKING_ID: "booking-id",
        CANCEL_BOOKING_KEY: "key",
      }));
      chmodSync(state, 0o600);

      let failure: unknown;
      try {
        execFileSync("bash", [certificationScript, "--resume", state], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect((failure as { stderr: string }).stderr).toContain("pending operation is not valid for the persisted certification phase");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
