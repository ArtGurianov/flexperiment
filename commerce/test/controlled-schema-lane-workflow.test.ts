import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publisher = readFileSync(".github/workflows/controlled-schema-candidate-publication.yml", "utf8");
const schemaWorkflow = readFileSync(".github/workflows/controlled-schema-production-deploy.yml", "utf8");
const schemaAdmission = readFileSync(".github/actions/controlled-schema-production-deploy/action.yml", "utf8");
const execution = readFileSync(".github/actions/controlled-production-deploy-execution/action.yml", "utf8");

describe("ordinary schema lane workflow seams", () => {
  it("publishes only a deterministic immutable provenance ref after append-only schema admission", () => {
    expect(publisher).toContain("refs/heads/runtime/schema-$INPUT_TARGET_SHA");
    expect(publisher).toContain("ordinary-schema-release.ts");
    expect(publisher).toContain('git push --force-with-lease="${PUBLISH_REF}:"');
    expect(publisher).toContain("SCHEMA_PUBLICATION_REF_CONFLICT");
    expect(publisher).toContain("SCHEMA_PUBLICATION_READBACK_MISMATCH");
    expect(publisher).toContain("runtime-candidate: unchanged");
    expect(publisher).toContain("production-deploy: unchanged");
  });

  it("keeps the shared execution ordered from pause through readiness to reopen", () => {
    const acquire = execution.indexOf("Acquire owner and pause registrations");
    const deploy = execution.indexOf("Deploy exact production candidate");
    const readiness = execution.indexOf("controlled-production-readiness.sh");
    const reopen = execution.indexOf('release-control/reopen');
    expect(acquire).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(acquire);
    expect(readiness).toBeGreaterThan(deploy);
    expect(reopen).toBeGreaterThan(readiness);
    expect(execution).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$CAS_EXPECTED_PRODUCTION_DEPLOY_SHA"');
  });

  it("binds publication and both mutable pointers before schema admission reaches shared execution", () => {
    expect(schemaWorkflow).toContain("controlled-schema-production-deploy");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PUBLICATION_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PUBLICATION_NAME_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_RUNTIME_CANDIDATE_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PRODUCTION_DEPLOY_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_TARGET_NOT_COVERED_BY_CONTROLLER");
    expect(schemaAdmission).toContain("ordinary-schema-release.ts");
    expect(schemaAdmission).toContain("targetMigrationExpectation");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PRODUCTION_MIGRATION_INVENTORY_MISMATCH");
    expect(schemaAdmission).toContain("controlled-production-deploy-execution");
    expect(schemaAdmission.indexOf("ordinary-schema-release.ts")).toBeLessThan(schemaAdmission.indexOf("controlled-production-deploy-execution"));
    expect(execution).toContain("ORDINARY_DEPLOY_PUBLICATION_MOVED_SINCE_PREFLIGHT");
  });
});
