import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EPOCH_A_PRODUCTION_BASE_SHA, EPOCH_A_RUNTIME_SHA, EPOCH_A_RUNTIME_TAG_OBJECT, EPOCH_A_RUNTIME_TAG_REF } from "../src/epoch-a-runtime-promotion";
import { canonicalMigrationInventory } from "../src/release-expectation";

const workflow = readFileSync(".github/workflows/controlled-epoch-a-runtime-promotion.yml", "utf8");
const setter = readFileSync("scripts/set-production-deploy-ref.sh", "utf8");
const policy = readFileSync("commerce/src/epoch-a-runtime-promotion.ts", "utf8");
const at = (needle: string) => {
  const index = workflow.indexOf(needle);
  expect(index, `workflow contains ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe("controlled Epoch A dormant runtime promotion", () => {
  it("is a production-gated, manually dispatched, hard-bound compatibility controller", () => {
    const dispatch = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(dispatch).toContain("workflow_dispatch:");
    expect(dispatch).toContain("options: [prepare, complete]");
    expect(dispatch).not.toContain("target_sha:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(`EPOCH_A_RUNTIME_SHA: ${EPOCH_A_RUNTIME_SHA}`);
    expect(workflow).toContain(`EPOCH_A_PRODUCTION_BASE_SHA: ${EPOCH_A_PRODUCTION_BASE_SHA}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_REF: ${EPOCH_A_RUNTIME_TAG_REF}`);
    expect(workflow).toContain(`EPOCH_A_RUNTIME_TAG_OBJECT: ${EPOCH_A_RUNTIME_TAG_OBJECT}`);
    expect(workflow).toContain('[[ "$(git rev-parse "$EPOCH_A_RUNTIME_TAG_REF")" == "$EPOCH_A_RUNTIME_TAG_OBJECT" ]]');
    expect(workflow).toContain('[[ "$(git rev-parse "$EPOCH_A_RUNTIME_TAG_REF^{}")" == "$EPOCH_A_RUNTIME_SHA" ]]');
    expect(workflow).toContain('[[ "$(git rev-list --parents -n 1 "$EPOCH_A_RUNTIME_SHA" | awk \'NF == 2 {print $2}\')" == "$EPOCH_A_PRODUCTION_BASE_SHA" ]]');
    expect(workflow).toContain("EPOCH_A_CONTROLLER_CONTAMINATES_R");
    expect(workflow).toContain(".release/maintenance-only");
  });

  it("binds only the dedicated production-deploy credential before every controlled remote ref seam", () => {
    const checkout = at("uses: actions/checkout@v4");
    const binding = at("Bind dedicated production-deploy credential");
    const firstRemoteRead = at("git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main");
    const cas = at("CAS production-deploy from Gen2 to exact R");
    const bindingEnd = workflow.indexOf("\n\n      - name:", binding);
    expect(bindingEnd).toBeGreaterThan(binding);
    const shell = workflow
      .slice(workflow.indexOf("          set -euo pipefail", binding), bindingEnd)
      .replaceAll(/^          /gm, "");

    expect(checkout).toBeLessThan(binding);
    expect(binding).toBeLessThan(firstRemoteRead);
    expect(firstRemoteRead).toBeLessThan(cas);
    expect(workflow).toContain("persist-credentials: false");
    expect(shell).toContain('[[ -n "$PRODUCTION_DEPLOY_REF_TOKEN" ]]');
    expect(shell).toContain("PRODUCTION_DEPLOY_REF_TOKEN_REQUIRED");
    expect(shell).toContain("git config --local --unset-all http.https://github.com/.extraheader || true");
    expect(shell).toContain('git remote set-url origin "https://x-access-token:${PRODUCTION_DEPLOY_REF_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"');
    expect(shell).not.toContain("GITHUB_TOKEN");

    const directory = mkdtempSync(join(tmpdir(), "flexperiment-epoch-a-deploy-credential-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/placeholder/repository.git"], { cwd: directory });
      expect(() => execFileSync("bash", ["-euo", "pipefail", "-c", shell], {
        cwd: directory,
        stdio: "pipe",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "ArtGurianov/flexperiment",
          PRODUCTION_DEPLOY_REF_TOKEN: "",
        },
      })).toThrow();
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: directory, encoding: "utf8" }).trim()).toBe(
        "https://github.com/placeholder/repository.git",
      );
      execFileSync("bash", ["-euo", "pipefail", "-c", shell], {
        cwd: directory,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "ArtGurianov/flexperiment",
          PRODUCTION_DEPLOY_REF_TOKEN: "test-production-deploy-token",
        },
      });
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: directory, encoding: "utf8" }).trim()).toBe(
        "https://x-access-token:test-production-deploy-token@github.com/ArtGurianov/flexperiment.git",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses runtime-candidate only to admit a fresh acquire, never same-owner recovery", () => {
    const candidateChecks = workflow.match(/git fetch --no-tags origin refs\/heads\/runtime-candidate/g) ?? [];
    expect(candidateChecks).toHaveLength(2);
    expect(at("Prove fresh runtime-candidate declaration before acquire")).toBeLessThan(at("Reconfirm candidate immediately before acquire"));
    expect(at("Reconfirm candidate immediately before acquire")).toBeLessThan(at("Acquire owner and pause sales"));
    expect(workflow).toContain("EPOCH_A_FRESH_OWNER_POINTER_NOT_BASE");
  });

  it("never checks out or executes the candidate tree", () => {
    expect(workflow).not.toContain("git worktree add");
    expect(workflow).not.toContain("RUNTIME_ASSERT_DIR");
    expect(workflow).not.toContain("Materialize exact R readiness parser");
    expect(workflow).toContain("EPOCH_A_CONTROLLER_CAPABILITY_CLOSURE_MISMATCH");
  });

  it("keeps pre-B legal evidence and dormant capability as a separate compatibility proof", () => {
    expect(workflow).toContain("EPOCH_A_PRE_B_LEGAL_OR_DORMANCY_INVALID");
    expect(workflow).toContain("occurrence_notifications_available == false");
    expect(policy).toContain("EPOCH_A_FUTURE_LEGAL_RELEASE_ACTIVE");
    expect(workflow).toContain("assert-epoch-a-runtime-promotion-ready.ts");
    expect(workflow).toContain("EPOCH_A_R_CROSSES_SCHEMA_LEGAL_OR_SURFACE_BOUNDARY");
    expect(workflow).toContain("EPOCH_A_MIGRATION_0038_HASH_CHANGED");
    expect(workflow).toContain("EPOCH_A_R_LEGAL_SOURCE_BASELINE_MISMATCH");
    expect(workflow).toContain("EPOCH_A_R_LEGAL_SOURCE_CONVERGENCE_MISMATCH");
  });

  it("pauses before the CAS/deploy seam and never automatically reopens during prepare", () => {
    const acquire = at("Acquire owner and pause sales");
    const pause = at("Prove pause and independently unchanged emergency state");
    const cas = at("CAS production-deploy from Gen2 to exact R");
    const deploy = at("Enqueue exact R deployment");
    const convergence = at("Prove R convergence and dormant product evidence");
    const complete = at("Complete only after explicit GO and fresh dormant evidence");
    expect(acquire).toBeLessThan(pause);
    expect(pause).toBeLessThan(cas);
    expect(cas).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(convergence);
    expect(convergence).toBeLessThan(complete);
    expect(workflow).toContain("env.INPUT_STAGE == 'complete' && env.EPOCH_A_ACTION == 'READY_TO_COMPLETE'");
    expect(workflow).not.toContain("/v1/admin/emergency-sales/");
  });

  it("takes a full fresh compatibility snapshot before spending the pointer CAS", () => {
    const preCas = at("Reprove Epoch A compatibility authority immediately before CAS or R deployment");
    const cas = at("CAS production-deploy from Gen2 to exact R");
    expect(at("Prove pause and independently unchanged emergency state")).toBeLessThan(preCas);
    expect(preCas).toBeLessThan(cas);
    expect(workflow).toContain("EPOCH_A_PRE_CAS_DURABLE_AUTHORITY_MISMATCH");
    expect(workflow).toContain("EPOCH_A_PRE_CAS_LEGAL_OR_DORMANCY_INVALID");
    expect(workflow).toContain("EPOCH_A_PRE_DEPLOY_POINTER_UNEXPECTED");
    expect(workflow).toContain("EPOCH_A_PRE_CAS_RUNTIME_NOT_BASE");
    expect(workflow).toContain(".expected == ($request[0].expected | del(.legal_hashes))");
    expect(workflow).toContain("env.PRODUCTION_POINTER_PRE_CAS == env.EPOCH_A_PRODUCTION_BASE_SHA");
  });

  it("uses one executable LF inventory canonicalizer before and immediately before CAS", () => {
    const names = ["0039_after.sql", "0038_before.sql", "0040_last.sql"];
    const canonical = canonicalMigrationInventory(names);
    const escapedDelimiter = [...names].sort().join("\\n");
    expect(canonical).toBe("0038_before.sql\n0039_after.sql\n0040_last.sql");
    expect(escapedDelimiter).toBe("0038_before.sql\\n0039_after.sql\\n0040_last.sql");
    expect(escapedDelimiter).not.toBe(canonical);
    expect(workflow.match(/canonicalMigrationInventory\(versions\)/g)).toHaveLength(2);
    expect(workflow).not.toContain('join("\\\\n")');
  });

  it("uses an expected-old-pointer CAS and has no rollback or old 0041 path", () => {
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$EPOCH_A_RUNTIME_SHA" "$EPOCH_A_PRODUCTION_BASE_SHA"');
    expect(setter).toContain('expected_previous_source_commit="${2:-}"');
    expect(setter).toContain("PRODUCTION_DEPLOY_EXPECTED_PREVIOUS_POINTER_MISMATCH");
    expect(workflow).not.toContain("controlled-0041");
    expect(workflow).not.toContain("classify_pre_activation_defect");
    expect(workflow).not.toContain("git push --force");
  });
});
