import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural proof for .github/workflows/controlled-agent-referrals.yml
 * (Phase 10B production controller lane, PR10): every required positive
 * assertion must be textually present in the REAL committed workflow, and
 * deleting any single one must break this suite - never a synthetic
 * fixture standing in for the real thing. Mirrors the rigor
 * commerce/test/controller-not-older-than-target.test.ts already applies to
 * this same file's own RECONSTRUCTION_BOUND assertions.
 */
const WORKFLOW_PATH = ".github/workflows/controlled-agent-referrals.yml";
const REAL_SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

const removeLinesMatching = (pattern: RegExp) => (source: string): string =>
  source.split("\n").filter((line) => !pattern.test(line)).join("\n");

const ASSERTIONS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp; readonly removeLine: (source: string) => string }> = [
  {
    name: "manual-only trigger",
    pattern: /^\s*workflow_dispatch:/m,
    removeLine: removeLinesMatching(/^\s*workflow_dispatch:/),
  },
  {
    name: "certificate/Q reconstruction bound to controller tree",
    pattern: /git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/,
    removeLine: removeLinesMatching(/git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/),
  },
  {
    name: "runtime publication proof",
    pattern: /publish_ref="refs\/heads\/runtime\/agent-referrals\/\$\{INPUT_GENERATION\}"[\s\S]*?\[\[ "\$published" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$published" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "runtime-candidate == Q",
    pattern: /TARGET_SHA="\$\(git ls-remote --exit-code origin refs\/heads\/runtime-candidate \| awk '\{print \$1\}'\)"/,
    removeLine: removeLinesMatching(/TARGET_SHA="\$\(git ls-remote --exit-code origin refs\/heads\/runtime-candidate \| awk '\{print \$1\}'\)"/),
  },
  {
    name: "ROLLING acquire",
    pattern: /release-control\/acquire" > acquired\.json[\s\S]*?owner_mode == "ROLLING"/,
    removeLine: removeLinesMatching(/'\.owner_release_id == \$release_id and \.owner_mode == "ROLLING" and \.sales_paused == false' acquired\.json/),
  },
  {
    name: "exact Q deploy",
    pattern: /scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/,
    removeLine: removeLinesMatching(/scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/),
  },
  {
    name: "0042-0049 migration expectation",
    pattern: /0042_agent_referrals_agents_rebuild\.sql 0043_agent_referrals_foundation\.sql 0044_partner_identity\.sql 0045_engagement_publication\.sql 0046_attribution_reward\.sql 0047_act_payment_settlement\.sql 0048_ord_reporting\.sql 0049_agent_referrals_integration_hardening\.sql/,
    removeLine: removeLinesMatching(/for migration in 0042_agent_referrals_agents_rebuild\.sql/),
  },
  {
    // DORMANT and zero-business-facts are proven together by one
    // consolidated, fail-closed evidence call
    // (agent-referrals-dormant-readiness.ts) - the same evidence
    // /complete-rolling's own domain-level predicate is fail-closed
    // against, so the workflow's own check can never disagree with what
    // completion itself enforces.
    name: "DORMANT proof",
    pattern: /agent-referrals\/dormant-readiness" > dormant-readiness-after\.json[\s\S]*?jq -e '\.ready == true' dormant-readiness-after\.json/,
    removeLine: removeLinesMatching(/jq -e '\.ready == true' dormant-readiness-after\.json/),
  },
  {
    name: "zero Agent Referrals production-business-facts proof",
    pattern: /agent-referrals\/dormant-readiness" > dormant-readiness-after\.json[\s\S]*?jq -e '\.ready == true' dormant-readiness-after\.json/,
    removeLine: removeLinesMatching(/agent-referrals\/dormant-readiness" > dormant-readiness-after\.json/),
  },
  {
    name: "predecessor completion gate (Epoch B)",
    pattern: /release-control\/completion\/\$EPOCH_B_RELEASE_ID" > epoch-b-completion\.json[\s\S]*?jq -e --arg base "\$BASE_SHA" '\.complete == true and \.expected\.source_commit == \$base' epoch-b-completion\.json/,
    removeLine: removeLinesMatching(/jq -e --arg base "\$BASE_SHA" '\.complete == true and \.expected\.source_commit == \$base' epoch-b-completion\.json/),
  },
  {
    name: "recovery/resumability classification",
    pattern: /RECONCILE_ACTION=\$action/,
    removeLine: removeLinesMatching(/echo "RECONCILE_ACTION=\$action" >> "\$GITHUB_ENV"/),
  },
  {
    name: "production-deploy CAS BASE -> Q",
    pattern: /scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/,
    removeLine: removeLinesMatching(/scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/),
  },
  {
    name: "completeRolling",
    pattern: /release-control\/complete-rolling" > completed\.json/,
    removeLine: removeLinesMatching(/release-control\/complete-rolling" > completed\.json/),
  },
];

const missingAssertions = (source: string): string[] =>
  ASSERTIONS.filter(({ pattern }) => !pattern.test(source)).map(({ name }) => name);

describe("controlled-agent-referrals.yml: required positive assertions", () => {
  it("the real workflow contains every required assertion", () => {
    expect(missingAssertions(REAL_SOURCE)).toEqual([]);
  });

  it.each(ASSERTIONS.map(({ name, removeLine }) => [name, removeLine] as const))(
    "breaks when the required assertion %s is deleted from the real workflow",
    (name, removeLine) => {
      const withoutAssertion = removeLine(REAL_SOURCE);
      expect(missingAssertions(withoutAssertion)).toContain(name);
    },
  );

  it("no pause: the normal ROLLING path never calls /v1/internal/release-control/pause (only mentioned in prose explaining why it never does)", () => {
    expect(REAL_SOURCE).not.toMatch(/"\$PUBLIC_API_URL\/v1\/internal\/release-control\/pause"/);
  });

  it("no activation path: never calls activateAgentReferrals, /activate, or any Agent Referrals activation route", () => {
    expect(REAL_SOURCE).not.toMatch(/activateAgentReferrals|agent-referrals\/activate|ACTIVATE_AGENT_REFERRALS/i);
    // DORMANT is asserted at every readiness checkpoint - never ACTIVE.
    expect(REAL_SOURCE).not.toMatch(/\.state == "ACTIVE"/);
  });
});

describe("controlled-agent-referrals.yml: manual-only, dormant trigger", () => {
  it("is workflow_dispatch-only - no push, no schedule, no other automatic trigger", () => {
    const onBlock = REAL_SOURCE.slice(REAL_SOURCE.indexOf("\non:"), REAL_SOURCE.indexOf("\npermissions:"));
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).not.toMatch(/^\s*push:/m);
    expect(onBlock).not.toMatch(/^\s*schedule:/m);
    expect(onBlock).not.toMatch(/^\s*pull_request:/m);
  });
});

describe("controlled-agent-referrals.yml: rejects obvious weakening patterns", () => {
  it("does not hard-code a detached-Q exemption - TARGET_SHA is always resolved from the runtime-candidate ref or the optional operator input, never a literal SHA", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s+(TARGET_SHA|RECONSTRUCTED_SHA):\s*"?[0-9a-f]{40}"?\s*$/m);
  });

  it("does not skip the controller-is-current-main assertion", () => {
    expect(REAL_SOURCE).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(REAL_SOURCE).toContain("git rev-parse origin/main");
  });

  it("does not use an unrelated user-provided controller SHA as the trusted patch source - only $GITHUB_SHA (this checkout's own commit) ever fills that role", () => {
    const verifyInvocations = [...REAL_SOURCE.matchAll(/node --import tsx commerce\/src\/agent-referrals-candidate-verify\.ts\s+\S+\s+"([^"]+)"/g)];
    expect(verifyInvocations.length).toBeGreaterThan(0);
    for (const match of verifyInvocations) expect(match[1]).toBe("$GITHUB_SHA");
  });

  it("never reads certificate, patch, or migration evidence from Q's own commit under a name suggesting it substitutes for the controller tree", () => {
    // Migration content IS legitimately read from $TARGET_SHA (Q) - that is
    // what "apply exact migrations" proves - but the certificate/patch
    // evidence that AUTHORIZES Q in the first place must never be read from
    // Q itself (the circular proof commerce/src/agent-referrals-candidate.ts
    // refuses to perform).
    expect(REAL_SOURCE).not.toMatch(/git show "\$TARGET_SHA:\.release\/controlled-candidates/);
  });

  it("does not use the generic production-deploy lane - never sources or calls its migration-boundary-refusal or generic readiness assertion scripts", () => {
    expect(REAL_SOURCE).not.toContain("commerce:production-deploy:assert-boundary");
    expect(REAL_SOURCE).not.toContain("assert-generic-production-deploy-ready.ts");
    expect(REAL_SOURCE).not.toContain("reconcile-generic-production-deploy.ts");
    expect(REAL_SOURCE).not.toContain("controlled-production-readiness.sh");
  });

  it("has no operator git push escape hatch - the only git push-shaped mutation is the guarded production-deploy CAS script, never an inline git push", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s*git push\b/m);
  });

  it("never activates Agent Referrals - DORMANT/ready is asserted at every checkpoint (before acquire, after deploy, at terminal completion/replay) and is the only feature-state equality this workflow ever asserts", () => {
    const stateAssertions = [...REAL_SOURCE.matchAll(/\.(?:feature_state|state) == "([A-Z]+)"/g)].map((m) => m[1]);
    expect(stateAssertions.length).toBeGreaterThanOrEqual(2); // terminal replay + terminal completion
    for (const state of stateAssertions) expect(state).toBe("DORMANT");
    const readyAssertions = [...REAL_SOURCE.matchAll(/\.ready == (true|false)/g)].map((m) => m[1]);
    expect(readyAssertions.length).toBeGreaterThanOrEqual(2); // before-CAS + after-deploy dormant-readiness checks
    for (const ready of readyAssertions) expect(ready).toBe("true");
  });
});
