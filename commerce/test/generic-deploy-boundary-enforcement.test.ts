import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { genericProductionDeployBoundaryError, releaseSemanticsPaths } from "../src/generic-production-deploy-boundary";

/**
 * The boundary module is only as wide as the paths a workflow actually hands
 * it, and that seam is invisible to every unit test of the module itself.
 *
 * This is the concrete failure it exists to prevent: the boundary was widened
 * to RELEASE_SEMANTICS, its own tests passed, and the deploy step kept feeding
 * `git diff` a pathspec limited to the original three directories. The
 * release-semantic paths were filtered out before the assertion ran, so the
 * widened boundary was inert on the only path that matters. A generic deploy
 * would have carried release-control.ts through as an ordinary change - exactly
 * the R7 defect the boundary was written to catch.
 *
 * Same shape as the ancestry fence that never fetched production-deploy: the
 * check was real, the enforcement path never reached it.
 */

const WORKFLOWS = ".github/workflows";

const workflowsAssertingTheBoundary = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, source: readFileSync(`${WORKFLOWS}/${name}`, "utf8") }))
  .filter(({ source }) => source.includes(":assert-boundary"));

describe("generic deploy boundary enforcement", () => {
  it("is asserted by at least one workflow", () => {
    // Matches any :assert-boundary lane, so a new controller with its own
    // admission script is covered the day it is added rather than the day
    // someone remembers to add it here.
    expect(workflowsAssertingTheBoundary.map(({ name }) => name)).not.toHaveLength(0);
  });

  it.each(workflowsAssertingTheBoundary.map(({ name, source }) => [name, source] as const))(
    "%s feeds the boundary an unrestricted diff",
    (_name, source) => {
      const diffs = source
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("git diff --name-only -z") && line.includes("boundary-paths.bin"));

      expect(diffs, "boundary assertion with no diff producing its input").not.toHaveLength(0);

      for (const line of diffs) {
        // `--` here would re-narrow the boundary to whatever the shell lists,
        // silently overriding the module that is supposed to own the decision.
        expect(line, `pathspec restricts what the boundary can ever see:\n  ${line}`).not.toMatch(/\s--\s/);
      }
    },
  );

  it("would refuse the release-semantic paths it previously let through", () => {
    // The pathspec that caused this listed exactly these three directories, so
    // every release-semantic path was invisible to the assertion.
    for (const path of releaseSemanticsPaths) {
      expect(genericProductionDeployBoundaryError([path]), `${path} is not enforced`).toBe(
        "GENERIC_DEPLOY_RELEASE_SEMANTICS_BOUNDARY_CHANGED",
      );
      expect(path.startsWith("commerce/migrations")).toBe(false);
      expect(path.startsWith("commerce/legal")).toBe(false);
      expect(path.startsWith("public/legal")).toBe(false);
    }
  });
});
