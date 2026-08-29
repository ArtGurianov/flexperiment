import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Classification is applied to a RANGE, never to a tip, and every previous
 * defect in this area lived in the gap between the classifier and the thing
 * that feeds it. So this builds real commits in a real repository, runs the
 * exact `git diff --name-only -z` the controllers run, and pipes it into the
 * real assert scripts.
 *
 * The specific risk being tested: exempting control-plane files must not become
 * a new blind spot. A range that contains BOTH a control-plane commit and a
 * runtime release-control commit must still be refused, and it must be refused
 * because of the runtime commit - a tip-only or last-commit-only classifier
 * would wrongly admit it.
 */

const REPO_ROOT = process.cwd();
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const commit = (message: string, files: Record<string, string>) => {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), contents);
  }
  git("add", "-A");
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
};

/** The controllers' own command, byte for byte. */
const classify = (script: string, from: string, to: string) => {
  const paths = execFileSync("git", ["diff", "--name-only", "-z", from, to], { cwd: repo, encoding: "buffer" });
  const file = join(repo, "paths.bin");
  writeFileSync(file, paths);
  try {
    const stdout = execFileSync("node", ["--import", "tsx", `${REPO_ROOT}/commerce/src/${script}`, file], { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe" });
    return { admitted: true, output: stdout.trim() };
  } catch (error) {
    const failure = error as { stderr?: string };
    return { admitted: false, output: (failure.stderr ?? "").trim() };
  }
};

const generic = (from: string, to: string) => classify("assert-generic-production-deploy-boundary.ts", from, to);
const cutover = (from: string, to: string) => classify("assert-release-semantics-cutover-boundary.ts", from, to);

let P: string;
let controlPlaneThenBenign: string;
let runtimeThenBenign: string;
let controlPlaneOnly: string;
let mixedRange: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "deploy-classification-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");

  P = commit("production baseline", {
    "commerce/src/release-control.ts": "export const gate = 1;\n",
    "commerce/src/generic-production-deploy-boundary.ts": "export const classify = 1;\n",
    "docs/notes.md": "baseline\n",
  });

  // P -> C1 (control plane only) -> B (benign)
  commit("control-plane only: change the classifier", { "commerce/src/generic-production-deploy-boundary.ts": "export const classify = 2;\n" });
  controlPlaneOnly = git("rev-parse", "HEAD");
  controlPlaneThenBenign = commit("benign docs", { "docs/notes.md": "updated\n" });

  // P -> R1 (runtime release-control) -> B (benign), on a branch from P
  git("checkout", "-q", "-b", "runtime-lineage", P);
  commit("runtime: change release-control", { "commerce/src/release-control.ts": "export const gate = 2;\n" });
  runtimeThenBenign = commit("benign docs", { "docs/notes.md": "updated\n" });

  // P -> C1 -> R1 -> B, both kinds in one range
  git("checkout", "-q", "-b", "mixed-lineage", controlPlaneOnly);
  commit("runtime: change release-control", { "commerce/src/release-control.ts": "export const gate = 3;\n" });
  mixedRange = commit("benign docs", { "docs/notes.md": "updated again\n" });
});

describe("deploy classification over real commit ranges", () => {
  it("admits a range whose only sensitive commit is control plane", () => {
    // The case that forced this change: a classifier commit sitting between
    // production and a benign target used to make the benign target
    // undeployable, and the only remedy was a ceremonial production pause.
    const result = generic(P, controlPlaneThenBenign);
    expect(result.admitted, `refused with: ${result.output}`).toBe(true);
  });

  it("refuses a range containing a runtime release-control commit", () => {
    const result = generic(P, runtimeThenBenign);
    expect(result.admitted).toBe(false);
    expect(result.output).toContain("GENERIC_DEPLOY_RELEASE_SEMANTICS_BOUNDARY_CHANGED");
  });

  it("refuses a mixed range, and not because of the tip", () => {
    // The tip is a docs commit and the newest sensitive commit is exempt, so a
    // classifier that looked at either would admit this.
    const result = generic(P, mixedRange);
    expect(result.admitted, "a mixed range was admitted - the exemption became a blind spot").toBe(false);
    expect(result.output).toContain("GENERIC_DEPLOY_RELEASE_SEMANTICS_BOUNDARY_CHANGED");
  });

  it("sends a control-plane-only range to the generic lane, not the cutover lane", () => {
    const result = cutover(P, controlPlaneThenBenign);
    expect(result.admitted).toBe(false);
    expect(result.output).toContain("RELEASE_SEMANTICS_CUTOVER_CHANGE_IS_BENIGN_USE_GENERIC_DEPLOY");
  });

  it("admits the runtime range into the cutover lane the generic lane refused", () => {
    // The two lanes must partition, not overlap or leave a gap: exactly one
    // accepts any given range.
    expect(generic(P, runtimeThenBenign).admitted).toBe(false);
    expect(cutover(P, runtimeThenBenign).admitted).toBe(true);
  });
});
