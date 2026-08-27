import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const topologyScript = join(root, "scripts/inspect-runtime-candidate-topology.sh");
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const git = (directory: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const createCommit = (directory: string, files: Record<string, string>, message: string) => {
  for (const [name, contents] of Object.entries(files)) {
    const file = join(directory, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, contents);
  }
  git(directory, ["add", "."]); git(directory, ["commit", "-qm", message]);
  return git(directory, ["rev-parse", "HEAD"]);
};

const initRepo = () => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-runtime-candidate-topology-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "test@example.test"]);
  git(directory, ["config", "user.name", "Test"]);
  return directory;
};

const run = (directory: string, productionDeploy: string, candidate: string) =>
  spawnSync("bash", [topologyScript, "--production-deploy", productionDeploy, "--candidate", candidate], { cwd: directory, encoding: "utf8" });

describe("runtime candidate topology inspection", () => {
  it("reports a clean direct descendant with no maintenance commits in range", () => {
    const directory = initRepo();
    const r3 = createCommit(directory, { "commerce/src/release-control.ts": "r3\n" }, "R3");
    const r4 = createCommit(directory, { "commerce/src/release-control.ts": "r4\n" }, "R4");
    const result = run(directory, r3, r4);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      production_deploy: r3, candidate: r4,
      candidate_is_descendant_of_production_deploy: true,
      maintenance_commits_in_range: [],
      merge_commits_in_range: [],
    });
  });

  it("reports the candidate itself as a valid (self-)descendant with an empty range", () => {
    const directory = initRepo();
    const r3 = createCommit(directory, { "a.txt": "r3\n" }, "R3");
    const result = run(directory, r3, r3);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ candidate_is_descendant_of_production_deploy: true, maintenance_commits_in_range: [], merge_commits_in_range: [] });
  });

  it("flags every maintenance commit in the ancestry path, not only the tip", () => {
    const directory = initRepo();
    const r3 = createCommit(directory, { "a.txt": "r3\n" }, "R3");
    const m3 = createCommit(directory, { ".release/maintenance-only": "true\n", "bridge.ts": "bridge\n" }, "M3");
    const strayChild = createCommit(directory, { "unrelated.txt": "stray\n" }, "stray child of M3");
    const result = run(directory, r3, strayChild);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.candidate_is_descendant_of_production_deploy).toBe(true);
    expect(parsed.maintenance_commits_in_range).toEqual(expect.arrayContaining([m3, strayChild]));
  });

  it("reports a clean R3->R4 branch built directly from R3, bypassing M3 entirely", () => {
    const directory = initRepo();
    const r3 = createCommit(directory, { "a.txt": "r3\n" }, "R3");
    createCommit(directory, { ".release/maintenance-only": "true\n" }, "M3 (sibling, not an ancestor of R4)");
    git(directory, ["checkout", "-q", r3]);
    const r4 = createCommit(directory, { "commerce/src/release-control.ts": "0036 fix\n" }, "R4");
    const result = run(directory, r3, r4);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      production_deploy: r3, candidate: r4,
      candidate_is_descendant_of_production_deploy: true,
      maintenance_commits_in_range: [],
      merge_commits_in_range: [],
    });
  });

  it("flags a merge commit in the ordinary runtime range even without a maintenance marker", () => {
    const directory = initRepo();
    const r3 = createCommit(directory, { "a.txt": "r3\n" }, "R3");
    git(directory, ["checkout", "-q", "-b", "side", r3]);
    const side = createCommit(directory, { "side.txt": "side\n" }, "side branch (no maintenance marker)");
    git(directory, ["checkout", "-q", "-b", "runtime", r3]);
    createCommit(directory, { "runtime.txt": "runtime\n" }, "runtime commit");
    git(directory, ["merge", "-q", "--no-ff", side, "-m", "merge side into runtime"]);
    const merge = git(directory, ["rev-parse", "HEAD"]);
    const r4 = createCommit(directory, { "commerce/src/release-control.ts": "0036 fix\n" }, "R4");
    const result = run(directory, r3, r4);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.candidate_is_descendant_of_production_deploy).toBe(true);
    expect(parsed.maintenance_commits_in_range).toEqual([]);
    expect(parsed.merge_commits_in_range).toEqual([merge]);
  });

  it("reports false for a candidate that is not a descendant of production-deploy", () => {
    const directory = initRepo();
    const base = createCommit(directory, { "a.txt": "base\n" }, "base");
    const productionDeploy = createCommit(directory, { "a.txt": "prod\n" }, "production-deploy branch");
    git(directory, ["checkout", "-q", "-B", "unrelated", base]);
    const candidate = createCommit(directory, { "b.txt": "unrelated\n" }, "unrelated branch");
    const result = run(directory, productionDeploy, candidate);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ candidate_is_descendant_of_production_deploy: false });
  });

  it("fails closed for an unresolvable commit", () => {
    const directory = initRepo();
    createCommit(directory, { "a.txt": "a\n" }, "a");
    const result = run(directory, "a".repeat(40), "b".repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("RUNTIME_CANDIDATE_TOPOLOGY_PRODUCTION_DEPLOY_COMMIT_UNAVAILABLE");
  });

  it("requires both identities", () => {
    const directory = initRepo();
    const result = spawnSync("bash", [topologyScript, "--candidate", "HEAD"], { cwd: directory, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("RUNTIME_CANDIDATE_TOPOLOGY_IDENTITIES_REQUIRED");
  });
});
