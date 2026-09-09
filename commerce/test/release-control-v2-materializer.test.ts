import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleasePacket } from "../src/release-control-v2";
import {
  assertReleaseControlV2SourceOnFirstParentIntegrationLineage,
  materializeReleaseControlV2Candidate,
  reconstructReleaseControlV2Candidate,
} from "../src/release-control-v2-materializer";

const repos: string[] = [];
const git = (cwd: string, args: readonly string[], input?: string | Buffer) =>
  execFileSync("git", args, { cwd, input, encoding: "utf8" }).trim();
const gitBytes = (cwd: string, args: readonly string[]) =>
  Buffer.from(execFileSync("git", args, { cwd, encoding: "buffer" }));
const commit = (cwd: string, message: string) => {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-qm", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
};
const tree = (cwd: string, sha: string) => git(cwd, ["rev-parse", `${sha}^{tree}`]);

const fixture = () => {
  const repo = mkdtempSync(join(tmpdir(), "release-control-v2-materializer-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, "commerce-domain.txt"), "base\n");
  writeFileSync(join(repo, "removed.txt"), "remove me\n");
  writeFileSync(join(repo, "mode.sh"), "#!/bin/sh\necho base\n");
  chmodSync(join(repo, "mode.sh"), 0o644);
  const root = commit(repo, "root");
  git(repo, ["checkout", "-qb", "source", root]);
  writeFileSync(join(repo, "source-parent.txt"), "parent\n");
  const parent = commit(repo, "source parent");
  writeFileSync(join(repo, "commerce-domain.txt"), "source delta\n");
  rmSync(join(repo, "removed.txt"));
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 255, 0, 127]));
  chmodSync(join(repo, "mode.sh"), 0o755);
  const source = commit(repo, "source integration");
  git(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "production-only.txt"), "production\n");
  const base = commit(repo, "production base");
  return { repo, base, parent, source };
};

afterEach(() => {
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

describe("Release Control v2 deterministic candidate materializer", () => {
  it("creates the same detached linear candidate from a divergent base and one exact integration commit", () => {
    const { repo, base, parent, source } = fixture();
    const first = materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: source });
    const orderFile = join(repo, "ambient-diff-order");
    writeFileSync(orderFile, "mode.sh\ncommerce-domain.txt\nbinary.bin\n");
    git(repo, ["config", "--local", "diff.orderFile", orderFile]);
    git(repo, ["config", "--local", "diff.indentHeuristic", "true"]);
    const second = materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: source });

    expect(first.certificate).toEqual(second.certificate);
    expect(first.canonical_patch.equals(second.canonical_patch)).toBe(true);
    expect(first.certificate.candidate_parent_sha).toBe(base);
    expect(git(repo, ["rev-parse", `${first.certificate.candidate_sha}^`])).toBe(base);
    expect(git(repo, ["diff", "--name-only", parent, source]).split("\n").sort()).toEqual(first.certificate.canonical_path_manifest);
    expect(git(repo, ["diff", "--name-only", base, first.certificate.candidate_sha]).split("\n").sort()).toEqual(first.certificate.canonical_path_manifest);
    expect(gitBytes(repo, ["show", `${first.certificate.candidate_sha}:binary.bin`])).toEqual(Buffer.from([0, 1, 2, 255, 0, 127]));
    expect(git(repo, ["ls-tree", first.certificate.candidate_sha, "mode.sh"]).startsWith("100755")).toBe(true);
    expect(git(repo, ["ls-tree", "--name-only", first.certificate.candidate_sha])).not.toContain("removed.txt");
    expect(reconstructReleaseControlV2Candidate(repo, first.certificate).certificate).toEqual(first.certificate);
  });

  it("fails closed instead of using a three-way merge when the canonical patch conflicts", () => {
    const { repo, base, source } = fixture();
    writeFileSync(join(repo, "commerce-domain.txt"), "conflicting production edit\n");
    const conflictingBase = commit(repo, "conflict after base");
    expect(() => materializeReleaseControlV2Candidate(repo, { production_base_sha: conflictingBase, source_commit_sha: source }))
      .toThrow("MATERIALIZATION_APPLY_FAILED");
    expect(tree(repo, base)).not.toBe(tree(repo, conflictingBase));
  });

  it("rejects merge sources and leaves refs unchanged", () => {
    const { repo, base, source } = fixture();
    git(repo, ["checkout", "-qb", "side", source]);
    writeFileSync(join(repo, "side.txt"), "side\n");
    commit(repo, "side");
    git(repo, ["checkout", "-q", "source"]);
    writeFileSync(join(repo, "source.txt"), "source\n");
    commit(repo, "source second");
    git(repo, ["merge", "--no-ff", "side", "-m", "merge source"]);
    const merge = git(repo, ["rev-parse", "HEAD"]);
    const refsBefore = git(repo, ["show-ref"]);
    expect(() => materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: merge }))
      .toThrow("MATERIALIZATION_SOURCE_NOT_SINGLE_PARENT");
    expect(git(repo, ["show-ref"])).toBe(refsBefore);
  });

  it("rejects a single-parent side-branch commit that is only reachable through a merge", () => {
    const { repo, source } = fixture();
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["merge", "--no-ff", "source", "-m", "merge side integration"]);
    const controller = git(repo, ["rev-parse", "HEAD"]);
    expect(() => assertReleaseControlV2SourceOnFirstParentIntegrationLineage(repo, source, controller))
      .toThrow("MATERIALIZATION_SOURCE_NOT_FIRST_PARENT_INTEGRATION_LINE");
  });

  it("classifies the maintenance marker as consequential before any publication can be eligible", () => {
    const { repo, base } = fixture();
    git(repo, ["checkout", "-q", "source"]);
    mkdirSync(join(repo, ".release"), { recursive: true });
    writeFileSync(join(repo, ".release/maintenance-only"), "maintenance\n");
    const source = commit(repo, "maintenance integration");
    const materialized = materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: source });
    const packet = buildReleasePacket({
      base: { sha: materialized.certificate.production_base_sha, tree: materialized.certificate.production_base_tree },
      candidate: { sha: materialized.certificate.candidate_sha, tree: materialized.certificate.candidate_tree },
      changed_paths: materialized.certificate.canonical_path_manifest,
      activation_required: false,
      materialization: materialized.certificate,
    });
    expect(packet.policy_lanes).toEqual(["RELEASE_CONTROL"]);
    expect(packet.decision).toBe("STOP_ESCALATE");
    expect(packet.required_authority).toBe("ESCALATION_REQUIRED");
  });

  it("binds the packet classifier to the actual B..C manifest and escalates sensitive source deltas", () => {
    const { repo, base } = fixture();
    git(repo, ["checkout", "-q", "source"]);
    mkdirSync(join(repo, "commerce/src"), { recursive: true });
    writeFileSync(join(repo, "commerce/src/release-control.ts"), "sensitive\n", { flag: "w" });
    const source = commit(repo, "release control integration");
    const materialized = materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: source });
    const packet = buildReleasePacket({
      base: { sha: materialized.certificate.production_base_sha, tree: materialized.certificate.production_base_tree },
      candidate: { sha: materialized.certificate.candidate_sha, tree: materialized.certificate.candidate_tree },
      changed_paths: materialized.certificate.canonical_path_manifest,
      activation_required: false,
      materialization: materialized.certificate,
    });
    expect(packet.policy_lanes).toContain("RELEASE_CONTROL");
    expect(packet.decision).toBe("STOP_ESCALATE");
  });

  it("rejects a packet certificate when a reconstructed candidate identity differs", () => {
    const { repo, base, source } = fixture();
    const materialized = materializeReleaseControlV2Candidate(repo, { production_base_sha: base, source_commit_sha: source });
    expect(() => reconstructReleaseControlV2Candidate(repo, {
      ...materialized.certificate,
      candidate_sha: "0".repeat(40),
    })).toThrow("MATERIALIZATION_CANDIDATE_SHA_MISMATCH");
  });

  it("contains no mutable Git-ref operation in the materializer implementation", () => {
    const source = readFileSync("commerce/src/release-control-v2-materializer.ts", "utf8");
    for (const forbidden of ["git push", "update-ref", "symbolic-ref", " branch ", " tag ", "checkout", "cherry-pick", "rebase", "--3way"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
