import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * P1 #3(b): structural proof for
 * .github/workflows/controlled-release-semantics-bootstrap.yml, mirroring
 * the rigor commerce/test/controlled-agent-referrals-workflow.test.ts already
 * applies to Agent Referrals' own production controller - every required
 * positive assertion must be textually present in the REAL committed
 * workflow, and deleting any single one must break this suite.
 */
const WORKFLOW_PATH = ".github/workflows/controlled-release-semantics-bootstrap.yml";
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
    name: "frozen bootstrap BASE",
    pattern: /BASE_SHA="24a382929740a7ead6fb0bb49f5ffc77e063c77a"/,
    removeLine: removeLinesMatching(/BASE_SHA="24a382929740a7ead6fb0bb49f5ffc77e063c77a"/),
  },
  {
    name: "certificate read from controller tree",
    pattern: /git show "\$GITHUB_SHA:\.release\/controlled-candidates\/release-semantics-bootstrap-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/,
    removeLine: removeLinesMatching(/git show "\$GITHUB_SHA:\.release\/controlled-candidates\/release-semantics-bootstrap-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/),
  },
  {
    name: "source_main ancestry assertion",
    pattern: /SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"[\s\S]*?git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/,
    removeLine: removeLinesMatching(/git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/),
  },
  {
    name: "RECONSTRUCTION_BOUND reconstruction of B2",
    pattern: /RECONSTRUCTED_SHA="\$\(node --import tsx commerce\/src\/controlled-candidate-verify\.ts candidate-certificate\.json "\$GITHUB_SHA"\)"/,
    removeLine: removeLinesMatching(/node --import tsx commerce\/src\/controlled-candidate-verify\.ts/),
  },
  {
    name: "B2^ == BASE",
    pattern: /\[\[ "\$\(git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"\)" == "\$BASE_SHA" \]\]/,
    removeLine: removeLinesMatching(/git rev-parse "\$\{RECONSTRUCTED_SHA\}\^"/),
  },
  {
    name: "runtime-candidate == B2 (fresh read)",
    pattern: /actual_runtime_candidate="\$\(git rev-parse origin\/runtime-candidate\)"[\s\S]*?\[\[ "\$actual_runtime_candidate" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$actual_runtime_candidate" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "B2 published under runtime/bootstrap ref (fresh read, flat namespace)",
    pattern: /'refs\/remotes\/origin\/runtime\/release-semantics-bootstrap-\*'[\s\S]*?RELEASE_SEMANTICS_BOOTSTRAP_NOT_PUBLISHED/,
    removeLine: removeLinesMatching(/published_ref="\$\(git for-each-ref/),
  },
  {
    name: "published ref independent read-back",
    pattern: /republished="\$\(git ls-remote --exit-code origin "refs\/heads\/\$\{published_ref#origin\/\}" \| awk '\{print \$1\}'\)"[\s\S]*?\[\[ "\$republished" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$republished" == "\$TARGET_SHA" \]\]/),
  },
  {
    name: "exact two-path manifest proof",
    pattern: /printf 'commerce\/src\/api\.ts\\ncommerce\/src\/release-control-schema\.ts\\n' \| sort > expected-bootstrap-manifest\.txt[\s\S]*?diff expected-bootstrap-manifest\.txt certified-manifest\.txt/,
    removeLine: removeLinesMatching(/diff expected-bootstrap-manifest\.txt certified-manifest\.txt/),
  },
  {
    name: "release-control.ts unchanged from BASE",
    pattern: /\[\[ "\$\(git rev-parse "\$\{BASE_SHA\}:commerce\/src\/release-control\.ts"\)" == "\$\(git rev-parse "\$\{RECONSTRUCTED_SHA\}:commerce\/src\/release-control\.ts"\)" \]\]/,
    removeLine: removeLinesMatching(/RELEASE_SEMANTICS_BOOTSTRAP_RELEASE_CONTROL_CHANGED/),
  },
  {
    name: "release boundary proof",
    pattern: /pnpm commerce:release-semantics-cutover:assert-boundary bootstrap-boundary-paths\.bin/,
    removeLine: removeLinesMatching(/pnpm commerce:release-semantics-cutover:assert-boundary bootstrap-boundary-paths\.bin/),
  },
  {
    name: "B2 topology (descendant/linear/no-maintenance-commit) against BASE",
    pattern: /scripts\/inspect-runtime-candidate-topology\.sh --production-deploy "\$BASE_SHA" --candidate "\$TARGET_SHA"/,
    removeLine: removeLinesMatching(/scripts\/inspect-runtime-candidate-topology\.sh --production-deploy "\$BASE_SHA" --candidate "\$TARGET_SHA"/),
  },
  {
    name: "CONTROLLED_CUTOVER acquire",
    pattern: /release-control\/acquire" > \/dev\/null/,
    removeLine: removeLinesMatching(/release-control\/acquire" > \/dev\/null/),
  },
  {
    name: "pause",
    pattern: /release-control\/pause" > paused\.json/,
    removeLine: removeLinesMatching(/release-control\/pause" > paused\.json/),
  },
  {
    name: "guarded production-deploy CAS with explicit expected-previous pointer",
    pattern: /scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/,
    removeLine: removeLinesMatching(/scripts\/set-production-deploy-ref\.sh "\$TARGET_SHA" "\$BASE_SHA"/),
  },
  {
    name: "fail-closed predecessor assertion before CAS (no implicit-previous fallthrough)",
    pattern: /if \[\[ "\$current_production_deploy_sha" == "\$TARGET_SHA" \]\][\s\S]*?elif \[\[ "\$current_production_deploy_sha" == "\$BASE_SHA" \]\][\s\S]*?RELEASE_SEMANTICS_BOOTSTRAP_PRODUCTION_DEPLOY_UNEXPECTED_PREDECESSOR/,
    removeLine: removeLinesMatching(/echo "RELEASE_SEMANTICS_BOOTSTRAP_PRODUCTION_DEPLOY_UNEXPECTED_PREDECESSOR=\$current_production_deploy_sha" >&2/),
  },
  {
    name: "deploy exact B2",
    pattern: /scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/,
    removeLine: removeLinesMatching(/scripts\/controlled-coolify-deploy\.sh "\$TARGET_SHA"/),
  },
  {
    name: "runtime/worker convergence + reopen",
    pattern: /scripts\/controlled-production-readiness\.sh release\.json[\s\S]*?release-control\/reopen" > reopened\.json/,
    removeLine: removeLinesMatching(/release-control\/reopen" > reopened\.json/),
  },
  {
    name: "recovery/resumability classification",
    pattern: /DEPLOY_ACTION=\$action/,
    removeLine: removeLinesMatching(/echo "DEPLOY_ACTION=\$action" >> "\$GITHUB_ENV"/),
  },
];

const missingAssertions = (source: string): string[] =>
  ASSERTIONS.filter(({ pattern }) => !pattern.test(source)).map(({ name }) => name);

describe("controlled-release-semantics-bootstrap.yml: required positive assertions", () => {
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

  it("never mode=ROLLING itself - this lane's own release is an ordinary CONTROLLED_CUTOVER", () => {
    expect(REAL_SOURCE).not.toMatch(/mode:\s*"ROLLING"/);
    expect(REAL_SOURCE).toMatch(/mode:\s*"CONTROLLED_CUTOVER"/);
  });
});

describe("controlled-release-semantics-bootstrap.yml: manual-only, dormant trigger", () => {
  it("is workflow_dispatch-only - no push, no schedule, no other automatic trigger", () => {
    const onBlock = REAL_SOURCE.slice(REAL_SOURCE.indexOf("\non:"), REAL_SOURCE.indexOf("\npermissions:"));
    expect(onBlock).toContain("workflow_dispatch:");
    expect(onBlock).not.toMatch(/^\s*push:/m);
    expect(onBlock).not.toMatch(/^\s*schedule:/m);
    expect(onBlock).not.toMatch(/^\s*pull_request:/m);
  });
});

describe("controlled-release-semantics-bootstrap.yml: rejects obvious weakening patterns", () => {
  it("never uses the legacy nested publication namespace anywhere - only the flat refs/heads/runtime/release-semantics-bootstrap-<generation> shape controlled-runtime-candidate-promotion.yml can actually discover", () => {
    // Certificate paths (.release/controlled-candidates/release-semantics-bootstrap-<BASE>/...)
    // are an unrelated namespace and are not what this guards against - this
    // checks specifically for the nested RUNTIME REF shape that broke
    // production execution (run 33969206791).
    expect(REAL_SOURCE).not.toContain("runtime/release-semantics-bootstrap/");
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

  it("never reads certificate or patch evidence from B2 (RECONSTRUCTED_SHA/TARGET_SHA) itself - only from $GITHUB_SHA, the trusted controller tree", () => {
    expect(REAL_SOURCE).not.toMatch(/git show "\$(RECONSTRUCTED_SHA|TARGET_SHA):\.release\/controlled-candidates/);
  });

  it("has no generic detached-target exemption in the shared lane - never uses or duplicates controlled-release-semantics-cutover.yml's own ancestor-of-controller check for this detached candidate", () => {
    // Prose in this file's own header comment explains the relationship to
    // that other file by name - that is documentation, not a dependency or
    // an exemption. What must never appear is the shared lane's own literal
    // admission check being satisfied or re-implemented here for B2.
    expect(REAL_SOURCE).not.toMatch(/git merge-base --is-ancestor "\$TARGET_SHA" "\$CONTROLLER_SHA"/);
  });

  it("does not hard-code B2 as an allow-listed exemption - TARGET_SHA is always the independently reconstructed and cross-checked candidate, never a bare literal comparison", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s+(TARGET_SHA|RECONSTRUCTED_SHA):\s*"?[0-9a-f]{40}"?\s*$/m);
  });

  it("never reads runtime-candidate or the published bootstrap ref from a cached/stale value - both reads are preceded by a fresh git fetch in the same step", () => {
    expect(REAL_SOURCE).toMatch(/git fetch --no-tags origin \\\s*\n\s*refs\/heads\/runtime-candidate:refs\/remotes\/origin\/runtime-candidate \\\s*\n\s*'\+refs\/heads\/runtime\/release-semantics-bootstrap-\*:refs\/remotes\/origin\/runtime\/release-semantics-bootstrap-\*'/);
  });

  it("does not skip runtime-candidate authority - deployment is never gated on reconstruction alone", () => {
    expect(REAL_SOURCE).toContain("RELEASE_SEMANTICS_BOOTSTRAP_RUNTIME_CANDIDATE_NOT_B2");
    expect(REAL_SOURCE).toContain("RELEASE_SEMANTICS_BOOTSTRAP_NOT_PUBLISHED");
  });

  it("the guarded CAS never falls through to a second live CAS on an already-applied predecessor - the already-applied branch is a distinct no-op path with no set-production-deploy-ref.sh call in it", () => {
    const guardedCasStepStart = REAL_SOURCE.indexOf("Set guarded production deployment ref with an explicit expected-previous pointer");
    expect(guardedCasStepStart).toBeGreaterThan(-1);
    const nextStepStart = REAL_SOURCE.indexOf("\n      - name:", guardedCasStepStart);
    const stepBody = REAL_SOURCE.slice(guardedCasStepStart, nextStepStart === -1 ? undefined : nextStepStart);
    const alreadyAppliedBranch = stepBody.slice(stepBody.indexOf('== "$TARGET_SHA"'), stepBody.indexOf("elif"));
    expect(alreadyAppliedBranch).not.toContain("set-production-deploy-ref.sh");
  });

  it("set-production-deploy-ref.sh is never called without its explicit expected-previous second argument", () => {
    const invocations = [...REAL_SOURCE.matchAll(/scripts\/set-production-deploy-ref\.sh\s+"[^"]+"(?:\s+"([^"]*)")?/g)];
    expect(invocations.length).toBeGreaterThan(0);
    for (const match of invocations) expect(match[1]).toBeTruthy();
  });

  it("has no operator git push escape hatch - the only git push-shaped mutation is the guarded production-deploy CAS script, never an inline git push", () => {
    expect(REAL_SOURCE).not.toMatch(/^\s*git push\b/m);
  });

  it("does not use the generic production-deploy lane - never sources or calls its migration-boundary-refusal or generic readiness assertion scripts", () => {
    expect(REAL_SOURCE).not.toContain("commerce:production-deploy:assert-boundary");
  });
});

/**
 * Incident (run 33971946073): `node --import tsx
 * commerce/src/controlled-candidate-verify.ts` ran before
 * `pnpm install --frozen-lockfile` had ever installed `tsx`, so a fresh
 * runner with no pre-existing node_modules failed immediately with
 * ERR_MODULE_NOT_FOUND - before acquire, pause, or any CAS. Nothing was
 * mutated (production-deploy stayed P, runtime-candidate stayed B2), but
 * this is a real ordering defect a source-presence check alone cannot
 * catch. See docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md for the full
 * incident.
 */
describe("controlled-release-semantics-bootstrap.yml: dependencies are installed before their first use", () => {
  const indexOfOnce = (needle: string): number => {
    const index = REAL_SOURCE.indexOf(needle);
    expect(index, `expected to find exactly one occurrence of: ${needle}`).toBeGreaterThan(-1);
    expect(REAL_SOURCE.indexOf(needle, index + 1), `expected exactly one occurrence, found a second: ${needle}`).toBe(-1);
    return index;
  };

  it("pnpm/action-setup < actions/setup-node < pnpm install < the first step that needs tsx (certificate reconstruction)", () => {
    const pnpmActionSetup = indexOfOnce("uses: pnpm/action-setup@v4");
    const setupNode = indexOfOnce("uses: actions/setup-node@v4");
    const pnpmInstall = indexOfOnce("run: pnpm install --frozen-lockfile");
    const reconstructionStep = indexOfOnce("name: Read the frozen bootstrap certificate and reconstruct B2");
    const tsxInvocation = indexOfOnce("node --import tsx commerce/src/controlled-candidate-verify.ts");

    expect(pnpmActionSetup, "pnpm/action-setup must precede actions/setup-node").toBeLessThan(setupNode);
    expect(setupNode, "actions/setup-node must precede pnpm install").toBeLessThan(pnpmInstall);
    expect(pnpmInstall, "pnpm install must precede the reconstruction step").toBeLessThan(reconstructionStep);
    expect(reconstructionStep, "the reconstruction step's own name must precede its tsx invocation").toBeLessThan(tsxInvocation);
  });

  it("the reconstruction step still invokes the real verifier - this suite fails if that call is ever removed rather than merely reordered", () => {
    expect(REAL_SOURCE).toContain("node --import tsx commerce/src/controlled-candidate-verify.ts");
  });

  it("fails if dependency installation is moved back below the reconstruction step", () => {
    // A direct regression of the exact incident shape: install occurring
    // strictly after the step that needs it.
    const reconstructionStep = REAL_SOURCE.indexOf("name: Read the frozen bootstrap certificate and reconstruct B2");
    const pnpmInstall = REAL_SOURCE.indexOf("run: pnpm install --frozen-lockfile");
    expect(pnpmInstall).toBeLessThan(reconstructionStep);
  });
});
