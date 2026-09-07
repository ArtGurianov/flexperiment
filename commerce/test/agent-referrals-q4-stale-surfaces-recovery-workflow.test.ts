import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const Q4_TREE = "5e122dc8e4fbb5811fb98e27813c1b0883e15911";
const Q4_RELEASE = `agent-referrals-q4-dormant-${Q4}`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-q4-stale-surfaces-recovery.yml", "utf8");
const helper = resolve("scripts/release/recover-agent-referrals-q4-stale-surfaces.sh");
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const runHelper = (commerce: string, frontend: string, production = Q4) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-referrals-q4-stale-surfaces-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin"); const outcomes = join(directory, "outcomes.json"); const curlLog = join(directory, "curl.log");
  mkdirSync(bin); writeFileSync(curlLog, "");
  const git = join(bin, "git"); const curl = join(bin, "curl");
  writeFileSync(git, `#!/usr/bin/env bash\n[[ "$1 $2 $3" == "ls-remote --exit-code origin" ]] || exit 2\nprintf '%s\\trefs/heads/production-deploy\\n' '${production}'\n`);
  writeFileSync(curl, [
    "#!/usr/bin/env bash", "set -euo pipefail", 'printf "%s\\n" "$*" >> "$CURL_LOG"', 'url="${!#}"',
    `case "$url" in https://commerce.test/hook) value='${commerce}';; https://frontend.test/hook) value='${frontend}';; *) exit 2;; esac`,
    '[[ "$value" == TRANSPORT ]] && exit 28', 'printf "%s" "$value"', "",
  ].join("\n"));
  chmodSync(git, 0o755); chmodSync(curl, 0o755);
  const result = spawnSync("bash", [helper], { cwd: directory, encoding: "utf8", env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_LOG: curlLog, COOLIFY_TOKEN: "test-token",
    COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL: "https://commerce.test/hook", COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL: "https://frontend.test/hook", COOLIFY_Q4_STALE_SURFACES_OUTCOMES: outcomes,
  } });
  return { result, curlLog: readFileSync(curlLog, "utf8"), outcomes: existsSync(outcomes) ? readFileSync(outcomes, "utf8") : "" };
};

describe("Agent Referrals Q4 stale-surfaces recovery controller", () => {
  it("is manual-only, production-gated, serialized, and hard-binds the exact incident", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    for (const automatic of ["push:", "schedule:", "workflow_run:", "inputs:"]) expect(trigger).not.toContain(automatic);
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("group: flexperiment-production-controlled-cutover");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    for (const identity of [Q3, Q4, Q4_TREE, Q4_RELEASE]) expect(workflow).toContain(identity);
    expect(workflow).toContain("AGENT_REFERRALS_Q4_STALE_SURFACES_CONTROLLER_MAIN_MOVED");
  });

  it("allows a consequence only for the exact Q3/Q4 incident, and treats all other topology as fail-closed", () => {
    const precondition = workflow.slice(workflow.indexOf("- name: Prove exact stalled"), workflow.indexOf("- name: Enqueue one-shot"));
    expect(precondition).toContain('"$runtime_source" == "$BASE_SHA"');
    expect(precondition).toContain('"$worker_source" == "$BASE_SHA"');
    expect(precondition).toContain('"$frontend_source" == "$BASE_SHA"');
    expect(precondition).toContain('"$admin_source" == "$TARGET_SHA"');
    expect(precondition).toContain('"$health" == true && "$ready" == true');
    expect(precondition).toContain("RECOVERY_STATE=ALREADY_CONVERGED");
    expect(precondition).toContain("AGENT_REFERRALS_Q4_STALE_SURFACES_TOPOLOGY_UNEXPECTED");
    expect(precondition).toContain("AGENT_REFERRALS_Q4_STALE_SURFACES_AUTHORITY_MISMATCH");
    expect(precondition).toContain("AGENT_REFERRALS_Q4_STALE_SURFACES_COMPLETION_MISMATCH");
  });

  it("has no generic release authority mutation, admin webhook, terminalization, or activation path", () => {
    for (const forbidden of [
      "set-production-deploy-ref.sh", "runtime-candidate", "/release-control/acquire", "/release-control/complete-rolling", "/agent-referrals/activate", "COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL", "controlled-coolify-deploy.sh",
    ]) expect(workflow).not.toContain(forbidden);
    expect(workflow).toContain("recover-agent-referrals-q4-stale-surfaces.sh");
    expect(workflow).toContain("observe-agent-referrals-q4-convergence.sh");
    expect(workflow).toContain("agent-referrals/dormant-readiness");
  });

  it("executes exactly one independent request for each stale target and preserves an ambiguous outcome", () => {
    const { result, curlLog, outcomes } = runHelper("202", "503");
    expect(result.status, result.stderr).toBe(0);
    expect((curlLog.match(/commerce\.test\/hook/g) ?? [])).toHaveLength(1);
    expect((curlLog.match(/frontend\.test\/hook/g) ?? [])).toHaveLength(1);
    expect(outcomes).toContain('"service":"commerce","outcome":"ACCEPTED"');
    expect(outcomes).toContain('"service":"frontend","outcome":"UNKNOWN"');
  });

  it("classifies a 4xx independently and still attempts the other stale surface", () => {
    const { result, curlLog, outcomes } = runHelper("400", "204");
    expect(result.status, result.stderr).toBe(0);
    expect((curlLog.match(/commerce\.test\/hook/g) ?? [])).toHaveLength(1);
    expect((curlLog.match(/frontend\.test\/hook/g) ?? [])).toHaveLength(1);
    expect(outcomes).toContain('"service":"commerce","outcome":"KNOWN_FAILED"');
    expect(outcomes).toContain('"service":"frontend","outcome":"ACCEPTED"');
  });

  it("records a transport-ambiguous request as UNKNOWN and never retries it", () => {
    const { result, curlLog, outcomes } = runHelper("TRANSPORT", "202");
    expect(result.status, result.stderr).toBe(0);
    expect((curlLog.match(/commerce\.test\/hook/g) ?? [])).toHaveLength(1);
    expect((curlLog.match(/frontend\.test\/hook/g) ?? [])).toHaveLength(1);
    expect(outcomes).toContain('"service":"commerce","outcome":"UNKNOWN"');
    expect(outcomes).toContain('"service":"frontend","outcome":"ACCEPTED"');
  });

  it("refuses before both webhooks when production-deploy is no longer exact Q4", () => {
    const { result, curlLog } = runHelper("202", "202", Q3);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_REFERRALS_Q4_STALE_SURFACES_PRODUCTION_POINTER_MISMATCH");
    expect(curlLog).toBe("");
  });
});
