import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const Q5 = "b153ed226770a947cdbf9cd83e1a9c1181b7cf6f";
const Q5_TREE = "4b8a9b16299e4f57add486453e51f9855ac7df93";
const CERTIFICATE = `.release/controlled-candidates/agent-referrals-activation-${Q4}/certificate.json`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-activation-reconciliation-candidate.yml", "utf8");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("Agent Referrals Q5 activation-reconciliation candidate publication workflow", () => {
  it("is manual-only, production-gated, serialized, and holds only a dedicated publication credential", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    for (const forbidden of ["push:", "schedule:", "workflow_run:"]) expect(trigger).not.toContain(forbidden);
    for (const input of ["generation", "expected_target_sha"]) expect(trigger).toMatch(new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+required: true`));
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_REF_TOKEN");
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_REF_TOKEN_REQUIRED");
    expect(workflow).not.toContain("GITHUB_TOKEN");
  });

  it("binds exact current main, frozen Q4 authority, the predecessor publication chain, and the certified Q4-to-Q5 reconstruction", () => {
    expect(workflow).toContain('[[ "$GITHUB_REF" == refs/heads/main ]]');
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_CONTROLLER_MAIN_MOVED");
    expect(workflow).toContain(`FIXED_Q2: ${Q2}`);
    expect(workflow).toContain(`FIXED_Q3: ${Q3}`);
    expect(workflow).toContain(`BASE_SHA: ${Q4}`);
    expect(workflow).toContain(`FIXED_Q5: ${Q5}`);
    expect(workflow).toContain(`FIXED_Q5_TREE: ${Q5_TREE}`);
    for (const ref of ["production-deploy", "runtime-candidate", "runtime/agent-referrals-1", "runtime/agent-referrals-recovery-1", "runtime/agent-referrals-activation-1"]) expect(workflow).toContain(`refs/heads/${ref}`);
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_PRODUCTION_NOT_Q4");
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_RUNTIME_CANDIDATE_NOT_Q4");
    expect(workflow).toContain('agent-referrals-activation-$BASE_SHA/certificate.json');
    expect(workflow).toContain('git show "$GITHUB_SHA:.release/controlled-candidates/agent-referrals-activation-$BASE_SHA/certificate.json" > candidate-certificate.json');
    expect(workflow).toContain('.patch_source == "controller_tree"');
    expect(workflow).toContain('SOURCE_MAIN_SHA="$(jq -er \'.source_main_sha\' candidate-certificate.json)"');
    expect(workflow).toContain('git merge-base --is-ancestor "$SOURCE_MAIN_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain('controlled-candidate-verify.ts candidate-certificate.json "$GITHUB_SHA"');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$FIXED_Q5" ]]');
    expect(workflow).toContain('[[ "$RECONSTRUCTED_SHA" == "$TARGET_SHA" ]]');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^")" == "$BASE_SHA"');
    expect(workflow).toContain('"$(git rev-parse "${RECONSTRUCTED_SHA}^{tree}")" == "$FIXED_Q5_TREE"');
    expect(workflow).toContain("diff certified-manifest.txt actual-changed-paths.txt");
    for (const forbidden of ["commerce/migrations/", "public/legal/", "commerce/legal/", "\\.github/workflows/"]) expect(workflow).toContain(forbidden);
  });

  it("rebinds main and every protected authority immediately before a single-family, lease-backed publication", () => {
    const publish = workflow.indexOf("Create or reconcile the single immutable Q5 publication ref");
    const push = workflow.indexOf('git push --force-with-lease="${PUBLISH_REF}:" origin "${RECONSTRUCTED_SHA}:${PUBLISH_REF}"');
    expect(publish).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(publish);
    const finalBind = workflow.slice(publish, push);
    for (const token of ["AGENT_REFERRALS_Q5_CANDIDATE_PRE_PUBLISH_CONTROLLER_MAIN_MOVED", "PRE_PUBLISH_PRODUCTION_MOVED", "PRE_PUBLISH_RUNTIME_CANDIDATE_MOVED", "PRE_PUBLISH_Q2_MOVED", "PRE_PUBLISH_Q3_MOVED", "PRE_PUBLISH_Q4_MOVED"]) expect(finalBind).toContain(token);
    expect(finalBind).not.toMatch(/curl|api\s*\(/);
    expect(workflow).toContain("PUBLISH_REF=refs/heads/runtime/agent-referrals-activation-reconciliation-${INPUT_GENERATION}");
    expect(workflow).toContain("refs/heads/runtime/agent-referrals-activation-reconciliation-*");
    expect(workflow).toContain("Q5_PUBLICATION_NAMESPACE_MULTIPLE_REFS");
    expect(workflow).toContain("Q5_PUBLICATION_NAMESPACE_ALREADY_OCCUPIED");
    expect(workflow).toContain("PUBLISH_PUSH_RC=$publish_push_rc");
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_SAME_SHA_REPLAY");
    expect(workflow).toContain('published="$(read_remote_ref "$PUBLISH_REF")"');
    expect(workflow).toContain('[[ "$published" == "$FIXED_Q5" ]]');
    expect(workflow).toContain("AGENT_REFERRALS_Q5_CANDIDATE_POST_AUTHORITY_MISMATCH");
  });

  it("cannot implicitly promote, deploy, terminalize, or activate", () => {
    for (const forbidden of ["set-production-deploy-ref.sh", "gh workflow run", "COOLIFY_", "/agent-referrals/activate", "complete-rolling", "/agent-referrals/acquire"]) expect(workflow).not.toContain(forbidden);
  });

  it("reconstructs exact Q5 from Q4 and demonstrates the new publication ref is discoverable by the unchanged promotion search", () => {
    const root = mkdtempSync(join(tmpdir(), "q5-publication-workflow-"));
    try {
      git(process.cwd(), "clone", "--no-checkout", process.cwd(), root);
      git(root, "checkout", "--detach", "HEAD");
      symlinkSync(resolve("node_modules"), join(root, "node_modules"));
      const controllerSha = git(root, "rev-parse", "HEAD");
      const reconstructed = spawnSync("node", ["--import", "tsx", "commerce/src/controlled-candidate-verify.ts", CERTIFICATE, controllerSha], { cwd: root, encoding: "utf8" });
      expect(reconstructed.status, reconstructed.stderr).toBe(0);
      expect(reconstructed.stdout.trim()).toBe(Q5);
      expect(git(root, "rev-parse", `${Q5}^`)).toBe(Q4);
      expect(git(root, "rev-parse", `${Q5}^{tree}`)).toBe(Q5_TREE);
      const manifest = JSON.parse(readFileSync(join(root, CERTIFICATE), "utf8")) as { paths: Array<{ path: string }> };
      expect(git(root, "diff", "--name-only", Q4, Q5).split("\n").filter(Boolean).sort()).toEqual(manifest.paths.map(({ path }) => path).sort());
      for (const { path } of manifest.paths) expect(path).not.toMatch(/^(commerce\/migrations\/|public\/legal\/|commerce\/legal\/|\.github\/workflows\/)/);
      git(root, "update-ref", "refs/remotes/origin/runtime/agent-referrals-activation-reconciliation-1", Q5);
      const discovered = git(root, "for-each-ref", "--format=%(refname:short)", "--contains", Q5, "refs/remotes/origin/runtime/*");
      expect(discovered.split("\n")).toContain("origin/runtime/agent-referrals-activation-reconciliation-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
