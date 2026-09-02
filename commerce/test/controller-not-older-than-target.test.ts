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
    && /^\s+EPOCH_A_RUNTIME_SHA:\s*"?[0-9a-f]{40}"?\s*$/m.test(source))
  // Epoch B P is deliberately created only after legal publication supplies
  // its durable timestamp. It cannot be a main ancestor or a hard-coded SHA;
  // the controller must instead reconstruct the exact direct child of R.
  || (source.includes("name: Controlled Epoch B notification activation")
    && /^\s+EPOCH_A_RUNTIME_SHA:\s*"?[0-9a-f]{40}"?\s*$/m.test(source)
    && source.includes("epochBPromotionArtifactReason")
    && source.includes("createEpochBPromotionArtifact"));

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

/**
 * §B-1 / Phase 1: a deployment target is classified into exactly one of
 * three lanes:
 *
 *   ANCESTRY_BOUND        the existing rule above (merge-base --is-ancestor)
 *   RECONSTRUCTION_BOUND  a positive proof obligation, asserted below
 *   HISTORICAL_HARD_BOUND the existing legacy exemptions, frozen
 *
 * RECONSTRUCTION_BOUND exists for the Agent Referrals candidate Q, whose SHA
 * is deliberately NOT required to be a main ancestor (see
 * commerce/src/agent-referrals-candidate.ts and the plan's §B-1). Unlike
 * hardBoundRecoveryTarget above, admission here is a POSITIVE proof: the
 * workflow source must contain all five required assertions, and deleting
 * any single one must break this test. This is deliberately not another
 * hardBoundRecoveryTarget-style skip and not a name-based exemption -
 * `if (workflow.includes("agent-referrals")) skip` is exactly the failure
 * shape this machinery exists to close off.
 *
 * No real workflow claims this class in PR1 - the actual
 * controlled-agent-referrals-candidate.yml lands in a later PR, once Q's SHA
 * exists to reconstruct. This suite proves the classifier's teeth today
 * against a synthetic fixture built to the same contract a real workflow
 * must satisfy, so CI already fails the day someone deletes one of these
 * assertions from the real thing.
 */
type DeploymentTargetClass = "ANCESTRY_BOUND" | "RECONSTRUCTION_BOUND" | "HISTORICAL_HARD_BOUND";

/**
 * The source-main ancestry assertion is deliberately ONE combined pattern,
 * not two independent ones. An earlier version of this machinery checked
 * "some SOURCE_MAIN_SHA is proven an ancestor" and "the certificate is read"
 * as unrelated facts - which a workflow could satisfy with a decoy
 * SOURCE_MAIN_SHA (a safe, real ancestor of main) while the certificate's own
 * `source_main_sha` field, the value that actually authorizes every
 * patch_path lookup, pointed at an unrelated, unproven commit. Binding the
 * extraction to the exact certificate file closes that: SOURCE_MAIN_SHA can
 * only ever be the certificate's own claimed value, so proving it an
 * ancestor proves the certificate's real authority, not a decoy.
 */
const CERTIFICATE_FILE = "candidate-certificate.json";

const removeLinesMatching = (pattern: RegExp) => (source: string): string =>
  source.split("\n").filter((line) => !pattern.test(line)).join("\n");

/**
 * `pattern` is what a real workflow's source must positively contain;
 * `removeLine` is how this suite's own removal tests delete just that
 * assertion from a fixture. They are kept separate because the ancestry
 * assertion's pattern deliberately spans two lines (see above) - a per-line
 * `.test()` of that pattern would never match any single line, so its own
 * `removeLine` instead targets the narrower extraction line alone. The
 * dedicated describe block below additionally proves that removing the
 * merge-base half, or decoupling the two from each other entirely, also
 * breaks this check - so nothing about picking only one line here weakens
 * the assertion as a whole.
 */
const RECONSTRUCTION_BOUND_ASSERTIONS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp; readonly removeLine: (source: string) => string }> = [
  {
    name: "certificate read from the controller/main tree, at the canonical BASE-scoped path",
    pattern: /git show "\$(GITHUB_SHA|CONTROLLER_SHA):\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/,
    removeLine: removeLinesMatching(/git show "\$(GITHUB_SHA|CONTROLLER_SHA):\.release\/controlled-candidates\/agent-referrals-\$BASE_SHA\/certificate\.json" > candidate-certificate\.json/),
  },
  {
    name: "source-main ancestry assertion, extracted from and bound to the exact certificate (SOURCE_MAIN_SHA ⊆ CONTROLLER)",
    pattern: /SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"[\s\S]*?git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$(GITHUB_SHA|CONTROLLER_SHA)"/,
    removeLine: removeLinesMatching(/^SOURCE_MAIN_SHA="\$\(jq -er '\.source_main_sha' candidate-certificate\.json\)"$/),
  },
  {
    name: "BASE equality assertion",
    pattern: /jq -e --arg base "\$BASE_SHA" '\.base_sha == \$base'/,
    removeLine: removeLinesMatching(/jq -e --arg base "\$BASE_SHA" '\.base_sha == \$base'/),
  },
  {
    name: "exact reconstruction invocation",
    pattern: /node --import tsx commerce\/src\/agent-referrals-candidate-verify\.ts/,
    removeLine: removeLinesMatching(/node --import tsx commerce\/src\/agent-referrals-candidate-verify\.ts/),
  },
  {
    name: "RECONSTRUCTED_SHA == TARGET_SHA",
    pattern: /\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/,
    removeLine: removeLinesMatching(/\[\[ "\$RECONSTRUCTED_SHA" == "\$TARGET_SHA" \]\]/),
  },
];

/** Every assertion must positively appear; absence of even one is a failure, never a pass-through. */
const missingReconstructionBoundAssertions = (source: string): string[] =>
  RECONSTRUCTION_BOUND_ASSERTIONS.filter(({ pattern }) => !pattern.test(source)).map(({ name }) => name);

const isReconstructionBound = (source: string): boolean => missingReconstructionBoundAssertions(source).length === 0;

/** The exact shape a real controlled-agent-referrals-candidate.yml step must contain - every line load-bearing. */
const reconstructionBoundFixture = () => [
  'BASE_SHA="$(scripts/read-production-deploy-ref.sh)"',
  `git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-$BASE_SHA/certificate.json" > ${CERTIFICATE_FILE}`,
  `SOURCE_MAIN_SHA="$(jq -er '.source_main_sha' ${CERTIFICATE_FILE})"`,
  'git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA" || { echo "SOURCE_MAIN_SHA_NOT_ANCESTOR" >&2; exit 1; }',
  `jq -e --arg base "$BASE_SHA" '.base_sha == $base' ${CERTIFICATE_FILE} >/dev/null || { echo "CANDIDATE_BASE_MISMATCH" >&2; exit 1; }`,
  `RECONSTRUCTED_SHA="$(node --import tsx commerce/src/agent-referrals-candidate-verify.ts ${CERTIFICATE_FILE})"`,
  '[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]] || { echo "CANDIDATE_RECONSTRUCTION_MISMATCH" >&2; exit 1; }',
].join("\n");

/**
 * The exact adversarial shape this coupling exists to close: a decoy
 * SOURCE_MAIN_SHA read from an unrelated input (here, a plain file) that is
 * genuinely a safe ancestor of main, while the certificate - read separately
 * - is never consulted for its own source_main_sha at all. Every other
 * assertion (certificate read, BASE equality, reconstruction, final SHA
 * equality) is present and correctly shaped; only the ancestry proof is
 * decoupled from the certificate's own authority.
 */
const decoupledAncestryFixture = () => [
  'SOURCE_MAIN_SHA="$(cat source-main-sha.txt)"',
  'git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA" || { echo "SOURCE_MAIN_SHA_NOT_ANCESTOR" >&2; exit 1; }',
  'BASE_SHA="$(scripts/read-production-deploy-ref.sh)"',
  `git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-$BASE_SHA/certificate.json" > ${CERTIFICATE_FILE}`,
  `jq -e --arg base "$BASE_SHA" '.base_sha == $base' ${CERTIFICATE_FILE} >/dev/null || { echo "CANDIDATE_BASE_MISMATCH" >&2; exit 1; }`,
  `RECONSTRUCTED_SHA="$(node --import tsx commerce/src/agent-referrals-candidate-verify.ts ${CERTIFICATE_FILE})"`,
  '[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]] || { echo "CANDIDATE_RECONSTRUCTION_MISMATCH" >&2; exit 1; }',
].join("\n");

describe("RECONSTRUCTION_BOUND: positive proof obligation for a detached candidate", () => {
  it("classifies zero real workflows today (the real controller lands with the real certificate, in a later PR)", () => {
    const workflows = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => readFileSync(`${WORKFLOWS}/${name}`, "utf8"));
    expect(workflows.filter(isReconstructionBound)).toHaveLength(0);
  });

  it("accepts a fixture containing all five required assertions", () => {
    expect(missingReconstructionBoundAssertions(reconstructionBoundFixture())).toEqual([]);
    expect(isReconstructionBound(reconstructionBoundFixture())).toBe(true);
  });

  it.each(RECONSTRUCTION_BOUND_ASSERTIONS.map(({ name, removeLine }) => [name, removeLine] as const))(
    "breaks when the required assertion %s is deleted",
    (name, removeLine) => {
      const withoutAssertion = removeLine(reconstructionBoundFixture());
      expect(missingReconstructionBoundAssertions(withoutAssertion)).toContain(name);
      expect(isReconstructionBound(withoutAssertion)).toBe(false);
    },
  );

  describe("the ancestry assertion cannot be satisfied by decoupling extraction from the ancestry check", () => {
    it("breaks when only the merge-base half is deleted (extraction survives, but nothing proves it)", () => {
      const withoutMergeBase = reconstructionBoundFixture()
        .split("\n")
        .filter((line) => !/^git merge-base --is-ancestor "\$SOURCE_MAIN_SHA" "\$GITHUB_SHA"/.test(line))
        .join("\n");
      expect(isReconstructionBound(withoutMergeBase)).toBe(false);
    });

    it("REQUEST-CHANGES regression: a decoy SOURCE_MAIN_SHA read from an unrelated input, proven safe, while the certificate's own source_main_sha is never checked, must NOT qualify as RECONSTRUCTION_BOUND", () => {
      // Every assertion the old (pre-fix) machinery checked independently is
      // still present and individually well-formed in this fixture - the
      // certificate is read, BASE equality holds, reconstruction runs, the
      // final SHA is compared. Only the binding between the ancestry proof
      // and the certificate's own authority is missing, exactly as it was
      // before this fix.
      expect(isReconstructionBound(decoupledAncestryFixture())).toBe(false);
      // Confirm it fails for the specific coupling reason, not by accident of
      // some unrelated assertion also being absent from this fixture.
      const missing = missingReconstructionBoundAssertions(decoupledAncestryFixture());
      expect(missing).toEqual(["source-main ancestry assertion, extracted from and bound to the exact certificate (SOURCE_MAIN_SHA ⊆ CONTROLLER)"]);
    });
  });

  it("does not admit a name-based skip or a new hard-coded exemption in place of the real proof", () => {
    // The literal failure shape the plan calls out: a workflow claiming to be
    // reconstruction-bound purely because its filename mentions the feature,
    // with none of the five assertions actually present.
    const nameOnly = "name: Controlled agent-referrals candidate\n# agent-referrals\n";
    expect(isReconstructionBound(nameOnly)).toBe(false);
  });
});

describe("deployment target classification is exhaustive and mutually exclusive", () => {
  const classify = (source: string, name: string): DeploymentTargetClass =>
    isReconstructionBound(source) ? "RECONSTRUCTION_BOUND" : hardBoundRecoveryTarget(source) || name === "controlled-age-band-cutover.yml" ? "HISTORICAL_HARD_BOUND" : "ANCESTRY_BOUND";

  it("classifies every real workflow that advances production-deploy", () => {
    for (const { name, source } of readdirSync(WORKFLOWS)
      .filter((n) => n.endsWith(".yml"))
      .map((n) => ({ name: n, source: readFileSync(`${WORKFLOWS}/${n}`, "utf8") }))
      .filter(({ source }) => source.includes("set-production-deploy-ref.sh"))) {
      const targetClass = classify(source, name);
      expect(["ANCESTRY_BOUND", "RECONSTRUCTION_BOUND", "HISTORICAL_HARD_BOUND"]).toContain(targetClass);
      // Today, every real workflow is either ancestry- or historical-hard-bound;
      // RECONSTRUCTION_BOUND is proven above against a synthetic fixture only.
      expect(targetClass).not.toBe("RECONSTRUCTION_BOUND");
    }
  });
});
