import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Durable release refs must stay in a provable relationship. Both invariants
 * here failed in production on 2026-08-28 and cost real outage time:
 *
 *  - main did not contain production-deploy, so main documented the R7
 *    migrationApplied() fix while its own source still carried the defect.
 *    A deploy from main would have been a silent semantic rollback.
 *  - runtime-candidate did not descend from production-deploy after a cutover
 *    advanced production without touching the candidate ref, which blocks
 *    every generic deploy - and the ordinary promotion path cannot repair it,
 *    because it validates that same property first.
 *
 * Cheap to assert, and either would have been caught before dispatch.
 */

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

const resolve = (ref: string): string | undefined => {
  const result = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
};

const describes = (ref: string) => git("log", "-1", "--format=%h %s", ref).stdout.trim();

const isAncestor = (ancestor: string, descendant: string) =>
  git("merge-base", "--is-ancestor", ancestor, descendant).status === 0;

// Resolved SHAs, never branch names: a ref that has been repointed must not
// pass because its name still looks familiar.
const productionDeploy = resolve("origin/production-deploy");
const main = resolve("origin/main");
const runtimeCandidate = resolve("origin/runtime-candidate");

describe("durable release ref topology", () => {
  it("has the refs it needs to judge, or is a checkout that cannot judge them", () => {
    // A shallow or fork checkout legitimately lacks these. Skipping is honest;
    // asserting on absent refs would be a test that passes for the wrong reason.
    if (!productionDeploy || !main) {
      expect(productionDeploy ?? main).toBeUndefined();
      return;
    }
    expect(productionDeploy).toMatch(/^[0-9a-f]{40}$/);
    expect(main).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps main a descendant of what production actually runs", () => {
    if (!productionDeploy || !main) return;
    expect(
      isAncestor(productionDeploy, main),
      `production-deploy is not an ancestor of main.\n`
      + `  production-deploy: ${describes("origin/production-deploy")}\n`
      + `  main:              ${describes("origin/main")}\n`
      + `Deploying from main would drop commits that are live in production.`,
    ).toBe(true);
  });

  it("keeps the runtime candidate a descendant of what production actually runs", () => {
    if (!productionDeploy || !runtimeCandidate) return;
    expect(
      isAncestor(productionDeploy, runtimeCandidate),
      `runtime-candidate is not a descendant of production-deploy.\n`
      + `  production-deploy: ${describes("origin/production-deploy")}\n`
      + `  runtime-candidate: ${describes("origin/runtime-candidate")}\n`
      + `Every generic deploy asserts this, so the ref is unusable until repaired.`,
    ).toBe(true);
  });
});
