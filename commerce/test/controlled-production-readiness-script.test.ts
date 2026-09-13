import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The script answers two different questions and must keep them apart:
 *
 *   poll -> convergence -> stop polling -> one-shot admission -> pass/fail
 *
 * Observable surfaces legitimately lag a deployment, so only they are
 * retryable. Sales state, owner identity, migration expectation and legal
 * evidence do not change by waiting, so the admission assertion runs exactly
 * once, after convergence, and any failure is terminal - see
 * docs/release/DEPLOYMENT_INVARIANTS.md, "A read-only convergence loop must
 * not collapse a parser exception into 'not converged yet'".
 *
 * These tests assert that *execution topology*, not the script's formatting:
 * the fake `node` records every invocation together with the number of status
 * polls that had already happened, so "ran once" and "ran after convergence"
 * are both observed facts rather than a grep for an assertion outside a loop.
 */

const sourceCommit = "a".repeat(40);
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

type Scenario = "ready" | "status-fails-after-first" | "rolling-then-status-fails" | "converges-on-third" | "never-converges";

type Options = {
  scenario?: Scenario;
  admissionFails?: boolean;
  phase?: "promotion" | "candidate-pre-publication";
  pinRuntimeParser?: boolean;
  pollAttempts?: string;
};

const runReadiness = ({ scenario = "ready", admissionFails = false, phase = "promotion", pinRuntimeParser = false, pollAttempts = "2" }: Options = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-readiness-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const request = join(directory, "release.json");
  const curlLog = join(directory, "curl.log");
  const nodeLog = join(directory, "node.log");
  const nodeCwdLog = join(directory, "node-cwd.log");
  // One line per `node` invocation, recording how many status polls had
  // already completed at that moment. This is what proves ordering.
  const nodePollLog = join(directory, "node-poll.log");
  const statusCalls = join(directory, "status-calls");
  const curl = join(bin, "curl");
  const node = join(bin, "node");
  const sleep = join(bin, "sleep");
  const runtimeAssertDir = join(directory, "runtime-assert");
  mkdirSync(bin);
  if (pinRuntimeParser) mkdirSync(runtimeAssertDir);
  writeFileSync(request, JSON.stringify({
    release_id: `deploy-${sourceCommit}`,
    mode: "CONTROLLED_CUTOVER",
    expected: {
      source_commit: sourceCommit,
      migration: "0034_worker_sweep_evidence.sql",
      legal_version: "2026-08-25.1",
      legal_manifest_sha256: "b".repeat(64),
      legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
    },
  }));
  const convergedRuntime = JSON.stringify({
    source_commit: sourceCommit,
    worker_source_commit: sourceCommit,
    worker_started_at: "2026-09-13T10:00:00Z",
    worker_observed_at: "2026-09-13T10:00:30Z",
    worker_last_successful_sweep_at: "2026-09-13T10:00:20Z",
  });
  // Still rolling: the API has not been replaced yet, so it reports the
  // predecessor's source. Exactly the state a deployment passes through.
  const rollingRuntime = JSON.stringify({
    source_commit: "9".repeat(40),
    worker_source_commit: "9".repeat(40),
    worker_started_at: null,
    worker_observed_at: null,
    worker_last_successful_sweep_at: null,
  });
  writeFileSync(curlLog, ""); writeFileSync(nodeLog, ""); writeFileSync(nodePollLog, ""); writeFileSync(statusCalls, "0");
  writeFileSync(curl, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'output=""',
    'for ((index=1; index <= $#; index++)); do',
    '  if [[ "${!index}" == "--output" ]]; then next=$((index + 1)); output="${!next}"; fi',
    "done",
    'url="${!#}"',
    "printf '%s\\n' \"$url\" >> \"$CURL_LOG\"",
    'if [[ "$url" == "https://api.test/v1/internal/release-control/status" ]]; then',
    '  calls="$(cat "$STATUS_CALLS")"; calls=$((calls + 1)); printf "%s" "$calls" > "$STATUS_CALLS"',
    '  if [[ "$READINESS_SCENARIO" == "status-fails-after-first" && "$calls" -gt 1 ]]; then exit 28; fi',
    '  if [[ "$READINESS_SCENARIO" == "rolling-then-status-fails" && "$calls" -gt 1 ]]; then exit 28; fi',
    '  runtime="$CONVERGED_RUNTIME"',
    '  if [[ "$READINESS_SCENARIO" == "never-converges" || "$READINESS_SCENARIO" == "rolling-then-status-fails" ]]; then runtime="$ROLLING_RUNTIME"; fi',
    '  if [[ "$READINESS_SCENARIO" == "converges-on-third" && "$calls" -lt 3 ]]; then runtime="$ROLLING_RUNTIME"; fi',
    `  printf '{"sales_paused":true,"owner_release_id":"deploy-${sourceCommit}","runtime":%s}' "$runtime" > "$output"; exit 0`,
    "fi",
    'case "$url" in',
    `  https://frontend.test/release.json) body='{"source_commit":"${sourceCommit}","checkout_contract_version":"age-band-v2"}' ;;`,
    `  https://admin.test/release.json) body='{"source_commit":"${sourceCommit}","admin_contract_version":"age-band-v2"}' ;;`,
    `  https://api.test/v1/public/legal-config) body='{"version":"2026-08-25.1","manifest":{"documents":{"PUBLIC_OFFER":{"sha256":"${"c".repeat(64)}"},"PRIVACY_POLICY":{"sha256":"${"d".repeat(64)}"},"PD_CONSENT":{"sha256":"${"e".repeat(64)}"},"CHECKOUT_DISCLOSURE":{"sha256":"${"f".repeat(64)}"}}}}' ;;`,
    '  https://api.test/healthz|https://api.test/readyz) body=\'{"ok":true}\' ;;',
    "  *) exit 22 ;;",
    "esac",
    "printf '%s' \"$body\" > \"$output\"",
    "",
  ].join("\n"));
  writeFileSync(node, [
    "#!/usr/bin/env bash",
    "pwd >> \"$NODE_CWD_LOG\"",
    "printf '%s\\n' \"$*\" >> \"$NODE_LOG\"",
    "printf '%s\\n' \"$(cat \"$STATUS_CALLS\")\" >> \"$NODE_POLL_LOG\"",
    'for argument in "$@"; do [[ "$argument" != *.json || -f "$argument" ]] || { echo "MISSING_JSON_ARGUMENT=$argument" >&2; exit 1; }; done',
    '[[ "$READINESS_ADMISSION_FAILS" == "1" ]] && { echo "WORKER_SWEEP_EVIDENCE_STALE" >&2; exit 1; }',
    "exit 0",
    "",
  ].join("\n"));
  writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(curl, 0o755); chmodSync(node, 0o755); chmodSync(sleep, 0o755);
  const result = spawnSync("bash", [resolve(process.cwd(), "scripts/controlled-production-readiness.sh"), "release.json", phase], {
    cwd: directory, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_LOG: curlLog, NODE_LOG: nodeLog, STATUS_CALLS: statusCalls,
      NODE_POLL_LOG: nodePollLog, CONVERGED_RUNTIME: convergedRuntime, ROLLING_RUNTIME: rollingRuntime,
      READINESS_SCENARIO: scenario, READINESS_ADMISSION_FAILS: admissionFails ? "1" : "0", NODE_CWD_LOG: nodeCwdLog,
      PUBLIC_API_URL: "https://api.test", PUBLIC_FRONTEND_URL: "https://frontend.test", ADMIN_RELEASE_URL: "https://admin.test/release.json",
      COMMERCE_RELEASE_CONTROL_TOKEN: "test-token", TARGET_SHA: sourceCommit, CHECKOUT_CONTRACT_VERSION: "age-band-v2", ADMIN_CONTRACT_VERSION: "age-band-v2", PREVIOUS_LEGAL_VERSION: "2026-08-25.1", POLL_ATTEMPTS: pollAttempts, POLL_SECONDS: "0", POLL_CONNECT_TIMEOUT: "3", POLL_MAX_TIME: "7", ...(pinRuntimeParser ? { RUNTIME_ASSERT_DIR: runtimeAssertDir } : {}),
    },
  });
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  return {
    result,
    curlLog: readFileSync(curlLog, "utf8"),
    nodeLog: readFileSync(nodeLog, "utf8"),
    nodeCwds: existsSync(nodeCwdLog) ? readFileSync(nodeCwdLog, "utf8") : "",
    admissionRuns: lines(nodeLog).length,
    pollsBeforeEachAdmission: lines(nodePollLog).map(Number),
    statusPolls: Number(readFileSync(statusCalls, "utf8")),
  };
};

describe("controlled production readiness: convergence and admission are separate", () => {
  it("admits once every surface has converged", () => {
    const { result, curlLog, nodeLog, admissionRuns } = runReadiness();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Readiness attempt 1/2: CONVERGED");
    expect(result.stdout).toContain("Readiness: ADMITTED");
    expect(nodeLog).toContain("--import tsx commerce/src/assert-generic-production-deploy-ready.ts");
    expect(admissionRuns).toBe(1);
    expect(curlLog).toContain("https://api.test/healthz");
    expect(curlLog).toContain("https://api.test/readyz");
    expect(curlLog).not.toContain("reopen");
  });

  it("runs the promotion admission from a supplied exact runtime worktree", () => {
    const { result, nodeCwds } = runReadiness({ pinRuntimeParser: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(nodeCwds.trim().endsWith("/runtime-assert")).toBe(true);
  });

  it("proves candidate surfaces against the previous active legal release before publication", () => {
    const { result, nodeLog, admissionRuns } = runReadiness({ phase: "candidate-pre-publication" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(nodeLog).toContain("--import tsx commerce/src/assert-candidate-runtime-ready.ts");
    expect(nodeLog).toContain("0034_worker_sweep_evidence.sql 2026-08-25.1");
    expect(admissionRuns).toBe(1);
  });

  it("keeps polling while the runtime is still rolling, then admits exactly once", () => {
    const { result, admissionRuns, pollsBeforeEachAdmission, statusPolls } = runReadiness({ scenario: "converges-on-third", pollAttempts: "5" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("SURFACES_CONVERGING (GENERIC_DEPLOY_RUNTIME_SOURCE_NOT_CONVERGED)");
    expect(result.stdout).toContain("Readiness attempt 3/5: CONVERGED");
    // Ran once, and only after the third poll - the one that converged.
    expect(admissionRuns).toBe(1);
    expect(pollsBeforeEachAdmission).toEqual([3]);
    // Polling stopped at convergence rather than running out the budget.
    expect(statusPolls).toBe(3);
  });

  it("never runs the admission when observable state never converges", () => {
    const { result, admissionRuns } = runReadiness({ scenario: "never-converges" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("READINESS_POLL_EXHAUSTED: GENERIC_DEPLOY_RUNTIME_SOURCE_NOT_CONVERGED");
    expect(admissionRuns).toBe(0);
  });

  it("does not reuse a prior status file after the next attempt fetch fails", () => {
    const { result, admissionRuns } = runReadiness({ scenario: "rolling-then-status-fails", admissionFails: true });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Readiness attempt 1/2: SURFACES_CONVERGING (GENERIC_DEPLOY_RUNTIME_SOURCE_NOT_CONVERGED)");
    expect(result.stdout).toContain("Readiness attempt 2/2: GENERIC_DEPLOY_READINESS_FETCH_FAILED:status fetch failed (curl exit 28)");
    expect(result.stderr).toContain("READINESS_POLL_EXHAUSTED: GENERIC_DEPLOY_READINESS_FETCH_FAILED:status fetch failed (curl exit 28)");
    // Attempt 1's status must not be carried into attempt 2 and admitted:
    // the failed fetch is not convergence, so admission never runs at all.
    expect(admissionRuns).toBe(0);
    expect(result.stderr).not.toContain("WORKER_SWEEP_EVIDENCE_STALE");
  });

  it("treats a refused admission as terminal, with its own exit code, and never retries it", () => {
    const { result, admissionRuns, statusPolls } = runReadiness({ admissionFails: true, pollAttempts: "5" });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("READINESS_ADMISSION_REFUSED");
    expect(result.stderr).toContain("Admission diagnostic:");
    expect(result.stderr).toContain("WORKER_SWEEP_EVIDENCE_STALE");
    expect(result.stderr).not.toContain("READINESS_POLL_EXHAUSTED");
    // The defining property: a deterministic refusal is not re-attempted, and
    // does not consume the remaining poll budget.
    expect(admissionRuns).toBe(1);
    expect(statusPolls).toBe(1);
  });

  it("separates configuration errors from both convergence and admission", () => {
    const { result } = runReadiness({ phase: "bogus-phase" as unknown as "promotion" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("READINESS_PHASE_INVALID");
  });
});
