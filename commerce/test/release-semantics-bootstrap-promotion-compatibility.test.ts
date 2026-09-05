import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The actual gap that let the bootstrap ship with an undiscoverable
 * publication ref: nothing proved, against real Git, that
 * controlled-runtime-candidate-promotion.yml's own discovery command can
 * actually find what the bootstrap publisher writes. Production execution
 * (run 33969206791) found this the hard way -
 * RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH - before any CAS ran;
 * see docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md for the full incident.
 *
 * This proves the real, unmodified discovery command from
 * controlled-runtime-candidate-promotion.yml against a real temporary git
 * repository - never a string/regex assertion on workflow YAML text, which
 * is exactly the kind of check that already existed and still missed this.
 */

const DISCOVERY_PATTERN = "refs/remotes/origin/runtime/*";

const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

/** The exact discovery command controlled-runtime-candidate-promotion.yml runs, unmodified. */
const discoverPublishingBranch = (repo: string, target: string): string =>
  git(repo, ["for-each-ref", "--format=%(refname:short)", "--contains", target, DISCOVERY_PATTERN])
    .split("\n")
    .filter(Boolean)[0] ?? "";

describe("release-semantics bootstrap publication is compatible with the generic promotion lane's real discovery command", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bootstrap-promotion-compat-"));
    git(repo, ["init", "--quiet"]);
    git(repo, ["config", "user.name", "Test Fixture"]);
    git(repo, ["config", "user.email", "fixture@example.test"]);
    git(repo, ["commit", "--quiet", "--allow-empty", "-m", "target"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("finds the canonical FLAT publication ref (refs/remotes/origin/runtime/release-semantics-bootstrap-<generation>)", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap-1", target]);
    expect(discoverPublishingBranch(repo, target)).toBe("origin/runtime/release-semantics-bootstrap-1");
  });

  it("does NOT find the legacy NESTED shape (refs/remotes/origin/runtime/release-semantics-bootstrap/<generation>) - the single-`*` glob does not cross `/`", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap/bootstrap-1", target]);
    expect(discoverPublishingBranch(repo, target)).toBe("");
  });

  it("still finds the flat ref when a legacy nested ref for the same target also exists (retained-but-not-canonical coexistence)", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap/bootstrap-1", target]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap-1", target]);
    expect(discoverPublishingBranch(repo, target)).toBe("origin/runtime/release-semantics-bootstrap-1");
  });

  it("does not find a flat ref pointing at a commit with no ancestry relationship to the target (a disconnected history, not merely an older sibling)", () => {
    const target = git(repo, ["rev-parse", "HEAD"]);
    // A genuinely disconnected root commit - never a descendant of target -
    // so --contains target must not match it.
    const unrelatedTree = git(repo, ["write-tree"]);
    const unrelated = git(repo, ["commit-tree", unrelatedTree, "-m", "disconnected"]);
    git(repo, ["update-ref", "refs/remotes/origin/runtime/release-semantics-bootstrap-1", unrelated]);
    expect(discoverPublishingBranch(repo, target)).toBe("");
  });
});
