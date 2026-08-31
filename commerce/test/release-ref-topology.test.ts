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
 *
 * There is deliberately NO gate on production-deploy -> runtime-candidate.
 * That pointer is a proposal register: a successful cutover leaves it stale
 * with no bug involved, so making staleness a CI failure would reintroduce the
 * dual authority the selection layer dropped - the runtime treating a stale
 * pointer as fine while CI called it illegal. Selection safety is asserted
 * where it belongs, against the new target: runtime-candidate-selection.test.ts.
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

// 0041 and its Epoch A direct-child runtime are the two reviewed exceptions to
// the normal integration topology. Both deployed sources remain tightly
// identified by exact parentage. This does not permit another detached
// production target.
const GEN1_0041 = "68f80a411b7f286928ef10826ed225228098d246";
const GEN2_0041 = "0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34";
const EPOCH_A_RUNTIME = "80e152259628719af20d363a76ed6b991d67482a";
const isApproved0041DetachedRuntime = (sha: string) =>
  sha === GEN2_0041 && resolve(`${GEN2_0041}^`) === GEN1_0041;
const isApprovedEpochADetachedRuntime = (sha: string) =>
  sha === EPOCH_A_RUNTIME && resolve(`${EPOCH_A_RUNTIME}^`) === GEN2_0041;

// Resolved SHAs, never branch names: a ref that has been repointed must not
// pass because its name still looks familiar.
const productionDeploy = resolve("origin/production-deploy");
const main = resolve("origin/main");

describe("durable release ref topology", () => {
  // A fork or a checkout without these refs legitimately cannot judge them, so
  // those runs skip. CI fetches them explicitly (see test.yml) precisely so the
  // skip is not the normal outcome - a guard that always skips is not a guard.
  const judged = productionDeploy && main ? { productionDeploy, main } : undefined;

  it("resolves the refs it judges", (ctx) => {
    if (!judged) return ctx.skip();
    expect(judged.productionDeploy).toMatch(/^[0-9a-f]{40}$/);
    expect(judged.main).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps main over production except for exact reviewed detached runtimes", (ctx) => {
    if (!judged) return ctx.skip();
    expect(
      isAncestor(judged.productionDeploy, judged.main)
      || isApproved0041DetachedRuntime(judged.productionDeploy)
      || isApprovedEpochADetachedRuntime(judged.productionDeploy),
      `production-deploy is not an ancestor of main.\n`
      + `  production-deploy: ${describes("origin/production-deploy")}\n`
      + `  main:              ${describes("origin/main")}\n`
      + `Only exact 0041 Gen2 or exact Epoch A R may be detached from main.`,
    ).toBe(true);
  });

});
