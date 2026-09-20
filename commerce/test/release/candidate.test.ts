import { describe, expect, it } from "vitest";
import { deployMode, type ReleaseCandidate, type ReleaseClass } from "../../src/release/candidate";

const candidate = (releaseClass: ReleaseClass): ReleaseCandidate => ({
  id: `candidate-${releaseClass}`,
  sha: "a".repeat(40),
  releaseClass,
  expectation: { sourceCommit: "a".repeat(40), schemaInventory: "sha256:" + "b".repeat(64), legalVersion: "2026-09-20.1", legalManifestSha256: "c".repeat(64) },
});

describe("release candidate", () => {
  it("earns the rolling path only through an explicit proof of compatibility", () => {
    // The default has to be the expensive one. A release nobody classified is a
    // release nobody proved the previous revision can read, and deploying that
    // without closing sales is how a checkout meets a schema it cannot parse.
    expect(deployMode(candidate("ROLLING_COMPATIBLE"))).toBe("ROLLING_SAFE");
    expect(deployMode(candidate("MAINTENANCE_REQUIRED"))).toBe("MAINTENANCE_CUTOVER");
  });

  it("never lets the launch baseline be rolling", () => {
    // It replaces the database underneath the running revision, so there is no
    // interval during which both lineages are servable.
    expect(deployMode(candidate("LAUNCH_BASELINE"))).toBe("MAINTENANCE_CUTOVER");
  });
});
