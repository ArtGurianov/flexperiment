import { describe, expect, it } from "vitest";
import { deployMode, readinessExpectation, type ReleaseCandidate, type ReleaseClass } from "../../src/release/candidate";

const candidate = (releaseClass: ReleaseClass): ReleaseCandidate => ({
  id: `candidate-${releaseClass}`,
  sha: "a".repeat(40),
  releaseClass,
  expectation: { schemaInventory: "sha256:" + "b".repeat(64), legalVersion: "2026-09-20.1", legalManifestSha256: "c".repeat(64) },
});

describe("release candidate", () => {
  it("earns the rolling path only through an explicit proof of compatibility", () => {
    // The default has to be the expensive one. A release nobody classified is a
    // release nobody proved the previous revision can read, and deploying that
    // without closing sales is how a checkout meets a schema it cannot parse.
    expect(deployMode(candidate("ROLLING_COMPATIBLE"))).toBe("ROLLING_SAFE");
    expect(deployMode(candidate("MAINTENANCE_REQUIRED"))).toBe("MAINTENANCE_CUTOVER");
  });

  it("derives readiness source identity from the candidate SHA", () => {
    const release = candidate("MAINTENANCE_REQUIRED");
    expect(release.expectation).not.toHaveProperty("sourceCommit");
    expect(readinessExpectation(release)).toEqual({ ...release.expectation, sourceCommit: release.sha });
  });
});
