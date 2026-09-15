import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const publisher = readFileSync(".github/workflows/controlled-schema-candidate-publication.yml", "utf8");
const schemaWorkflow = readFileSync(".github/workflows/controlled-schema-production-deploy.yml", "utf8");
const schemaAdmission = readFileSync(".github/actions/controlled-schema-production-deploy/action.yml", "utf8");
const execution = readFileSync(".github/actions/controlled-production-deploy-execution/action.yml", "utf8");

const preCasOwnerReuseStart = schemaAdmission.indexOf('if [[ "$deploy_state" == PRE_CAS ]]');
const preCasOwnerReuse = schemaAdmission.slice(
  preCasOwnerReuseStart,
  schemaAdmission.indexOf('\n          (cd "$RUNTIME_ASSERT_DIR"', preCasOwnerReuseStart),
);

function runPreCasOwnerReuse(durableExpectation: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "controlled-schema-pre-cas-"));
  const environment = join(directory, "github-env");
  try {
    writeFileSync(join(directory, "completion.json"), JSON.stringify({ complete: false }));
    writeFileSync(join(directory, "durable-before.json"), JSON.stringify({
      sales_paused: true,
      expected: durableExpectation,
    }));
    writeFileSync(join(directory, "release.json"), JSON.stringify({
      expected: {
        source_commit: "target",
        migration: { filenames: ["0059_schema.sql"] },
        legal_hashes: { ignored_by_durable_state: "hash" },
      },
    }));
    writeFileSync(environment, "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", [
      "deploy_state=PRE_CAS",
      "owner=deploy-target",
      "RELEASE_ID=deploy-target",
      "TARGET_SHA=target",
      `GITHUB_ENV=${environment}`,
      preCasOwnerReuse,
    ].join("\n")], { cwd: directory, encoding: "utf8" });
    return { environment: readFileSync(environment, "utf8"), result };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

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
    const defaults = execution.indexOf("Initialize shared readiness configuration");
    const acquire = execution.indexOf("Acquire owner and pause registrations");
    const deploy = execution.indexOf("Deploy exact production candidate");
    const readiness = execution.indexOf("controlled-production-readiness.sh");
    const reopen = execution.indexOf('release-control/reopen');
    expect(acquire).toBeGreaterThan(-1);
    expect(defaults).toBeGreaterThan(-1);
    expect(defaults).toBeLessThan(acquire);
    expect(deploy).toBeGreaterThan(acquire);
    expect(readiness).toBeGreaterThan(deploy);
    expect(reopen).toBeGreaterThan(readiness);
    expect(execution).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$CAS_EXPECTED_PRODUCTION_DEPLOY_SHA"');
    for (const assignment of [
      'POLL_ATTEMPTS=${POLL_ATTEMPTS:-30}',
      'POLL_SECONDS=${POLL_SECONDS:-10}',
      'POLL_CONNECT_TIMEOUT=${POLL_CONNECT_TIMEOUT:-3}',
      'POLL_MAX_TIME=${POLL_MAX_TIME:-7}',
      'INITIAL_READINESS_DELAY_SECONDS=${INITIAL_READINESS_DELAY_SECONDS:-60}',
    ]) expect(execution).toContain(assignment);
  });

  it("binds publication and both mutable pointers before schema admission reaches shared execution", () => {
    expect(schemaWorkflow).toContain("controlled-schema-production-deploy");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PUBLICATION_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PUBLICATION_NAME_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_RUNTIME_CANDIDATE_MISMATCH");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PRODUCTION_DEPLOY_STATE_INVALID");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_TARGET_NOT_COVERED_BY_CONTROLLER");
    expect(schemaAdmission).toContain("ordinary-schema-release.ts");
    expect(schemaAdmission).toContain("targetMigrationExpectation");
    expect(schemaAdmission).toContain("SCHEMA_DEPLOY_PRODUCTION_MIGRATION_INVENTORY_MISMATCH");
    expect(schemaAdmission).toContain("classify-deploy-state");
    expect(schemaAdmission).toContain("PRE_CAS)");
    expect(schemaAdmission).toContain("POST_CAS_RESUME)");
    const postCas = schemaAdmission.slice(schemaAdmission.indexOf("POST_CAS_RESUME)"), schemaAdmission.indexOf("*) echo SCHEMA_DEPLOY_STATE_CLASSIFICATION_INVALID"));
    expect(postCas).not.toContain("runtime.source_commit");
    expect(preCasOwnerReuse).toContain("SCHEMA_DEPLOY_PRE_CAS_OWNER_EXPECTATION_MISMATCH");
    expect(preCasOwnerReuse.indexOf('.expected == ($request[0].expected | del(.legal_hashes))')).toBeLessThan(preCasOwnerReuse.indexOf("echo REUSING_PAUSED_OWNER=1"));
    expect(schemaAdmission).toContain("controlled-production-deploy-execution");
    expect(schemaAdmission.indexOf("ordinary-schema-release.ts")).toBeLessThan(schemaAdmission.indexOf("controlled-production-deploy-execution"));
    expect(execution).toContain("ORDINARY_DEPLOY_PUBLICATION_MOVED_SINCE_PREFLIGHT");
  });

  it.each([
    {
      name: "reuses the matching paused owner",
      expectation: { source_commit: "target", migration: { filenames: ["0059_schema.sql"] } },
      exitCode: 0,
      environment: "REUSING_PAUSED_OWNER=1",
    },
    {
      name: "rejects a paused owner with a different migration expectation before reuse",
      expectation: { source_commit: "target", migration: { filenames: ["0058_schema.sql"] } },
      exitCode: 1,
      environment: "",
    },
  ])("PRE_CAS %s", ({ expectation, exitCode, environment }) => {
    const outcome = runPreCasOwnerReuse(expectation);
    expect(outcome.result.status, outcome.result.stderr).toBe(exitCode);
    expect(outcome.environment.trim()).toBe(environment);
    if (exitCode !== 0) expect(outcome.result.stderr).toContain("SCHEMA_DEPLOY_PRE_CAS_OWNER_EXPECTATION_MISMATCH");
  });
});
