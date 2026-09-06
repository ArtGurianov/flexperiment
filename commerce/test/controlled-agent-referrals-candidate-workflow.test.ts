import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Structural proof for .github/workflows/controlled-agent-referrals-candidate.yml
 * (Q2 publication lane), mirroring the rigor
 * commerce/test/controlled-release-semantics-bootstrap-candidate-workflow.test.ts
 * already applies to the bootstrap's own publication lane - every required
 * positive assertion must be textually present in the REAL committed
 * workflow, and deleting any single one must break this suite.
 */
const WORKFLOW_PATH = ".github/workflows/controlled-agent-referrals-candidate.yml";
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
    name: "certificate read from controller tree",
    pattern: /git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/,
    removeLine: removeLinesMatching(/git show "\$GITHUB_SHA:\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/),
  },
  {
    name: "source_main extracted from certificate",
    pattern: /SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"/,
    removeLine: removeLinesMatching(/SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"/),
  },
  {
    name: "source_main ancestry assertion",
    pattern: /git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/,
    removeLine: removeLinesMatching(/git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/),
  },
  {
    name: "trusted controller passed to verifier",
    pattern: /node --import tsx commerce\/src\/controlled-candidate-verify\.ts candidate-certificate\.json "\$GITHUB_SHA"/,
    removeLine: removeLinesMatching(/node --import tsx commerce\/src\/controlled-candidate-verify\.ts/),
  },
  {
    name: "BASE equality",
    pattern: /jq -e --arg base "\$BASE_SHA" '\.base_sha == \$base' candidate-certificate\.json/,
    removeLine: removeLinesMatching(/jq -e --arg base "\$BASE_SHA" '\.base_sha == \$base' candidate-certificate\.json/),
  },
  {
    name: "Q2^ == BASE",
    pattern: /\[\[ "\$\(git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"\)" == "\$BASE_SHA" \]\]/,
    removeLine: removeLinesMatching(/git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"/),
  },
  {
    name: "RECONSTRUCTED_SHA == TARGET_SHA",
    pattern: /\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "exact changed-path manifest proof",
    pattern: /jq -r '\.paths\[\]\.path' candidate-certificate\.json \| sort > certified-manifest\.txt[\s\S]*?diff certified-manifest\.txt actual-changed-paths\.txt/,
    removeLine: removeLinesMatching(/diff certified-manifest\.txt actual-changed-paths\.txt/),
  },
  {
    name: "forbidden legal path check",
    pattern: /grep -qE '\^\(public\/legal\/\|commerce\/legal\/\)' certified-manifest\.txt/,
    removeLine: removeLinesMatching(/grep -qE '\^\(public\/legal\/\|commerce\/legal\/\)' certified-manifest\.txt/),
  },
  {
    name: "runtime/agent-referrals ref publication (flat namespace)",
    pattern: /publish_ref="refs\/heads\/runtime\/agent-referrals-\$\{INPUT_GENERATION\}"/,
    removeLine: removeLinesMatching(/publish_ref="refs\/heads\/runtime\/agent-referrals-\$\{INPUT_GENERATION\}"/),
  },
  {
    name: "remote read-back",
    pattern: /published="\$\(git ls-remote --exit-code origin "\$PUBLISH_REF" \| awk '\{print \$1\}'\)"[\s\S]*?\[\[ "\$published" == "\$RECONSTRUCTED_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$published" == "\$RECONSTRUCTED_SHA" \]\]/),
  },
  {
    name: "least-authority publication credential (persist-credentials: false)",
    pattern: /persist-credentials:\s*false/,
    removeLine: removeLinesMatching(/persist-credentials:\s*false/),
  },
  {
    name: "dedicated publication-scoped token bound before any push",
    pattern: /AGENT_REFERRALS_CANDIDATE_REF_TOKEN[\s\S]*?git remote set-url origin "https:\/\/x-access-token:\$\{AGENT_REFERRALS_CANDIDATE_REF_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
    removeLine: removeLinesMatching(/git remote set-url origin "https:\/\/x-access-token:\$\{AGENT_REFERRALS_CANDIDATE_REF_TOKEN\}@github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/),
  },
];

const missingAssertions = (source: string): string[] =>
  ASSERTIONS.filter(({ pattern }) => !pattern.test(source)).map(({ name }) => name);

describe("controlled-agent-referrals-candidate.yml: required positive assertions", () => {
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

  it("no runtime-candidate mutation - the ref is never a git push target, only mentioned in prose explaining a later, separate lane", () => {
    expect(REAL_SOURCE).not.toMatch(/git push[^\n]*runtime-candidate/);
    expect(REAL_SOURCE).not.toMatch(/force-with-lease="refs\/heads\/runtime-candidate/);
  });

  it("no production-deploy mutation - never calls set-production-deploy-ref.sh or pushes to that ref", () => {
    expect(REAL_SOURCE).not.toContain("set-production-deploy-ref.sh");
    expect(REAL_SOURCE).not.toMatch(/git push[^\n]*production-deploy/);
  });

  it("does not use the default write-scoped GITHUB_TOKEN for the push - top-level permissions are read-only", () => {
    const permissionsBlock = REAL_SOURCE.slice(REAL_SOURCE.indexOf("\npermissions:"), REAL_SOURCE.indexOf("\nconcurrency:"));
    expect(permissionsBlock).toMatch(/contents:\s*read/);
    expect(permissionsBlock).not.toMatch(/contents:\s*write/);
  });

  it("never uses the legacy nested publication namespace anywhere - only the flat refs/heads/runtime/agent-referrals-<generation> shape controlled-runtime-candidate-promotion.yml can actually discover", () => {
    expect(REAL_SOURCE).not.toContain("runtime/agent-referrals/");
  });
});

describe("controlled-agent-referrals-candidate.yml: manual-only, dormant trigger", () => {
  it("is workflow_dispatch-only - no push, no schedule, no other automatic trigger", () => {
    const onBlock = REAL_SOURCE.slice(REAL_SOURCE.indexOf("\non:"), REAL_SOURCE.indexOf("\npermissions:"));
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).not.toMatch(/^\s*push:/m);
    expect(onBlock).not.toMatch(/^\s*schedule:/m);
    expect(onBlock).not.toMatch(/^\s*pull_request:/m);
  });
});

describe("controlled-agent-referrals-candidate.yml: rejects obvious weakening patterns", () => {
  it("does not hard-code a detached-Q2 exemption - TARGET_SHA comes only from the operator-supplied workflow_dispatch input, never a literal SHA in the file", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s+(TARGET_SHA|RECONSTRUCTED_SHA|EXPECTED_[A-Z_]+):\s*"?[0-9a-f]{40}"?\s*$/m);
  });

  it("does not skip the controller-is-current-main assertion", () => {
    expect(REAL_SOURCE).toContain('[[ "$GITHUB_REF" == "refs/heads/main" ]]');
    expect(REAL_SOURCE).toContain("git rev-parse origin/main");
  });

  it("does not use an unrelated user-provided controller SHA as the trusted patch source - only $GITHUB_SHA (this checkout's own commit) ever fills that role", () => {
    const verifyInvocations = [...REAL_SOURCE.matchAll(/node --import tsx commerce\/src\/controlled-candidate-verify\.ts\s+\S+\s+"([^"]+)"/g)];
    expect(verifyInvocations.length).toBeGreaterThan(0);
    for (const match of verifyInvocations) expect(match[1]).toBe("$GITHUB_SHA");
  });

  it("never reads certificate or patch evidence from Q2 (RECONSTRUCTED_SHA/TARGET_SHA) itself - only from $GITHUB_SHA, the trusted controller tree", () => {
    expect(REAL_SOURCE).not.toMatch(/git show "\$(RECONSTRUCTED_SHA|TARGET_SHA):/);
  });

  it("has no generic deploy fallback - never triggers Coolify or any deployment webhook", () => {
    expect(REAL_SOURCE).not.toContain("controlled-coolify-deploy.sh");
    expect(REAL_SOURCE).not.toContain("COOLIFY_TOKEN");
  });

  it("has no operator git push escape hatch - every git push in this file is lease-guarded, never a bare push", () => {
    const pushes = [...REAL_SOURCE.matchAll(/^\s*git push\b.*$/gm)];
    expect(pushes.length).toBeGreaterThan(0);
    for (const [line] of pushes) expect(line).toContain("--force-with-lease");
  });

  it("never acquires release ownership or deploys - publication only", () => {
    expect(REAL_SOURCE).not.toMatch(/release-control\/acquire/);
    expect(REAL_SOURCE).not.toMatch(/release-control\/pause/);
    expect(REAL_SOURCE).not.toContain("COMMERCE_RELEASE_CONTROL_TOKEN");
  });
});
