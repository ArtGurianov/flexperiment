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
    expect(recovery).toContain('BASE_SHA="$FROZEN_OLD_TARGET"');
    expect(recovery).toContain('TARGET_SHA="$REPLACEMENT_TARGET"');
    expect(recovery).toContain('agent-referrals-recovery-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(recovery).toContain('SOURCE_MAIN_SHA="$(jq -er \'.source_main_sha\' candidate-certificate.json)"');
    expect(recovery).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(recovery).toContain('controlled-candidate-verify.ts candidate-certificate.json "$GITHUB_SHA"');
    expect(recovery).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(recovery).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^")" == "$BASE_SHA"');
    expect(recovery).toContain('STRANDED_RECOVERY_MANIFEST_MISMATCH');
  });

  it("models Q2/Q3 durable recovery states and permits a post-CAS rerun", () => {
    for (const state of ["BEFORE_Q3_CAS", "POST_Q3_CAS_PRE_DEPLOY", "Q3_READY_PRE_SUPERSEDE", "OLD_RELEASE_SUPERSEDED"]) expect(recovery).toContain(state);
    expect(recovery).not.toContain('STRANDED_RECOVERY_PRODUCTION_NOT_Q2');
    expect(recovery).toContain("ALREADY_SUPERSEDED=true");
  });

  it("uses Q3-only resolution only for a Q3-live, owner-null replay", () => {
    const heldOwner = recovery.indexOf('if jq -e --arg id "$OLD_RELEASE_ID" --arg q2 "$FROZEN_OLD_TARGET"');
    const ownerNull = recovery.indexOf("if jq -e '.owner_release_id == null and .owner_mode == null and .sales_paused == false'");
    const supersededResolution = recovery.indexOf('> resolution-superseded.json');
    const terminalResolution = recovery.indexOf('> resolution-after.json');

    expect(heldOwner).toBeGreaterThan(-1);
    expect(ownerNull).toBeGreaterThan(heldOwner);
    expect(supersededResolution).toBeGreaterThan(ownerNull);
    expect(terminalResolution).toBeGreaterThan(supersededResolution);

    const heldOwnerBranch = recovery.slice(heldOwner, ownerNull);
    expect(heldOwnerBranch).toContain('.owner_mode == "ROLLING" and .sales_paused == false and .expected.source_commit == $q2');
    expect(heldOwnerBranch).toContain("jq -e '.complete == false' completion.json");
    expect(heldOwnerBranch).toContain("replacement-expected.json");
    expect(heldOwnerBranch).not.toContain("/resolution/");

    const ownerNullBranch = recovery.slice(ownerNull, terminalResolution);
    expect(ownerNullBranch).toContain('[[ "$OBSERVED_PRODUCTION_DEPLOY" == "$REPLACEMENT_TARGET" ]]');
    expect(ownerNullBranch).toContain('.runtime.source_commit == $q3 and .runtime.worker_source_commit == $q3');
    expect(ownerNullBranch).toContain('> resolution-superseded.json');
    expect(ownerNullBranch).toContain('.resolution == "SUPERSEDED" and .reason_code == "SURFACE_CONTRACT_UNAVAILABLE" and .replacement_source_commit == $q3');
    expect(recovery).not.toContain("resolution-before.json");
    const terminalProof = recovery.slice(terminalResolution);
    expect(terminalProof).toContain('> resolution-after.json');
    expect(terminalProof).toContain('.complete == false and .resolution == "SUPERSEDED" and .reason_code == "SURFACE_CONTRACT_UNAVAILABLE" and .replacement_source_commit == $q3');
  });

  it("pins terminal release identity to Q3 and repeats full readiness after completion", () => {
    expect(terminal).toContain('"$INPUT_RELEASE_ID" == "agent-referrals-recovery-$REPLACEMENT_TARGET"');
    expect(terminal).toContain("terminal-readiness.json");
    expect(terminal).toContain('.owner_release_id == null and .owner_mode == null and .sales_paused == false');
  });
});
