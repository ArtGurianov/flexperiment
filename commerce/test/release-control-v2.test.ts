import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildReleasePacket, canonicalReleasePacket, classifyReleasePaths } from "../src/release-control-v2";

const base = { sha: "1".repeat(40), tree: "2".repeat(40) };
const candidate = { sha: "3".repeat(40), tree: "4".repeat(40) };
const packet = (changed_paths: readonly string[], activation_required = false) => buildReleasePacket({ base, candidate, changed_paths, activation_required });

describe("Release Control v2 Phase 1 shadow packet", () => {
  it("is deterministic, sealed to exact identities, and has no production authority", () => {
    const first = packet(["README.md", "docs/guide.md"]);
    const second = packet(["docs/guide.md", "README.md", "README.md"]);
    expect(canonicalReleasePacket(first)).toBe(canonicalReleasePacket(second));
    expect(first).toMatchObject({
      schema_version: "release-control-v2-packet-v1",
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
      expected_deploy_target: candidate.sha,
      generated_workflows: [],
      historical_synthesis: false,
      mutation_plan: null,
    });
    expect(first.semantic_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["migration", ["commerce/migrations/0050_example.sql"], ["MIGRATION"]],
    ["legal", ["public/legal/privacy-policy.md"], ["LEGAL"]],
    ["financial", ["commerce/src/promo-pricing.ts"], ["FINANCIAL"]],
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
    expect(() => buildReleasePacket({ base: { ...base, sha: "not-a-sha" }, candidate, changed_paths: [], activation_required: false })).toThrow("RELEASE_PACKET_BASE_IDENTITY_INVALID");
    expect(() => packet(["../commerce/src/release-control.ts"])).toThrow("RELEASE_PACKET_DIFF_MANIFEST_INVALID");
  });

  it("escalates an unregistered release-prefixed runtime seam instead of assuming it is BENIGN", () => {
    expect(packet(["commerce/src/release-new-meaning.ts"])).toMatchObject({
      policy_lanes: ["COMPATIBILITY"],
      decision: "STOP_ESCALATE",
    });
  });

  it("has no mutation-capable Phase 1 dependency or executable authority surface", () => {
    const source = readFileSync("commerce/src/release-control-v2.ts", "utf8");
    for (const forbidden of ["node:child_process", "node:fs", "fetch(", "openDatabase", "process.env", ".github/workflows", "Coolify", "git push", "curl "]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
