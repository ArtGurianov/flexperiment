import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const Q4_TREE = "5e122dc8e4fbb5811fb98e27813c1b0883e15911";
const CERTIFICATE = `.release/controlled-candidates/agent-referrals-activation-${Q3}/certificate.json`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-activation-candidate.yml", "utf8");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("Agent Referrals Q4 activation-capability candidate publication workflow", () => {
  it("is manual-only, production-gated, serialized, and holds only a dedicated publication credential", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    expect(trigger).not.toContain("push:");
    expect(trigger).not.toContain("schedule:");
    expect(trigger).not.toContain("workflow_run:");
    for (const input of ["generation", "expected_target_sha"]) expect(trigger).toMatch(new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_REF_TOKEN");
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_REF_TOKEN_REQUIRED");
    expect(workflow).not.toContain("GITHUB_TOKEN");
  });

  it("binds current main and every frozen Q2/Q3/Q4 authority before a create-only publication", () => {
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain('[[ "$INPUT_GENERATION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]');
    expect(workflow).toContain('[[ "$TARGET_SHA" =~ ^[a-f0-9]{40}$ ]]');
    expect(workflow).toContain(`FIXED_Q2: ${Q2}`);
    expect(workflow).toContain(`BASE_SHA: ${Q3}`);
    expect(workflow).toContain(`FIXED_Q4: ${Q4}`);
    expect(workflow).toContain(`FIXED_Q4_TREE: ${Q4_TREE}`);
    for (const ref of ["production-deploy", "runtime-candidate", "runtime/agent-referrals-1", "runtime/agent-referrals-recovery-1"]) expect(workflow).toContain(`refs/heads/${ref}`);
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_PRODUCTION_NOT_Q3");
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_RUNTIME_CANDIDATE_NOT_Q3");
    expect(workflow).toContain('agent-referrals-activation-$BASE_SHA/certificate.json');
    expect(workflow).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(workflow).toContain(".base_sha == $base");
    expect(workflow).toContain('.patch_source == "controller_tree"');
    expect(workflow).toContain('SOURCE_MAIN_SHA="$(jq -er \'.source_main_sha\' candidate-certificate.json)"');
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain('controlled-candidate-verify.ts candidate-certificate.json "$GITHUB_SHA"');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$FIXED_Q4" ]]');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^")" == "$BASE_SHA"');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^{tree}")" == "$FIXED_Q4_TREE"');
    expect(workflow).toContain("diff certified-manifest.txt actual-changed-paths.txt");
    expect(workflow).toContain("commerce/migrations/");
    expect(workflow).toContain("public/legal/");
    expect(workflow).toContain("commerce/legal/");
    expect(workflow).toContain("\\.github/workflows/");
  });

  it("publishes only a flat ref with an absent-ref lease, refuses collision, and reads every authority back", () => {
    expect(workflow).toContain("PUBLISH_REF=refs/heads/runtime/agent-referrals-activation-${INPUT_GENERATION}");
    expect(workflow).not.toContain("runtime/agent-referrals/activation/");
    expect(workflow).not.toContain("runtime/agent-referrals-activation/");
    expect(workflow).toContain('git push --force-with-lease="${PUBLISH_REF}:" origin "${RECONSTRUCTED_SHA}:${PUBLISH_REF}"');
    expect(workflow).toContain("GENERATION_ALREADY_PUBLISHED_DIFFERENT_SHA");
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_SAME_SHA_REPLAY");
    expect(workflow).toContain('published="$(read_remote_ref "$PUBLISH_REF")"');
    expect(workflow).toContain('[[ "$published" == "$FIXED_Q4" ]]');
    expect(workflow).toContain("AGENT_REFERRALS_ACTIVATION_CANDIDATE_POST_AUTHORITY_MISMATCH");
    expect(workflow).not.toContain("set-production-deploy-ref.sh");
    expect(workflow).not.toContain("gh workflow run");
    expect(workflow).not.toContain("COOLIFY_");
    expect(workflow).not.toContain("/agent-referrals/activate");
  });

  it("reconstructs Q4 and proves its flat publication ref is discoverable by the existing promotion search", () => {
    const root = mkdtempSync(join(tmpdir(), "q4-publication-workflow-"));
    try {
      git(process.cwd(), "clone", "--no-checkout", process.cwd(), root);
      git(root, "checkout", "--detach", "HEAD");
      symlinkSync(resolve("node_modules"), join(root, "node_modules"));
      const controllerSha = git(root, "rev-parse", "HEAD");
      const reconstructed = spawnSync("node", ["--import", "tsx", "commerce/src/controlled-candidate-verify.ts", CERTIFICATE, controllerSha], { cwd: root, encoding: "utf8" });
      expect(reconstructed.status, reconstructed.stderr).toBe(0);
      expect(reconstructed.stdout.trim()).toBe(Q4);
      expect(git(root, "rev-parse", `${Q4}^`)).toBe(Q3);
      expect(git(root, "rev-parse", `${Q4}^{tree}`)).toBe(Q4_TREE);
      const manifest = JSON.parse(readFileSync(join(root, CERTIFICATE), "utf8")) as { paths: Array<{ path: string }> };
      expect(git(root, "diff", "--name-only", Q3, Q4).split("\n").filter(Boolean).sort()).toEqual(manifest.paths.map(({ path }) => path).sort());
      for (const { path } of manifest.paths) expect(path).not.toMatch(/^(commerce\/migrations\/|public\/legal\/|commerce\/legal\/|\.github\/workflows\/)/);
      git(root, "update-ref", "refs/remotes/origin/runtime/agent-referrals-activation-1", Q4);
      const discovered = git(root, "for-each-ref", "--format=%(refname:short)", "--contains", Q4, "refs/remotes/origin/runtime/*");
      expect(discovered.split("\n")).toContain("origin/runtime/agent-referrals-activation-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
