import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(".github/workflows/controlled-topology-normalization.yml", "utf8");

describe("controlled topology normalization", () => {
  it("is manual-only and binds a supplied frozen main target", () => {
    expect(source).toContain("workflow_dispatch:");
    expect(source).not.toMatch(/^\s*push:/m);
    expect(source).toContain('[[ "$TARGET_SHA" == "$(git rev-parse origin/main)" ]]');
    expect(source).toContain('[[ "$(git rev-parse "${TARGET_SHA}^{tree}")" == "$TARGET_TREE" ]]');
    expect(source).not.toContain('TARGET_SHA="$(git rev-parse HEAD)"');
  });

  it("keeps the one-time waiver controller-covered and production-base-bound", () => {
    expect(source).toContain("BASE_SHA: acfef97f15b45995e0f98a8ac0c649802c2bca9c");
    expect(source).toContain('git merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA" || { echo "NORMALIZATION_CONTROLLER_OLDER_THAN_TARGET" >&2; exit 1; }');
    expect(source).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$BASE_SHA"');
  });

  it("independently rejects every excluded boundary class", () => {
    for (const code of [
      "TOPOLOGY_NORMALIZATION_SCHEMA_CHANGED",
      "TOPOLOGY_NORMALIZATION_LEGAL_CHANGED",
      "TOPOLOGY_NORMALIZATION_SURFACE_CONTRACT_CHANGED",
      "TOPOLOGY_NORMALIZATION_COMPATIBILITY_CHANGED",
      "TOPOLOGY_NORMALIZATION_UNEXPECTED_RELEASE_SEMANTICS",
    ]) expect(source).toContain(code);
    expect(source).toContain('git diff --name-only -z "$BASE_SHA" "$TARGET_SHA" > boundary-paths.bin');
  });

  it("uses the controlled cutover primitives without applying migrations directly", () => {
    expect(source).toContain("scripts/controlled-coolify-deploy.sh");
    expect(source).toContain("scripts/controlled-production-readiness.sh");
    expect(source).not.toContain("commerce:migrate");
    expect(source).not.toContain("commerce/src/migrate.ts");
  });
});
