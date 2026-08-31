import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The invariant is that a controller must not be OLDER than what it deploys, so
 * the policy doing the judging covers the code being judged.
 *
 * It is deliberately not "controller and target are different commits". That
 * was tried and was the wrong property twice over:
 *
 * - it does not buy independence. `main` is a descendant of every target, so a
 *   different controller SHA still contains the target's own policy changes. A
 *   commit that weakened admission would be judged by its own weakened rule
 *   either way.
 * - it forced a ceremonial extra commit before anything could ship, because the
 *   controller can never deploy its own HEAD.
 *
 * Real controller independence needs a separate protected controller artifact
 * whose policy does not derive from the candidate. Strict SHA inequality on
 * `main` was never that mechanism.
 *
 * What the original invariant actually forbids is DERIVING the target from the
 * controller - `TARGET_SHA="$(git rev-parse HEAD)"` - which is a different
 * statement from the two SHAs happening to coincide.
 */

const WORKFLOWS = ".github/workflows";

// A one-shot recovery may use a literal runtime SHA whose direct topology is
// checked by that workflow.  Its squash-merged controller deliberately need
// not contain that runtime, so it is not a candidate for the generic
// controller-reachability rule below.
const hardBoundRecoveryTarget = (source: string) =>
  /^\s+(EXPECTED_[A-Z_]+|DEPLOYMENT_TARGET|GEN2_RUNTIME_SHA):\s*"?[0-9a-f]{40}"?\s*$/m.test(source)
  || (source.includes("name: Controlled Epoch A dormant runtime promotion")
    && /^\s+EPOCH_A_RUNTIME_SHA:\s*"?[0-9a-f]{40}"?\s*$/m.test(source));

const DEPLOYING = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`${WORKFLOWS}/${name}`, "utf8") }))
  .filter(({ source }) => source.includes("set-production-deploy-ref.sh"))
  .filter(({ source }) => !hardBoundRecoveryTarget(source));

describe("a controller is never older than what it deploys", () => {
  it("finds the lanes that advance production", () => {
    expect(DEPLOYING.map(({ name }) => name)).not.toHaveLength(0);
  });

  it.each(DEPLOYING.map(({ name, source }) => [name, source] as const))(
    "%s proves the target is reachable from the controller",
    (_name, source) => {
      const checks = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^git merge-base --is-ancestor "\$(TARGET_SHA|target_sha|CANDIDATE_SOURCE_COMMIT|GEN2_RUNTIME_SHA)" "\$(CONTROLLER_SHA|MAIN_SHA)"/.test(line));

      expect(checks, "nothing proves the controller covers the target it deploys").not.toHaveLength(0);
      for (const line of checks) expect(line, `does not fail the run:\n  ${line}`).toMatch(/exit 1/);
    },
  );

  it.each(
    readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => [name, readFileSync(`${WORKFLOWS}/${name}`, "utf8")] as const)
      .filter(([, source]) => source.includes("set-production-deploy-ref.sh")),
  )("%s never derives its deployment target from the controller checkout", (name, source) => {
    // age-band did exactly this and is the historical shape the invariant
    // forbids; it is a spent epoch, so it is named rather than silently passed.
    const derives = /TARGET_SHA="\$\(git rev-parse HEAD\)"/.test(source);
    if (name === "controlled-age-band-cutover.yml") {
      expect(derives, "age-band no longer derives its target; drop this exemption").toBe(true);
      return;
    }
    expect(derives, "deployment target is derived from the controller commit").toBe(false);
  });
});
