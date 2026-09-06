import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const recovery = readFileSync(".github/workflows/controlled-agent-referrals-stranded-rolling-recovery.yml", "utf8");
const terminal = readFileSync(".github/workflows/controlled-agent-referrals-recovery-complete.yml", "utf8");

describe("Agent Referrals Q3 recovery workflow contract", () => {
  it("uses the schema-valid full readiness envelope, never bare expectations", () => {
    expect(recovery).toContain('readiness-request.json');
    expect(recovery).toContain('{release_id:$id,mode:"ROLLING",expected:$expected[0]}');
    expect(recovery).toContain('--data-binary @readiness-request.json');
    expect(recovery).not.toContain('--data-binary @replacement-expected.json "$PUBLIC_API_URL/v1/internal/release-control/agent-referrals/dormant-readiness"');
  });

  it("reconstructs the exact certified Q3 before the guarded production CAS", () => {
    const reconstruct = recovery.indexOf("Reconstruct certified Q3 before any consequence");
    const cas = recovery.indexOf("Guarded Q2 to Q3 pointer transition");
    expect(reconstruct).toBeGreaterThan(-1);
    expect(cas).toBeGreaterThan(reconstruct);
    expect(recovery).toContain('controlled-candidate-verify.ts certificate.json "$GITHUB_SHA"');
    expect(recovery).toContain('"$(git rev-parse "$reconstructed^")" == "$FROZEN_OLD_TARGET"');
    expect(recovery).toContain('STRANDED_RECOVERY_MANIFEST_MISMATCH');
  });

  it("models Q2/Q3 durable recovery states and permits a post-CAS rerun", () => {
    for (const state of ["BEFORE_Q3_CAS", "POST_Q3_CAS_PRE_DEPLOY", "Q3_READY_PRE_SUPERSEDE", "OLD_RELEASE_SUPERSEDED"]) expect(recovery).toContain(state);
    expect(recovery).not.toContain('STRANDED_RECOVERY_PRODUCTION_NOT_Q2');
    expect(recovery).toContain("ALREADY_SUPERSEDED=true");
  });

  it("pins terminal release identity to Q3 and repeats full readiness after completion", () => {
    expect(terminal).toContain('"$INPUT_RELEASE_ID" == "agent-referrals-recovery-$REPLACEMENT_TARGET"');
    expect(terminal).toContain("terminal-readiness.json");
    expect(terminal).toContain('.owner_release_id == null and .owner_mode == null and .sales_paused == false');
  });
});
