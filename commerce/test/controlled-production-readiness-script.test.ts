import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const sourceCommit = "a".repeat(40);
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const runReadiness = (scenario: "ready" | "status-fails-after-first", nodeExit = false, phase: "promotion" | "candidate-pre-publication" = "promotion") => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-readiness-test-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const request = join(directory, "release.json");
  const curlLog = join(directory, "curl.log");
  const nodeLog = join(directory, "node.log");
  const statusCalls = join(directory, "status-calls");
  const curl = join(bin, "curl");
  const node = join(bin, "node");
  const sleep = join(bin, "sleep");
  mkdirSync(bin);
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
  writeFileSync(curlLog, ""); writeFileSync(nodeLog, ""); writeFileSync(statusCalls, "0");
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
    `  printf '%s' '{"sales_paused":true,"owner_release_id":"deploy-${sourceCommit}","runtime":{}}' > "$output"; exit 0`,
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
    "printf '%s\\n' \"$*\" >> \"$NODE_LOG\"",
    '[[ "$READINESS_NODE_EXIT" == "1" ]] && { echo "WORKER_SWEEP_EVIDENCE_STALE" >&2; exit 1; }',
    "exit 0",
    "",
  ].join("\n"));
  writeFileSync(sleep, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(curl, 0o755); chmodSync(node, 0o755); chmodSync(sleep, 0o755);
  const result = spawnSync("bash", ["scripts/controlled-production-readiness.sh", request, phase], {
    cwd: process.cwd(), encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CURL_LOG: curlLog, NODE_LOG: nodeLog, STATUS_CALLS: statusCalls,
      READINESS_SCENARIO: scenario, READINESS_NODE_EXIT: nodeExit ? "1" : "0",
      PUBLIC_API_URL: "https://api.test", PUBLIC_FRONTEND_URL: "https://frontend.test", ADMIN_RELEASE_URL: "https://admin.test/release.json",
      COMMERCE_RELEASE_CONTROL_TOKEN: "test-token", TARGET_SHA: sourceCommit, CHECKOUT_CONTRACT_VERSION: "age-band-v2", ADMIN_CONTRACT_VERSION: "age-band-v2", PREVIOUS_LEGAL_VERSION: "2026-08-25.1", POLL_ATTEMPTS: "2", POLL_SECONDS: "0", POLL_CONNECT_TIMEOUT: "3", POLL_MAX_TIME: "7",
    },
  });
  return { result, curlLog: readFileSync(curlLog, "utf8"), nodeLog: readFileSync(nodeLog, "utf8") };
};

describe("controlled production readiness polling", () => {
  it("uses direct readiness CLI and reopens nothing when all fresh surfaces pass", () => {
    const { result, curlLog, nodeLog } = runReadiness("ready");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Readiness attempt 1/2: PASS");
    expect(nodeLog).toContain("--import tsx commerce/src/assert-generic-production-deploy-ready.ts");
    expect(curlLog).toContain("https://api.test/healthz");
    expect(curlLog).toContain("https://api.test/readyz");
    expect(curlLog).not.toContain("reopen");
  });

  it("proves candidate surfaces against the previous active legal release before publication", () => {
    const { result, nodeLog } = runReadiness("ready", false, "candidate-pre-publication");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(nodeLog).toContain("--import tsx commerce/src/assert-candidate-runtime-ready.ts");
    expect(nodeLog).toContain("0034_worker_sweep_evidence.sql 2026-08-25.1");
  });

  it("does not reuse a prior status file after the next attempt fetch fails", () => {
    const { result } = runReadiness("status-fails-after-first", true);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Readiness attempt 1/2: SURFACES_CONVERGING (GENERIC_DEPLOY_RUNTIME_EVIDENCE_NOT_READY)");
    expect(result.stdout).toContain("Readiness attempt 2/2: GENERIC_DEPLOY_READINESS_FETCH_FAILED:status fetch failed (curl exit 28)");
    expect(result.stderr).toContain("READINESS_POLL_EXHAUSTED: GENERIC_DEPLOY_READINESS_FETCH_FAILED:status fetch failed (curl exit 28)");
    expect(result.stderr).not.toContain("WORKER_SWEEP_EVIDENCE_STALE");
  });

  it("prints the final safe runtime-gate diagnostic when every fetch succeeds", () => {
    const { result } = runReadiness("ready", true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("READINESS_POLL_EXHAUSTED: GENERIC_DEPLOY_RUNTIME_EVIDENCE_NOT_READY");
    expect(result.stderr).toContain("Runtime readiness diagnostic:");
    expect(result.stderr).toContain("WORKER_SWEEP_EVIDENCE_STALE");
  });
});
