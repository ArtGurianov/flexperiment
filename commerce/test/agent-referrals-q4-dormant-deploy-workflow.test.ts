import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const observer = resolve("scripts/release/observe-agent-referrals-q4-convergence.sh");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

const runObserver = (scenario: "converges" | "wrong-owner") => {
  const directory = mkdtempSync(join(tmpdir(), "agent-referrals-q4-observe-"));
  const bin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  const curlLog = join(directory, "curl.log");
  const statusCalls = join(directory, "status-calls");
  const summary = join(directory, "summary.md");
  mkdirSync(bin); mkdirSync(scripts);
  writeFileSync(curlLog, ""); writeFileSync(statusCalls, "0");
  writeFileSync(join(scripts, "read-production-deploy-ref.sh"), `#!/usr/bin/env bash\nprintf '%s\\n' '${Q4}'\n`);
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(bin, "curl"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'printf "%s\\n" "$*" >> "$CURL_LOG"',
    'output=""',
    'for ((index=1; index <= $#; index++)); do if [[ "${!index}" == "--output" ]]; then next=$((index + 1)); output="${!next}"; fi; done',
    'url="${!#}"',
    `expected='{"source_commit":"${Q4}","migration":"inventory-sha256:test","legal_version":"2026-09-01.1","legal_manifest_sha256":"${"a".repeat(64)}"}'`,
    `if [[ "$url" == "https://api.test/v1/internal/release-control/status" ]]; then calls="$(cat "$STATUS_CALLS")"; calls=$((calls + 1)); printf "%s" "$calls" > "$STATUS_CALLS"; owner="${Q4_RELEASE}"; [[ "$OBSERVE_SCENARIO" == wrong-owner ]] && owner=other-release; source="${Q3}"; [[ "$calls" -ge 3 ]] && source="${Q4}"; body="{\\"owner_release_id\\":\\"$owner\\",\\"owner_mode\\":\\"ROLLING\\",\\"sales_paused\\":false,\\"expected\\":$expected,\\"runtime\\":{\\"source_commit\\":\\"$source\\",\\"worker_source_commit\\":\\"$source\\"}}"; printf "%s" "$body" > "$output"; printf 200; exit 0; fi`,
    `if [[ "$url" == "https://api.test/v1/internal/release-control/completion/${Q4_RELEASE}" ]]; then printf '{"complete":false,"expected":%s}' "$expected" > "$output"; printf 200; exit 0; fi`,
    `case "$url" in https://api.test/healthz|https://api.test/readyz) body='{"ok":true}' ;; https://frontend.test/release.json|https://admin.test/release.json) calls="$(cat "$STATUS_CALLS")"; source="${Q3}"; [[ "$calls" -ge 3 ]] && source="${Q4}"; body="{\\"source_commit\\":\\"$source\\"}" ;; *) exit 22 ;; esac`,
    '[[ -n "$output" ]] && { printf "%s" "$body" > "$output"; printf 200; } || printf "%s" "$body"',
    "",
  ].join("\n"));
  for (const file of [join(scripts, "read-production-deploy-ref.sh"), join(bin, "sleep"), join(bin, "curl")]) chmodSync(file, 0o755);
  const result = spawnSync("bash", [observer], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_LOG: curlLog, STATUS_CALLS: statusCalls, OBSERVE_SCENARIO: scenario,
      TARGET_SHA: Q4, Q4_RELEASE_ID: Q4_RELEASE, Q4_MIGRATION: "inventory-sha256:test", POLL_ATTEMPTS: "3", POLL_SECONDS: "0",
      PUBLIC_API_URL: "https://api.test", PUBLIC_FRONTEND_URL: "https://frontend.test", ADMIN_RELEASE_URL: "https://admin.test/release.json", COMMERCE_RELEASE_CONTROL_TOKEN: "test-token", GITHUB_STEP_SUMMARY: summary,
    },
  });
  const output = { result, curlLog: readFileSync(curlLog, "utf8"), summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
  rmSync(directory, { recursive: true, force: true });
  return output;
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
    expect(workflow.indexOf("Guarded Q3 to Q4 production pointer transition")).toBeLessThan(workflow.indexOf("Enqueue exact Q4 deployment only after a new Q3 to Q4 CAS"));
    expect(workflow).toContain('scripts/controlled-coolify-deploy.sh "$TARGET_SHA"');
    expect(workflow).not.toContain("git checkout $TARGET_SHA");

    const acquireStep = workflow.slice(workflow.indexOf("- name: Acquire exact Q4 ROLLING owner"), workflow.indexOf("- name: Reconfirm exact Q3 to Q4 CAS authority"));
    const preCasStep = workflow.slice(workflow.indexOf("- name: Reconfirm exact Q3 to Q4 CAS authority"), workflow.indexOf("- name: Guarded Q3 to Q4 production pointer transition"));
    expect(acquireStep).toContain("if: env.DEPLOYMENT_STATE == 'FRESH'");
    expect(preCasStep).toContain("env.DEPLOYMENT_STATE == 'OWNED_PRE_CAS'");
  });

  it("offers a bounded read-only observe operation and treats Q3 runtime lag as retryable, not an authority failure", () => {
    const observe = workflow.slice(workflow.indexOf("  observe:"), workflow.indexOf("  deploy:"));
    expect(workflow).toContain("options: [observe, resume]");
    expect(workflow).toContain("default: observe");
    expect(observe).toContain("if: inputs.operation == 'observe'");
    expect(observe).toContain("POLL_ATTEMPTS=30 POLL_SECONDS=10");
    expect(observe).toContain("observe-agent-referrals-q4-convergence.sh");
    const observerSource = readFileSync(observer, "utf8");
    expect(observerSource).toContain("for attempt in $(seq 1 \"$poll_attempts\")");
    expect(observerSource).toContain("AGENT_REFERRALS_Q4_OBSERVE_AUTHORITY_MISMATCH");
    expect(observerSource).toContain("AGENT_REFERRALS_Q4_OBSERVE_CONVERGENCE_TIMEOUT");
    expect(observerSource).toContain('[[ "$(scripts/read-production-deploy-ref.sh)" == "$TARGET_SHA" ]]');
    expect(observerSource).toContain('api "$PUBLIC_API_URL/v1/internal/release-control/status"');
    expect(observerSource).toContain('api "$PUBLIC_API_URL/v1/internal/release-control/completion/$Q4_RELEASE_ID"');
    expect(observerSource).toContain("initial-completion.json");
    expect(observerSource).toContain("select(.expected.source_commit == $source and .expected.migration == $migration)");
    for (const forbidden of ["-X POST", "controlled-coolify-deploy.sh", "set-production-deploy-ref.sh", "PRODUCTION_DEPLOY_REF_TOKEN", "runtime-candidate"]) expect(observerSource).not.toContain(forbidden);
  });

  it("executes a read-only Q3-to-Q4 convergence observation without classifying runtime lag as an authority failure", () => {
    const { result, curlLog, summary } = runObserver("converges");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Q4_STILL_CONVERGING attempt=1");
    expect(result.stdout).not.toContain("AUTHORITY_MISMATCH");
    expect(summary).toContain("classification: CONVERGED_Q4");
    expect(summary).toContain("mutations performed: NONE");
    expect(curlLog).toContain("https://api.test/v1/internal/release-control/status");
    expect(curlLog).toContain(`https://api.test/v1/internal/release-control/completion/${Q4_RELEASE}`);
    expect(curlLog).toContain("https://api.test/healthz");
    expect(curlLog).toContain("https://api.test/readyz");
    expect(curlLog).toContain("https://frontend.test/release.json");
    expect(curlLog).toContain("https://admin.test/release.json");
    expect(curlLog).not.toContain("-X POST");
  });

  it("fails immediately on a wrong held owner without probing convergence surfaces", () => {
    const { result, curlLog } = runObserver("wrong-owner");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_REFERRALS_Q4_OBSERVE_AUTHORITY_MISMATCH");
    expect(curlLog).not.toContain("/healthz");
    expect(curlLog).not.toContain("/release.json");
  });

  it("does not retrigger Coolify from an OWNED_POST_CAS recovery", () => {
    const enqueue = workflow.slice(workflow.indexOf("- name: Enqueue exact Q4 deployment"), workflow.indexOf("- name: Wait for exact Q4 convergence"));
    expect(enqueue).toContain("env.DEPLOYMENT_STATE == 'FRESH' || env.DEPLOYMENT_STATE == 'OWNED_PRE_CAS'");
    expect(enqueue).not.toContain("OWNED_POST_CAS");
    const wait = workflow.slice(workflow.indexOf("- name: Wait for exact Q4 convergence"), workflow.indexOf("- name: Prove unchanged Q4 migration"));
    expect(wait).toContain("AGENT_REFERRALS_Q4_DORMANT_CONVERGENCE_TIMEOUT");
    expect(wait).toContain("if ! jq -e --arg q4 \"$TARGET_SHA\" '.runtime.source_commit == $q4 and .runtime.worker_source_commit == $q4'");
    expect(wait).toContain("AGENT_REFERRALS_Q4_DORMANT_CONVERGENCE_AUTHORITY_MISMATCH");
  });

  it("uses the documented status projection after acquire while retaining full expectation equality for terminal completion", () => {
    expect(workflow).toContain("q4-gate-projection.json");
    expect(workflow).toContain("{source_commit,migration,legal_version,legal_manifest_sha256}");
    expect(workflow).toContain("--slurpfile gate q4-gate-projection.json");
    expect(workflow).toContain(".expected == $gate[0].expected");
    expect(workflow.match(/\.expected == \$gate\[0\]\.expected/g)).toHaveLength(6);
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
