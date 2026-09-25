import { describe, expect, it } from "vitest";
import { readinessExpectation, type ReleaseCandidate, type ReleaseClass } from "../../src/release/candidate";

const candidate = (releaseClass: ReleaseClass): ReleaseCandidate => ({
  id: `candidate-${releaseClass}`,
  sha: "a".repeat(40),
  releaseClass,
  expectation: { schemaInventory: "sha256:" + "b".repeat(64), legalVersion: "2026-09-20.1", legalManifestSha256: "c".repeat(64) },
});

describe("release candidate", () => {
  it("derives readiness source identity from the candidate SHA", () => {
    const release = candidate("MAINTENANCE_REQUIRED");
    expect(release.expectation).not.toHaveProperty("sourceCommit");
    expect(readinessExpectation(release)).toEqual({ ...release.expectation, sourceCommit: release.sha });
  });
});
