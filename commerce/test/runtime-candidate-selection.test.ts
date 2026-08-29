import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Selection-layer contract for `runtime-candidate`.
 *
 * It is a proposal register, never an authority. The only ancestry that
 * decides whether a new target may be adopted is that the target descends from
 * what production is actually running. The previous proposal's value and its
 * ancestry are irrelevant - requiring the old value to be healthy is what made
 * a stale pointer unreplaceable and forced break-glass twice for a pointer that
 * was never broken, only superseded.
 *
 * Exercised against real repositories rather than by reading the workflow,
 * because these are git behaviours - ancestry and lease semantics - and a
 * substring assertion would not notice if git disagreed with the intent.
 */

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
};

const must = (cwd: string, ...args: string[]) => {
  const result = run(cwd, ...args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  return result.out;
};

function repository() {
  const root = mkdtempSync(resolve(tmpdir(), "flexperiment-refs-"));
  directories.push(root);
  const origin = resolve(root, "origin.git");
  const work = resolve(root, "work");
  must(root, "init", "--bare", "--initial-branch=main", origin);
  must(root, "clone", "--quiet", origin, work);
  must(work, "config", "user.email", "test@example.test");
  must(work, "config", "user.name", "Test");

  const commit = (message: string) => {
    writeFileSync(resolve(work, "file.txt"), `${message}\n`);
    must(work, "add", "file.txt");
    must(work, "commit", "--quiet", "-m", message);
    return must(work, "rev-parse", "HEAD");
  };
  const setRef = (ref: string, sha: string) => must(work, "push", "--quiet", "--force", "origin", `${sha}:refs/heads/${ref}`);
  const readRef = (ref: string) => must(work, "ls-remote", "origin", `refs/heads/${ref}`).split(/\s+/)[0];

  return { root, origin, work, commit, setRef, readRef };
}

/** Exactly the predicate the promotion controller applies to a new target. */
const targetIsAdoptable = (work: string, productionDeploy: string, target: string) =>
  run(work, "merge-base", "--is-ancestor", productionDeploy, target).ok;

describe("runtime-candidate selection", () => {
  it("adopts a new target over a stale pointer, with no repair", () => {
    const repo = repository();
    const production = repo.commit("production");
    repo.setRef("production-deploy", production);

    // A cutover advanced production; the pointer stayed on an older line. No
    // bug involved - this is the ordinary aftermath of a successful release.
    must(repo.work, "checkout", "--quiet", "-b", "side", `${production}~0`);
    must(repo.work, "checkout", "--quiet", "-B", "stale", production);
    const stale = repo.commit("stale proposal");
    repo.setRef("runtime-candidate", stale);
    const newerProduction = (() => {
      must(repo.work, "checkout", "--quiet", "-B", "prod", production);
      const sha = repo.commit("production moved");
      repo.setRef("production-deploy", sha);
      return sha;
    })();

    expect(targetIsAdoptable(repo.work, newerProduction, stale), "the stale proposal is genuinely no longer valid").toBe(false);

    must(repo.work, "checkout", "--quiet", "-B", "next", newerProduction);
    const target = repo.commit("new proposal");
    expect(targetIsAdoptable(repo.work, newerProduction, target)).toBe(true);

    // The ordinary path replaces the stale pointer outright.
    must(repo.work, "push", "--quiet", `--force-with-lease=refs/heads/runtime-candidate:${stale}`, "origin", `${target}:refs/heads/runtime-candidate`);
    expect(repo.readRef("runtime-candidate")).toBe(target);
  });

  it("does not require the new target to continue the previous proposal", () => {
    const repo = repository();
    const production = repo.commit("production");
    repo.setRef("production-deploy", production);

    must(repo.work, "checkout", "--quiet", "-B", "a", production);
    const proposalA = repo.commit("proposal A");
    repo.setRef("runtime-candidate", proposalA);

    // B descends from production but not from A: two independent proposals.
    must(repo.work, "checkout", "--quiet", "-B", "b", production);
    const proposalB = repo.commit("proposal B");

    expect(run(repo.work, "merge-base", "--is-ancestor", proposalA, proposalB).ok, "B deliberately does not continue A").toBe(false);
    expect(targetIsAdoptable(repo.work, production, proposalB)).toBe(true);

    must(repo.work, "push", "--quiet", `--force-with-lease=refs/heads/runtime-candidate:${proposalA}`, "origin", `${proposalB}:refs/heads/runtime-candidate`);
    expect(repo.readRef("runtime-candidate")).toBe(proposalB);
  });

  it("still refuses a target that does not descend from production", () => {
    const repo = repository();
    const base = repo.commit("base");
    must(repo.work, "checkout", "--quiet", "-B", "prod", base);
    const production = repo.commit("production");
    repo.setRef("production-deploy", production);
    repo.setRef("runtime-candidate", production);

    // Forked before production: adopting it would silently drop live commits.
    must(repo.work, "checkout", "--quiet", "-B", "bad", base);
    const bad = repo.commit("unrelated line");

    expect(targetIsAdoptable(repo.work, production, bad)).toBe(false);
    expect(repo.readRef("runtime-candidate")).toBe(production);
  });

  /**
   * The pointer's value is no longer authority over what may replace it, but it
   * is still the CAS token: a concurrent writer must not be silently clobbered.
   */
  it("keeps the pointer read as a lease, refusing a write that lost a race", () => {
    const repo = repository();
    const production = repo.commit("production");
    repo.setRef("production-deploy", production);
    must(repo.work, "checkout", "--quiet", "-B", "a", production);
    const proposalA = repo.commit("proposal A");
    repo.setRef("runtime-candidate", proposalA);

    const observed = repo.readRef("runtime-candidate");
    expect(observed).toBe(proposalA);

    // A competing writer moves the pointer after we observed it.
    must(repo.work, "checkout", "--quiet", "-B", "c", production);
    const proposalC = repo.commit("proposal C");
    repo.setRef("runtime-candidate", proposalC);

    must(repo.work, "checkout", "--quiet", "-B", "b", production);
    const proposalB = repo.commit("proposal B");
    const lost = run(repo.work, "push", `--force-with-lease=refs/heads/runtime-candidate:${observed}`, "origin", `${proposalB}:refs/heads/runtime-candidate`);

    expect(lost.ok, "a write against a stale lease must be refused").toBe(false);
    expect(repo.readRef("runtime-candidate")).toBe(proposalC);
  });
});
