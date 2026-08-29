import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Controller SHA and deployment source SHA are separate identities. The
 * document has said so from the beginning and every controller repeats it in a
 * comment, but nothing compared them: the assertion was
 * `CONTROLLER_SHA == origin/main`, which pins the controller and says nothing
 * about the target.
 *
 * Third instance of one shape, so it gets a structural test rather than another
 * careful comment:
 *
 *   ancestry fence            invariant real, production ref never fetched
 *   release-semantic boundary invariant real, paths cut before the assertion
 *   controller/target split   invariant real, values never compared
 *
 * A safety property counts as enforced at the orchestration seam, not because
 * its statement exists somewhere true.
 */

const WORKFLOWS = ".github/workflows";

/**
 * In scope: a lane that moves a durable ref AND can be pointed at a target
 * chosen now.
 *
 * Out of scope, deliberately and for reasons rather than because they fail:
 *
 * - verify-only and classification controllers move nothing and have no target
 * - a lane pinned to a consumed 40-hex SHA (R5/R6/R7, checkout-legal) cannot be
 *   repointed, so the confusion cannot arise
 * - age-band sets its TARGET_SHA to the controller commit by construction and
 *   carries the deployment source in a separate variable. It is the historical
 *   shape this invariant now forbids; adding the check would make a consumed
 *   controller permanently fail rather than protect anything, and inviting
 *   someone to "repair" a spent epoch is the larger risk.
 *
 * The scope is therefore the lanes where a target is still a choice.
 */
const pinnedToConsumedSha = (source: string) =>
  /^\s+(EXPECTED_[A-Z_]+|DEPLOYMENT_TARGET):\s*"?[0-9a-f]{40}"?\s*$/m.test(source);
const targetIsControllerByConstruction = (source: string) => source.includes('TARGET_SHA="$(git rev-parse HEAD)"');

const MUTATING = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`${WORKFLOWS}/${name}`, "utf8") }))
  .filter(({ source }) => source.includes("set-production-deploy-ref.sh") || source.includes("refs/heads/runtime-candidate"))
  .filter(({ source }) => source.includes("INPUT_TARGET_SHA") || source.includes("origin/runtime-candidate"))
  .filter(({ source }) => !pinnedToConsumedSha(source) && !targetIsControllerByConstruction(source));

describe("controller and deployment target are distinct identities", () => {
  it("finds the lanes that move production or the candidate register", () => {
    expect(MUTATING.map(({ name }) => name)).not.toHaveLength(0);
  });

  it.each(MUTATING.map(({ name, source }) => [name, source] as const))(
    "%s refuses a target equal to its own controller SHA",
    (_name, source) => {
      const compares = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\[\[\s*"\$(\w*target_sha|\w*TARGET_SHA)"\s*!=\s*"\$CONTROLLER_SHA"\s*\]\]/.test(line));

      expect(
        compares,
        "no check compares the deployment target against the controller SHA; "
          + "asserting CONTROLLER_SHA == origin/main pins the controller only",
      ).not.toHaveLength(0);

      for (const line of compares) {
        // The comparison must abort, not warn - this ran green for months as a
        // comment and a document sentence.
        expect(line, `comparison does not fail the run:\n  ${line}`).toMatch(/exit 1/);
      }
    },
  );
});
