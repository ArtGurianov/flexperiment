import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const Q7 = "ce66d23fdcea5fc84018be43cf428270ea889ee8";
const RELEASE = `deploy-${Q7}`;
const ACTIVATION = `agent-referrals-activation-${Q7}`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-q7-activation.yml", "utf8");
const verifier = readFileSync("scripts/release/assert-agent-referrals-q6-activation-evidence.sh", "utf8");

const runBlock = (name: string) => {
  const step = `      - name: ${name}\n`;
  const start = workflow.indexOf(step);
  expect(start, `missing workflow step ${name}`).toBeGreaterThanOrEqual(0);
  const run = workflow.indexOf("        run: |\n", start);
  const next = workflow.indexOf("\n      - name:", run);
  return workflow.slice(run + "        run: |\n".length, next === -1 ? undefined : next)
    .split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
};

const reconcile = runBlock("Reconcile exact Q7 activation evidence");
const completion = {
  complete: true,
  expected: {
    source_commit: Q7,
    migration: "inventory-sha256:test",
    legal_version: "2026-08-28.1",
    legal_manifest_sha256: "a".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "b".repeat(64) },
  },
};
const dormant = {
  feature_state: { state: "DORMANT", owner_id: null, revision: 1 },
  last_feature_state_event: null,
  activation_manifest: null,
};
const active = {
  feature_state: { state: "ACTIVE", owner_id: ACTIVATION, revision: 2 },
  last_feature_state_event: {
    from_state: "DORMANT", to_state: "ACTIVE", owner_id: ACTIVATION,
    reason: "AGENT_REFERRALS_ACTIVATION_V1", revision: 2,
  },
  activation_manifest: {
    version: "agent-referrals-activation-v1",
    activation_id: ACTIVATION,
    terminal_release_id: RELEASE,
    source_commit: Q7,
    migration: completion.expected.migration,
    legal_version: completion.expected.legal_version,
    legal_manifest_sha256: completion.expected.legal_manifest_sha256,
    otp_pepper_sha256: "c".repeat(64),
    otp_delivery_provider: "unisender-go",
  },
};

type Forensics = {
  state: unknown;
  mode?: "FRESH" | "EXACT_REPLAY";
  curlRc?: string;
  httpStatus?: string;
  contentType?: string;
  kind?: string;
  safeCode?: string;
  bodySha?: string;
};

const executeReconciliation = (input: Forensics) => {
  const root = mkdtempSync(join(tmpdir(), "q7-activation-reconcile-"));
  const workspace = join(root, "workspace");
  try {
    mkdirSync(join(workspace, "scripts", "release"), { recursive: true });
    mkdirSync(join(root, "scripts", "release"), { recursive: true });
    writeFileSync(join(root, "completion-before.json"), JSON.stringify(completion));
    writeFileSync(join(root, "activation-fixture.json"), JSON.stringify(input.state));
    writeFileSync(join(root, "completion-fixture.json"), JSON.stringify(completion));
    writeFileSync(join(workspace, "scripts", "release", "release-api.sh"), `api() {
      case "$1" in
        */agent-referrals/activation-state) cat "$FIXTURE_ACTIVATION" ;;
        */completion/*) cat "$FIXTURE_COMPLETION" ;;
        *) return 64 ;;
      esac
    }
`);
    const verifierPath = join(root, "scripts", "release", "assert-agent-referrals-q6-activation-evidence.sh");
    writeFileSync(verifierPath, verifier);
    chmodSync(verifierPath, 0o755);
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", reconcile], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        PUBLIC_API_URL: "https://api.test",
        RELEASE_ID: RELEASE,
        ACTIVATION_ID: ACTIVATION,
        TARGET_SHA: Q7,
        EXPECTED_FEATURE_REVISION: "1",
        ACTIVATION_MODE: input.mode ?? "FRESH",
        ACTIVATION_POST_CURL_RC: input.curlRc ?? "0",
        ACTIVATION_POST_HTTP_STATUS: input.httpStatus ?? "200",
        ACTIVATION_POST_RESPONSE_CONTENT_TYPE: input.contentType ?? "application/json",
        ACTIVATION_POST_RESPONSE_BODY_EMPTY: input.kind === "EMPTY" ? "true" : "false",
        ACTIVATION_POST_RESPONSE_KIND: input.kind ?? "JSON",
        ACTIVATION_POST_SAFE_ERROR_CODE: input.safeCode ?? "NO_SAFE_CODE",
        ACTIVATION_POST_RESPONSE_SHA256: input.bodySha ?? "d".repeat(64),
        FIXTURE_ACTIVATION: join(root, "activation-fixture.json"),
        FIXTURE_COMPLETION: join(root, "completion-fixture.json"),
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("Agent Referrals Q7 activation forensic controller", () => {
  it("keeps the fresh path at exactly one POST and captures only safe response metadata", () => {
    expect(workflow.match(/-X POST --data-binary @activation-request\.json/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/retry|while .*curl|until .*curl/i);
    for (const value of [
      "curl_rc=$?", "ACTIVATION_POST_CURL_RC", "ACTIVATION_POST_HTTP_STATUS",
      "ACTIVATION_POST_RESPONSE_CONTENT_TYPE", "ACTIVATION_POST_RESPONSE_KIND",
      "ACTIVATION_POST_RESPONSE_BODY_EMPTY",
      "ACTIVATION_POST_SAFE_ERROR_CODE", "ACTIVATION_POST_RESPONSE_SHA256",
      "response_body_kind=JSON", "response_body_kind=NON_JSON", "response_body_kind=EMPTY",
      "UNPARSEABLE_JSON", "UNSAFE_ERROR_CODE", "NO_SAFE_CODE",
    ]) expect(workflow).toContain(value);
    expect(workflow).not.toContain("cat activation-post.json");
    expect(workflow).not.toContain("AGENT_REFERRALS_Q7_ACTIVATION_OUTCOME_UNKNOWN");
  });

  it("executes the exact reconciliation block for 2xx plus exact ACTIVE evidence", () => {
    const result = executeReconciliation({ state: active });
    expect(result.status).toBe(0);
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILED_ACTIVE");
  });

  it.each([
    ["5xx", { curlRc: "0", httpStatus: "503", safeCode: "AGENT_REFERRALS_ACTIVATION_OTP_DELIVERY_UNAVAILABLE" }],
    ["transport failure", { curlRc: "28", httpStatus: "000", contentType: "UNKNOWN", kind: "EMPTY", safeCode: "NO_SAFE_CODE", bodySha: "EMPTY" }],
    ["deterministic 4xx", { curlRc: "0", httpStatus: "409", safeCode: "AGENT_REFERRALS_ACTIVATION_REFUSED" }],
    ["malformed non-JSON body", { curlRc: "0", httpStatus: "503", contentType: "text/plain", kind: "NON_JSON", safeCode: "UNPARSEABLE_JSON" }],
  ])("classifies %s plus exact DORMANT evidence as proven NO_COMMIT", (_name, forensic) => {
    const result = executeReconciliation({ state: dormant, ...forensic });
    expect(result.status).toBe(1);
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_NO_COMMIT");
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILIATION=NO_COMMIT");
    expect(result.output).not.toContain("EVIDENCE_MISMATCH");
  });

  it("accepts an ambiguous 5xx only when the single POST has exact committed ACTIVE evidence", () => {
    const result = executeReconciliation({ state: active, curlRc: "0", httpStatus: "503", safeCode: "AGENT_REFERRALS_ACTIVATION_OTP_DELIVERY_UNAVAILABLE" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILED_ACTIVE");
  });

  it("classifies partial activation evidence as an anomaly", () => {
    const result = executeReconciliation({ state: { ...active, activation_manifest: null }, httpStatus: "503" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILIATION_ANOMALY");
  });

  it("executes exact replay reconciliation without any POST forensic inputs", () => {
    const result = executeReconciliation({ state: active, mode: "EXACT_REPLAY" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("AGENT_REFERRALS_Q7_ACTIVATION_RECONCILED_ACTIVE");
  });

  it("keeps Q7 runtime materialization immutable while changing only controller behavior", () => {
    expect(execFileSync("git", ["diff", "--name-only", "fa3b4aa5651956bb0a35f7a843e95423f057824b", Q7], { encoding: "utf8" }).trim()).toBe("commerce/src/release-control-schema.ts");
    expect(workflow).not.toContain("/reopen");
    expect(workflow).not.toContain("/complete");
    expect(workflow).not.toContain("git push");
  });
});
