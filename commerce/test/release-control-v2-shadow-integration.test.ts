import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { genericProductionDeployBoundary, releaseSemanticsCategories } from "../src/generic-production-deploy-boundary";
import { buildReleasePacket, type ReleasePolicyLane } from "../src/release-control-v2";
import {
  RELEASE_CONTROL_V2_COMMIT_METADATA,
  RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
  RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
  type ReleaseControlV2MaterializationCertificate,
} from "../src/release-control-v2-materializer";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = (path: string, contents: string) => {
  mkdirSync(join(repo, dirname(path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
  git("add", path);
  git("commit", "-m", path);
  return { sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
};
const pathsInRange = (base: string, candidate: string) =>
  execFileSync("git", ["diff", "--name-only", base, candidate], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const materializationFor = (base: { sha: string; tree: string }, candidate: { sha: string; tree: string }, paths: readonly string[]): ReleaseControlV2MaterializationCertificate => {
  const manifest = [...new Set(paths)].sort();
  const sourceCommitSha = "a".repeat(40);
  const sourceParentSha = "b".repeat(40);
  const message = [
    "Release Control v2 materialized candidate",
    "",
    `source: ${sourceCommitSha}`,
    `source-parent: ${sourceParentSha}`,
    `production-base: ${base.sha}`,
    `materializer: ${RELEASE_CONTROL_V2_MATERIALIZER_VERSION}`,
  ].join("\n");
  return {
    schema_version: RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
    production_base_sha: base.sha,
    production_base_tree: base.tree,
    source_commit_sha: sourceCommitSha,
    source_commit_tree: "c".repeat(40),
    source_parent_sha: sourceParentSha,
    source_parent_tree: "d".repeat(40),
    canonical_path_manifest: manifest,
    path_manifest_sha256: hash(JSON.stringify(manifest)),
    patch_format_version: RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
    patch_sha256: "e".repeat(64),
    candidate_sha: candidate.sha,
    candidate_tree: candidate.tree,
    candidate_parent_sha: base.sha,
    commit_metadata: { ...RELEASE_CONTROL_V2_COMMIT_METADATA, message },
    materializer_version: RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  };
};
const packetFor = (base: { sha: string; tree: string }, candidate: { sha: string; tree: string }, paths: readonly string[]) =>
  buildReleasePacket({ base, candidate, changed_paths: paths, activation_required: false, materialization: materializationFor(base, candidate, paths) });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "release-control-v2-shadow-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "shadow@example.invalid");
  git("config", "user.name", "Release Control v2 shadow test");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("Release Control v2 shadow integration", () => {
  it.each([
    ["ordinary runtime", "commerce/src/domain.ts", "BENIGN", undefined],
    ["control plane", "commerce/src/generic-production-deploy.ts", "BENIGN", undefined],
    ["release-control", "commerce/src/release-control.ts", "RELEASE_CONTROL", "RELEASE_SEMANTICS"],
    ["compatibility", "commerce/src/crypto.ts", "COMPATIBILITY", "RELEASE_SEMANTICS"],
    ["migration", "commerce/migrations/0051_shadow.sql", "MIGRATION", "SCHEMA"],
    ["legal", "public/legal/privacy-policy.md", "LEGAL", "LEGAL"],
    ["surface", "release-surface-contract.json", "SURFACE", "SURFACE_CONTRACT"],
  ] as const)("keeps %s range classification consistent with the current boundary", (_name, path, lane, existingBoundary) => {
    const base = commit("baseline.txt", `${path}:base\n`);
    const candidate = commit(path, `${path}:candidate\n`);
    const changed = pathsInRange(base.sha, candidate.sha);
    const packet = packetFor(base, candidate, changed);

    expect(genericProductionDeployBoundary(changed)).toBe(existingBoundary);
    expect(packet.policy_lanes).toEqual([lane]);
    expect(packet.decision).toBe(lane === "BENIGN" ? "ADMIT_BENIGN_SHADOW" : "STOP_ESCALATE");
    expect(packet.production_authority).toBe("NONE");
  });

  it("preserves RELEASE_CONTROL and COMPATIBILITY as distinct escalation reasons", () => {
    const base = commit("seam-baseline.txt", "base\n");
    const candidate = commit("commerce/src/release-control-schema.ts", "q7-schema-seam\n");
    const changed = pathsInRange(base.sha, candidate.sha);
    const packet = packetFor(base, candidate, changed);

    expect(releaseSemanticsCategories(changed)).toEqual(["RELEASE_CONTROL"]);
    expect(packet.policy_lanes).toEqual(["RELEASE_CONTROL"]);
    expect(packet.decision).toBe("STOP_ESCALATE");
  });

  it("retains compatibility escalation alongside financial arithmetic lanes", () => {
    const base = commit("financial-compatibility-baseline.txt", "base\n");
    const candidate = commit("commerce/src/promo-pricing.ts", "arithmetic\n");
    const changed = pathsInRange(base.sha, candidate.sha);
    const packet = packetFor(base, candidate, changed);

    expect(genericProductionDeployBoundary(changed)).toBe("RELEASE_SEMANTICS");
    expect(packet.policy_lanes).toEqual(["FINANCIAL", "COMPATIBILITY"]);
    expect(packet.decision).toBe("STOP_ESCALATE");
  });

  it("escalates every sensitive lane in a mixed range instead of weakening the current generic refusal", () => {
    const base = commit("mixed-baseline.txt", "base\n");
    commit("commerce/migrations/0052_shadow.sql", "migration\n");
    const candidate = commit("commerce/src/release-control.ts", "release-control\n");
    const changed = pathsInRange(base.sha, candidate.sha);
    const packet = packetFor(base, candidate, changed);

    expect(genericProductionDeployBoundary(changed)).toBe("SCHEMA");
    expect(packet.policy_lanes).toEqual(["MIGRATION", "RELEASE_CONTROL"] satisfies readonly ReleasePolicyLane[]);
    expect(packet.decision).toBe("STOP_ESCALATE");
    expect(packet.stop_conditions).toContain("NO_AUTONOMOUS_EXECUTION");
  });

  it("fails closed before packet construction when sealed evidence is malformed", () => {
    expect(() => buildReleasePacket({
      base: { sha: "x", tree: "2".repeat(40) },
      candidate: { sha: "3".repeat(40), tree: "4".repeat(40) },
      changed_paths: ["README.md"],
      activation_required: false,
      materialization: materializationFor(
        { sha: "x", tree: "2".repeat(40) },
        { sha: "3".repeat(40), tree: "4".repeat(40) },
        ["README.md"],
      ),
    })).toThrow("RELEASE_PACKET_BASE_IDENTITY_INVALID");
  });
});
