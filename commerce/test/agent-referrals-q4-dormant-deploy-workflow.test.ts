import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const Q4_TREE = "5e122dc8e4fbb5811fb98e27813c1b0883e15911";
const Q3_RELEASE = `agent-referrals-recovery-${Q3}`;
const Q4_RELEASE = `agent-referrals-q4-dormant-${Q4}`;
const CERTIFICATE = `.release/controlled-candidates/agent-referrals-activation-${Q3}/certificate.json`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-q4-dormant-deploy.yml", "utf8");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("Agent Referrals Q3 to Q4 DORMANT deployment controller", () => {
  it("is manual-only, production-gated, serialized, and holds the dedicated production pointer credential", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    for (const automatic of ["push:", "schedule:", "workflow_run:"]) expect(trigger).not.toContain(automatic);
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("PRODUCTION_DEPLOY_REF_TOKEN");
    expect(workflow).toContain("AGENT_REFERRALS_Q4_DEPLOY_REF_TOKEN_REQUIRED");
  });

  it("binds the exact controller, reconstructs detached Q4, and permits only its exact authority chain", () => {
    for (const value of [Q2, Q3, Q4, Q4_TREE, Q3_RELEASE, Q4_RELEASE]) expect(workflow).toContain(value);
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain("AGENT_REFERRALS_Q4_DORMANT_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain('agent-referrals-activation-$BASE_SHA/certificate.json');
    expect(workflow).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(workflow).toContain('.patch_source == "controller_tree"');
    expect(workflow).toContain('SOURCE_MAIN_SHA="$(jq -er \'.source_main_sha\' candidate-certificate.json)"');
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain('controlled-candidate-verify.ts candidate-certificate.json "$GITHUB_SHA"');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^")" == "$BASE_SHA"');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^{tree}")" == "$TARGET_TREE"');
    expect(workflow).toContain("diff certified-manifest.txt actual-changed-paths.txt");
    for (const forbidden of ["commerce/migrations/", "public/legal/", "commerce/legal/", "\\.github/workflows/"]) expect(workflow).toContain(forbidden);
    for (const ref of ["runtime-candidate", "runtime/agent-referrals-1", "runtime/agent-referrals-recovery-1", "runtime/agent-referrals-activation-1"]) expect(workflow).toContain(`refs/heads/${ref}`);
  });

  it("classifies only the allowed durable states, preserves ordinary sales, and moves the Q3 pointer before exact-Q4 deployment", () => {
    for (const state of ["FRESH", "OWNED_PRE_CAS", "OWNED_POST_CAS", "PREPARED", "ALREADY_TERMINALIZED"]) expect(workflow).toContain(`DEPLOYMENT_STATE=${state}`);
    expect(workflow).toContain("AGENT_REFERRALS_Q4_DORMANT_OWNER_STATE_UNEXPECTED");
    expect(workflow).toContain('.owner_mode == "ROLLING" and .sales_paused == false');
    const candidateRead = workflow.lastIndexOf("refs/heads/runtime-candidate");
    const acquire = workflow.indexOf("/v1/internal/release-control/acquire");
    expect(candidateRead).toBeGreaterThan(-1);
    expect(candidateRead).toBeLessThan(acquire);
    expect(workflow.slice(acquire)).not.toContain("refs/heads/runtime-candidate");
    expect(workflow).not.toContain('"/pause"');
    expect(workflow).toContain('scripts/set-production-deploy-ref.sh "$TARGET_SHA" "$BASE_SHA"');
    expect(workflow.indexOf("Guarded Q3 to Q4 production pointer transition")).toBeLessThan(workflow.indexOf("Deploy exact Q4 and wait for all runtime surfaces"));
    expect(workflow).toContain('scripts/controlled-coolify-deploy.sh "$TARGET_SHA"');
    expect(workflow).not.toContain("git checkout $TARGET_SHA");
  });

  it("uses the documented status projection after acquire while retaining full expectation equality for terminal completion", () => {
    expect(workflow).toContain("q4-gate-projection.json");
    expect(workflow).toContain("{source_commit,migration,legal_version,legal_manifest_sha256}");
    expect(workflow).toContain("--slurpfile gate q4-gate-projection.json");
    expect(workflow).toContain(".expected == $gate[0].expected");
    expect(workflow).not.toContain(".expected == $release[0].expected' status.json");
    expect(workflow).not.toContain(".expected == $release[0].expected' acquired.json");
    expect(workflow).toContain("--slurpfile release q4-release.json '.expected == $release[0].expected' q4-completion.json");
  });

  it("proves Q3 terminal predecessor and full Q4 DORMANT readiness, but never terminalizes or activates", () => {
    expect(workflow).toContain("q3-completion.json");
    expect(workflow).toContain("q2-resolution.json");
    expect(workflow).toContain('.resolution == "SUPERSEDED" and .replacement_source_commit == $q3');
    expect(workflow).toContain("q3-readiness-result.json");
    expect(workflow).toContain("q4-dormant-readiness.json");
    expect(workflow).toContain(".ready == true");
    expect(workflow).toContain("migration_source_hashes");
    expect(workflow).not.toContain("complete-rolling");
    expect(workflow).not.toContain("/agent-referrals/activate");
    expect(workflow).not.toContain("controlled-agent-referrals-activation.yml");
    expect(workflow).not.toContain("gh workflow run");
  });

  it("reconstructs the actual certified Q4 in an isolated controller checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "q4-dormant-deploy-workflow-"));
    try {
      git(process.cwd(), "clone", "--no-checkout", process.cwd(), root);
      git(root, "checkout", "--detach", "HEAD");
      symlinkSync(resolve("node_modules"), join(root, "node_modules"));
      const controller = git(root, "rev-parse", "HEAD");
      const reconstructed = spawnSync("node", ["--import", "tsx", "commerce/src/controlled-candidate-verify.ts", CERTIFICATE, controller], { cwd: root, encoding: "utf8" });
      expect(reconstructed.status, reconstructed.stderr).toBe(0);
      expect(reconstructed.stdout.trim()).toBe(Q4);
      expect(git(root, "rev-parse", `${Q4}^`)).toBe(Q3);
      expect(git(root, "rev-parse", `${Q4}^{tree}`)).toBe(Q4_TREE);
      const manifest = JSON.parse(readFileSync(join(root, CERTIFICATE), "utf8")) as { paths: Array<{ path: string }> };
      expect(git(root, "diff", "--name-only", Q3, Q4).split("\n").filter(Boolean).sort()).toEqual(manifest.paths.map(({ path }) => path).sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
