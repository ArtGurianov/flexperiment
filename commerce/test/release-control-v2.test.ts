import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildReleasePacket, canonicalReleasePacket, classifyReleasePaths, validateReleasePacket } from "../src/release-control-v2";
import {
  RELEASE_CONTROL_V2_COMMIT_METADATA,
  RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
  RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
  type ReleaseControlV2MaterializationCertificate,
} from "../src/release-control-v2-materializer";

const base = { sha: "1".repeat(40), tree: "2".repeat(40) };
const candidate = { sha: "3".repeat(40), tree: "4".repeat(40) };
const source = { sha: "5".repeat(40), tree: "6".repeat(40) };
const sourceParent = { sha: "7".repeat(40), tree: "8".repeat(40) };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const materialization = (changed_paths: readonly string[]): ReleaseControlV2MaterializationCertificate => {
  const manifest = [...new Set(changed_paths)].sort();
  const message = [
    "Release Control v2 materialized candidate",
    "",
    `source: ${source.sha}`,
    `source-parent: ${sourceParent.sha}`,
    `production-base: ${base.sha}`,
    `materializer: ${RELEASE_CONTROL_V2_MATERIALIZER_VERSION}`,
  ].join("\n");
  return {
    schema_version: RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
    production_base_sha: base.sha,
    production_base_tree: base.tree,
    source_commit_sha: source.sha,
    source_commit_tree: source.tree,
    source_parent_sha: sourceParent.sha,
    source_parent_tree: sourceParent.tree,
    canonical_path_manifest: manifest,
    path_manifest_sha256: hash(JSON.stringify(manifest)),
    patch_format_version: RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
    patch_sha256: "9".repeat(64),
    candidate_sha: candidate.sha,
    candidate_tree: candidate.tree,
    candidate_parent_sha: base.sha,
    commit_metadata: { ...RELEASE_CONTROL_V2_COMMIT_METADATA, message },
    materializer_version: RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  };
};
const packet = (changed_paths: readonly string[], activation_required = false) => buildReleasePacket({
  base,
  candidate,
  changed_paths,
  activation_required,
  materialization: materialization(changed_paths),
});

describe("Release Control v2 Phase 1 shadow packet", () => {
  it("is deterministic, sealed to exact identities, and has no production authority", () => {
    const first = packet(["README.md", "docs/guide.md"]);
    const second = packet(["docs/guide.md", "README.md", "README.md"]);
    expect(canonicalReleasePacket(first)).toBe(canonicalReleasePacket(second));
    expect(first).toMatchObject({
      schema_version: "release-control-v2-packet-v2",
      mode: "SHADOW_ONLY",
      production_authority: "NONE",
      mutations: "FORBIDDEN",
      release_id: `shadow-${candidate.sha}`,
      base_sha: base.sha,
      base_tree: base.tree,
      candidate_sha: candidate.sha,
      candidate_tree: candidate.tree,
      base,
      candidate,
      diff_manifest: ["README.md", "docs/guide.md"],
      certificate: {
        schema_version: "release-control-v2-certificate-v2",
        base_sha: base.sha,
        base_tree: base.tree,
        candidate_sha: candidate.sha,
        candidate_tree: candidate.tree,
        diff_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        materialization_schema_version: RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
      },
      materialization: expect.objectContaining({
        production_base_sha: base.sha,
        candidate_sha: candidate.sha,
      }),
      expected_deploy_target: candidate.sha,
      candidate_publication_ref: `refs/heads/runtime/release-control-v2-${candidate.sha}`,
      generated_workflows: [],
      historical_synthesis: false,
      mutation_plan: null,
    });
    expect(first.semantic_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.stop_conditions).toEqual([]);
    expect(validateReleasePacket(JSON.parse(canonicalReleasePacket(first)))).toEqual(first);
  });

  it.each([
    ["migration", ["commerce/migrations/0050_example.sql"], ["MIGRATION"]],
    ["legal", ["public/legal/privacy-policy.md"], ["LEGAL"]],
    ["financial compatibility primitive", ["commerce/src/promo-pricing.ts"], ["FINANCIAL", "COMPATIBILITY"]],
    ["attribution", ["commerce/src/agent-referrals-attribution.ts"], ["ATTRIBUTION"]],
    ["surface", ["release-surface-contract.json"], ["SURFACE"]],
    ["compatibility", ["commerce/src/crypto.ts"], ["COMPATIBILITY"]],
    ["benign", ["README.md"], ["BENIGN"]],
  ] as const)("classifies %s paths conservatively", (_name, paths, expected) => {
    expect(classifyReleasePaths(paths)).toEqual(expected);
  });

  it("treats the Q7 schema seam as a RELEASE_CONTROL historical fixture and stops", () => {
    const q7 = packet(["commerce/src/release-control-schema.ts"], true);
    expect(q7).toMatchObject({
      policy_lanes: ["RELEASE_CONTROL"],
      decision: "STOP_ESCALATE",
      production_authority: "NONE",
      required_authority: "ESCALATION_REQUIRED",
      activation_required: true,
      generated_workflows: [],
      historical_synthesis: false,
      mutation_plan: null,
    });
    expect(q7.stop_conditions).toContain("NO_AUTONOMOUS_EXECUTION");
  });

  it("does not let mixed sensitive paths collapse into a less restrictive lane", () => {
    const mixed = packet(["README.md", "commerce/migrations/0050_example.sql", "commerce/src/release-control.ts"]);
    expect(mixed.policy_lanes).toEqual(["MIGRATION", "RELEASE_CONTROL"]);
    expect(mixed.decision).toBe("STOP_ESCALATE");
  });

  it("fails closed on malformed immutable evidence", () => {
    expect(() => buildReleasePacket({ base: { ...base, sha: "not-a-sha" }, candidate, changed_paths: [], activation_required: false, materialization: materialization([]) })).toThrow("RELEASE_PACKET_BASE_IDENTITY_INVALID");
    expect(() => packet(["../commerce/src/release-control.ts"])).toThrow("RELEASE_PACKET_DIFF_MANIFEST_INVALID");
    const tampered = { ...packet(["README.md"]), semantic_hash: "0".repeat(64) };
    expect(() => validateReleasePacket(tampered)).toThrow("RELEASE_PACKET_HASH_MISMATCH");
    expect(() => validateReleasePacket({ ...packet(["README.md"]), unreviewed: true })).toThrow("RELEASE_PACKET_SCHEMA_INVALID");
    expect(() => buildReleasePacket({
      base,
      candidate,
      changed_paths: ["README.md"],
      activation_required: false,
      materialization: materialization(["docs/not-the-candidate-path.md"]),
    })).toThrow("RELEASE_PACKET_MATERIALIZATION_MISMATCH");
  });

  it("escalates an unregistered release-prefixed runtime seam instead of assuming it is BENIGN", () => {
    expect(packet(["commerce/src/release-new-meaning.ts"])).toMatchObject({
      policy_lanes: ["COMPATIBILITY"],
      decision: "STOP_ESCALATE",
    });
  });

  it("uses a closed runtime registry so Agent Referrals authority cannot inherit BENIGN by omission", () => {
    expect(classifyReleasePaths(["commerce/src/agent-referrals-act.ts"])).toEqual(["FINANCIAL"]);
    expect(classifyReleasePaths(["commerce/src/agent-referrals-unreviewed-authority.ts"])).toEqual(["COMPATIBILITY"]);
    expect(classifyReleasePaths(["commerce/src/unreviewed-runtime-authority.ts"])).toEqual(["COMPATIBILITY"]);
    expect(classifyReleasePaths(["commerce/src/domain.ts"])).toEqual(["BENIGN"]);
  });

  it("escalates every present Agent Referrals runtime module unless it has an explicit sensitive lane", () => {
    const paths = readdirSync("commerce/src")
      .filter((name) => /^agent-referrals-.*\.ts$/.test(name))
      .map((name) => `commerce/src/${name}`);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(classifyReleasePaths([path])).not.toEqual(["BENIGN"]);
  });

  it("has no mutation-capable Phase 1 dependency or executable authority surface", () => {
    const source = readFileSync("commerce/src/release-control-v2.ts", "utf8");
    for (const forbidden of ["node:child_process", "node:fs", "fetch(", "openDatabase", "process.env", ".github/workflows", "Coolify", "git push", "curl "]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain("release-control-v2-materializer");
  });
});
