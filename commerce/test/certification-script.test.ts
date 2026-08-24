import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const certificationScript = resolve(repositoryRoot, "certification.sh");

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
    expect(source).toContain('if [[ "$MODE" == cleanup ]]; then close_and_hide');
    expect(source).not.toContain('source "$STATE_FILE"');
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
