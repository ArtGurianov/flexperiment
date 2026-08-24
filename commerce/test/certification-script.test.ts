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
    expect(source.slice(checkoutCreated, source.indexOf("wait_checkout_paid"))).toContain("replay_checkout");
    expect([...source.matchAll(/\/v1\/public\/checkout-context/g)]).toHaveLength(1);
    expect(source).toContain("# Emergency cleanup never replays a pending OPEN/create/cancellation command.");
    expect(source).toContain("SALES_CLEANED_AT");
    expect(source).not.toContain('source "$STATE_FILE"');
  });

  it("plans recovery behavior without replaying stale commands or losing workflow phase", () => {
    expect(plan("run", "NEW", "CREATE_OCCURRENCE", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "OCCURRENCE_CREATED", "PUBLISH_OCCURRENCE", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED")).toBe("REPLAY_PENDING");
    expect(plan("run", "CHECKOUT_SUBMITTING", "", "VERIFIED")).toBe("CONTINUE");
    expect(plan("run", "CHECKOUT_CREATED", "", "VERIFIED")).toBe("CONTINUE");
    expect(plan("run", "REFUND_EMAIL_DELIVERED", "", "VERIFIED")).toBe("CLEAN_OCCURRENCE");
    expect(plan("run", "OCCURRENCE_CLEANED", "", "VERIFIED")).toBe("WRITE_MANIFEST");
    expect(plan("run", "COMPLETE", "", "VERIFIED")).toBe("REPORT_COMPLETE");
    expect(plan("cleanup", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED")).toBe("CLEANUP_ONLY");
    expect(plan("run", "OCCURRENCE_PUBLISHED", "OPEN_SALES", "VERIFIED", "2026-08-24T00:00:00Z")).toBe("BLOCKED_AFTER_EMERGENCY_CLEANUP");
    expect(plan("run", "OCCURRENCE_CREATED", "PUBLISH_OCCURRENCE", "MISMATCH")).toBe("BLOCKED_BASELINE");
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
});
