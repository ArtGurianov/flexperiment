import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Same real-Git proof as
 * commerce/test/release-semantics-bootstrap-promotion-compatibility.test.ts,
 * applied to Q2's own flat publication namespace
 * (refs/heads/runtime/agent-referrals-<generation>) - PR #61's old, now
 * permanently obsolete candidate used a NESTED shape
 * (refs/heads/runtime/agent-referrals/<generation>) that
 * controlled-runtime-candidate-promotion.yml's real discovery command
 * cannot find, exactly the incident that first broke the (unrelated)
 * bootstrap candidate's own first publication. Q2 must never repeat it.
 */
const DISCOVERY_PATTERN = "refs/remotes/origin/runtime/*";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const discoverPublishingBranch = (repo: string, target: string): string =>
  git(repo, ["for-each-ref", "--format=%(refname:short)", "--contains", target, DISCOVERY_PATTERN])
    .split("\n")
    .filter(Boolean)[0] ?? "";

describe("Agent Referrals Q2 publication is compatible with the generic promotion lane's real discovery command", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "q2-promotion-compat-"));
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.name", "Test Fixture"]);
    git(repo, ["config", "user.email", "fixture@example.test"]);
    git(repo, ["commit", "--quiet", "--allow-empty", "-m", "target"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("finds the canonical FLAT publication ref (refs/remotes/origin/runtime/agent-referrals-<generation>)", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/agent-referrals-2", target]);
    expect(discoverPublishingBranch(repo, target)).toBe("origin/runtime/agent-referrals-2");
  });

  it("does NOT find the legacy NESTED shape PR #61's obsolete candidate used (refs/remotes/origin/runtime/agent-referrals/<generation>)", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/agent-referrals/1", target]);
    expect(discoverPublishingBranch(repo, target)).toBe("");
  });

  it("coexists with the unrelated bootstrap candidate's own flat namespace without ambiguity", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap-2", target]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/agent-referrals-2", target]);
    const found = git(repo, ["for-each-ref", "--format=%(refname:short)", "--contains", target, DISCOVERY_PATTERN]).split("\n").filter(Boolean);
    expect(found.sort()).toEqual(["origin/runtime/agent-referrals-2", "origin/runtime/release-semantics-bootstrap-2"]);
  });
});
