import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural proof for .github/workflows/controlled-agent-referrals.yml
 * (the ROLLING production controller for Q2), mirroring the rigor
 * commerce/test/controlled-release-semantics-bootstrap-workflow.test.ts
 * already applies to the bootstrap's own production controller - every
 * required positive assertion must be textually present in the REAL
 * committed workflow, and deleting any single one must break this suite.
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
    name: "exact-main controller assertion",
    pattern: /\[\[ "\$GITHUB_REF" == "refs\/heads\/main" \]\][\s\S]*?\[\[ "\$CONTROLLER_SHA" == "\$\(git rev-parse origin\/main\)" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$CONTROLLER_SHA" == "\$\(git rev-parse origin\/main\)" \]\]/),
  },
  {
    name: "frozen BASE (B2), never re-derived from observed production-deploy",
    pattern: /BASE_SHA="f540b997d6d31a22293909ded7ce464c3f51732f"/,
    removeLine: removeLinesMatching(/BASE_SHA="f540b997d6d31a22293909ded7ce464c3f51732f"/),
  },
  {
    name: "certificate read from controller tree",
    pattern: /git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/,
    removeLine: removeLinesMatching(/git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/),
  },
  {
    name: "source_main ancestry assertion",
    pattern: /SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"[\s\S]*?git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/,
    removeLine: removeLinesMatching(/git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/),
  },
  {
    name: "RECONSTRUCTION_BOUND reconstruction of Q2",
    pattern: /RECONSTRUCTED_SHA="\$\(node --import tsx commerce\/src\/controlled-candidate-verify\.ts candidate-certificate\.json "\$GITHUB_SHA"\)"/,
    removeLine: removeLinesMatching(/node --import tsx commerce\/src\/controlled-candidate-verify\.ts/),
  },
  {
    name: "Q2^ == BASE",
    pattern: /\[\[ "\$\(git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"\)" == "\$BASE_SHA" \]\]/,
    removeLine: removeLinesMatching(/git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"/),
  },
  {
    name: "RECONSTRUCTED_SHA == TARGET_SHA (operator-confirmed)",
    pattern: /\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "runtime-candidate == Q2 (fresh read)",
    pattern: /actual_runtime_candidate="\$\(git rev-parse origin\/runtime-candidate\)"[\s\S]*?\[\[ "\$actual_runtime_candidate" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$actual_runtime_candidate" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "Q2 published under runtime/agent-referrals ref (fresh read, flat namespace)",
    pattern: /'refs\/remotes\/origin\/runtime\/agent-referrals-\*'[\s\S]*?AGENT_REFERRALS_RELEASE_NOT_PUBLISHED/,
    removeLine: removeLinesMatching(/published_ref="\$\(git for-each-ref/),
  },
  {
    name: "published ref independent read-back",
    pattern: /republished="\$\(git ls-remote --exit-code origin "refs\/heads\/\$\{published_ref#origin\/\}" \| awk '\{print \$1\}'\)"[\s\S]*?\[\[ "\$republished" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$republished" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "exact changed-path manifest proof",
    pattern: /jq -r '\.paths\[\]\.path' candidate-certificate\.json \| sort > certified-manifest\.txt[\s\S]*?diff certified-manifest\.txt actual-changed-paths\.txt/,
    removeLine: removeLinesMatching(/diff certified-manifest\.txt actual-changed-paths\.txt/),
  },
  {
    name: "Q2 topology (descendant/linear/no-maintenance-commit) against BASE",
    pattern: /scripts\/inspect-runtime-candidate-topology\.sh --production-deploy "\$BASE_SHA" --candidate "\$TARGET_SHA"/,
    removeLine: removeLinesMatching(/scripts\/inspect-runtime-candidate-topology\.sh --production-deploy "\$BASE_SHA" --candidate "\$TARGET_SHA"/),
  },
  {
    name: "predecessor completion gate (Epoch B)",
    pattern: /release-control\/completion\/\$EPOCH_B_RELEASE_ID" > epoch-b-completion\.json[\s\S]*?jq -e '\.complete == true' epoch-b-completion\.json/,
    removeLine: removeLinesMatching(/jq -e '\.complete == true' epoch-b-completion\.json/),
  },
  {
    name: "0042-0049 migration expectation",
    pattern: /0042_agent_referrals_agents_rebuild\.sql 0043_agent_referrals_foundation\.sql 0044_partner_identity\.sql 0045_engagement_publication\.sql 0046_attribution_reward\.sql 0047_act_payment_settlement\.sql 0048_ord_reporting\.sql 0049_agent_referrals_integration_hardening\.sql/,
    removeLine: removeLinesMatching(/for migration in 0042_agent_referrals_agents_rebuild\.sql/),
  },
  {
    name: "recovery/resumability classification",
    pattern: /RECONCILE_ACTION=\$action/,
    removeLine: removeLinesMatching(/echo "RECONCILE_ACTION=\$action" >> "\$GITHUB_ENV"/),
  },
  {
    name: "three-way predecessor classification (BASE / TARGET / else fail-closed)",
    pattern: /if \[\[ "\$current_pointer" == "\$BASE_SHA" \]\][\s\S]*?elif \[\[ "\$current_pointer" == "\$TARGET_SHA" \]\][\s\S]*?AGENT_REFERRALS_RELEASE_POINTER_UNEXPECTED/,
    removeLine: removeLinesMatching(/echo "AGENT_REFERRALS_RELEASE_POINTER_UNEXPECTED=\$current_pointer" >&2/),
  },
  {
    name: "ROLLING acquire",
    pattern: /release-control\/acquire" > acquired\.json[\s\S]*?owner_mode == "ROLLING"/,
    removeLine: removeLinesMatching(/'\.owner_release_id == \$release_id and \.owner_mode == "ROLLING" and \.sales_paused == false' acquired\.json/),
  },
  {
    name: "production-deploy CAS BASE -> Q2 with explicit expected-previous",
    pattern: /scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/,
    removeLine: removeLinesMatching(/scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/),
  },
  {
    name: "exact Q2 deploy",
    pattern: /scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/,
    removeLine: removeLinesMatching(/scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/),
  },
  {
    name: "DORMANT proof (expanded predicate)",
    pattern: /agent-referrals\/dormant-readiness" > dormant-readiness-after\.json[\s\S]*?jq -e '\.ready == true' dormant-readiness-after\.json/,
    removeLine: removeLinesMatching(/jq -e '\.ready == true' dormant-readiness-after\.json/),
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

  it("no migration apply step - never runs the migration tool against production", () => {
    expect(REAL_SOURCE).not.toContain("commerce:migrate");
    expect(REAL_SOURCE).not.toContain("commerce/src/migrate.ts");
  });

  it("no pause: the normal ROLLING path never calls /v1/internal/release-control/pause (only mentioned in prose explaining why it never does)", () => {
    expect(REAL_SOURCE).not.toMatch(/"\$PUBLIC_API_URL\/v1\/internal\/release-control\/pause"/);
  });

  it("no activation path: never calls activateAgentReferrals, /activate, or any Agent Referrals activation route", () => {
    expect(REAL_SOURCE).not.toMatch(/activateAgentReferrals|agent-referrals\/activate|ACTIVATE_AGENT_REFERRALS/i);
    expect(REAL_SOURCE).not.toMatch(/\.state == "ACTIVE"/);
  });

  it("never uses the legacy nested publication namespace anywhere - only the flat refs/heads/runtime/agent-referrals-<generation> shape controlled-runtime-candidate-promotion.yml can actually discover", () => {
    expect(REAL_SOURCE).not.toContain("runtime/agent-referrals/");
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
  it("does not skip the controller-is-current-main assertion", () => {
    expect(REAL_SOURCE).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(REAL_SOURCE).toContain("git rev-parse origin/main");
  });

  it("does not use an unrelated user-provided controller SHA as the trusted patch source - only $GITHUB_SHA (this checkout's own commit) ever fills that role", () => {
    const verifyInvocations = [...REAL_SOURCE.matchAll(/node --import tsx commerce\/src\/controlled-candidate-verify\.ts\s+\S+\s+"([^"]+)"/g)];
    expect(verifyInvocations.length).toBeGreaterThan(0);
    for (const match of verifyInvocations) expect(match[1]).toBe("$GITHUB_SHA");
  });

  it("never reads certificate or patch evidence from Q2 itself under a name suggesting it substitutes for the controller tree", () => {
    // Migration content IS legitimately read from $TARGET_SHA (Q2) - that is
    // what "apply exact migrations" proves - but the certificate/patch
    // evidence that AUTHORIZES Q2 in the first place must never be read
    // from Q2 itself.
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

  it("does not hard-code Q2 as an allow-listed exemption in a way that bypasses reconstruction - TARGET_SHA is always the independently reconstructed and cross-checked candidate", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s+(TARGET_SHA|RECONSTRUCTED_SHA):\s*"?[0-9a-f]{40}"?\s*$/m);
  });

  it("set-production-deploy-ref.sh is never called without its explicit expected-previous second argument", () => {
    const invocations = [...REAL_SOURCE.matchAll(/scripts\/set-production-deploy-ref\.sh\s+"[^"]+"(?:\s+"([^"]*)")?/g)];
    expect(invocations.length).toBeGreaterThan(0);
    for (const match of invocations) expect(match[1]).toBeTruthy();
  });

  it("never activates Agent Referrals - DORMANT/ready is asserted at every checkpoint and is the only feature-state equality this workflow ever asserts", () => {
    const stateAssertions = [...REAL_SOURCE.matchAll(/\.(?:feature_state|state) == "([A-Z]+)"/g)].map((m) => m[1]);
    expect(stateAssertions.length).toBeGreaterThanOrEqual(2);
    for (const state of stateAssertions) expect(state).toBe("DORMANT");
    const readyAssertions = [...REAL_SOURCE.matchAll(/\.ready == (true|false)/g)].map((m) => m[1]);
    expect(readyAssertions.length).toBeGreaterThanOrEqual(2);
    for (const ready of readyAssertions) expect(ready).toBe("true");
  });
});
