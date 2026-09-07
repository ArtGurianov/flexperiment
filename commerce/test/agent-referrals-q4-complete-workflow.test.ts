import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const RELEASE = `agent-referrals-q4-dormant-${Q4}`;
const workflow = readFileSync(".github/workflows/controlled-agent-referrals-q4-complete.yml", "utf8");
const helper = resolve("scripts/release/complete-agent-referrals-q4-held-release.sh");
const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

const run = (response: string) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-referrals-q4-complete-")); directories.push(directory);
  const bin = join(directory, "bin"); const outcome = join(directory, "outcome.json"); const calls = join(directory, "calls"); mkdirSync(bin); writeFileSync(calls, "");
  const curl = join(bin, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$*" >> "$CALLS"\noutput=''\nfor ((i=1;i<=$#;i++)); do [[ "\${!i}" == --output ]] && { n=$((i+1)); output="\${!n}"; }; done\n[[ '${response}' == TRANSPORT ]] && exit 28\nbody='${response === "MALFORMED" ? "not-json" : "{}"}'\nprintf '%s' "$body" > "$output"\nprintf '%s' '${response === "MALFORMED" ? "200" : response}'\n`);
  chmodSync(curl, 0o755); writeFileSync(join(directory, "release.json"), JSON.stringify({ release_id: RELEASE }));
  const child = spawnSync("bash", [helper], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, COMMERCE_RELEASE_CONTROL_TOKEN: "test", PUBLIC_API_URL: "https://api.test", Q4_RELEASE_REQUEST: join(directory, "release.json"), Q4_COMPLETION_OUTCOME: outcome } });
  return { child, calls: readFileSync(calls, "utf8"), outcome: existsSync(outcome) ? readFileSync(outcome, "utf8") : "" };
};

describe("Agent Referrals Q4 held-owner terminalization", () => {
  it("is manual-only, hard-bound, and has no deploy, acquire, ref, or activation authority", () => {
    const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:"); expect(trigger).not.toContain("inputs:");
    for (const required of [Q4, RELEASE, "environment: production", "group: flexperiment-production-controlled-cutover", "persist-credentials: false", "AGENT_REFERRALS_Q4_COMPLETE_CONTROLLER_MAIN_MOVED"]) expect(workflow).toContain(required);
    for (const forbidden of ["controlled-coolify-deploy.sh", "set-production-deploy-ref.sh", "runtime-candidate", "/release-control/acquire", "/release-control/pause", "/agent-referrals/activate"]) expect(workflow).not.toContain(forbidden);
  });

  it("requires held Q4, public expectation projection, full readiness, and exactly one completion consequence", () => {
    expect(workflow).toContain('.owner_release_id == $id and .owner_mode == "ROLLING" and .sales_paused == false');
    expect(workflow).toContain("{source_commit,migration,legal_version,legal_manifest_sha256}");
    expect(workflow).toContain("legal_hashes:$r.legal_hashes");
    expect(workflow).toContain("readiness-before.json");
    expect(workflow.indexOf("readiness-before.json")).toBeLessThan(workflow.indexOf("complete-agent-referrals-q4-held-release.sh"));
    expect(workflow).toContain("completion-after.json"); expect(workflow).toContain(".complete == true and .expected == $release[0].expected");
    expect(workflow).toContain(".owner_release_id == null and .owner_mode == null and .sales_paused == false");
  });

  it("executes completion once and classifies ambiguous transport, 5xx, and malformed replies without retry", () => {
    for (const response of ["TRANSPORT", "503", "MALFORMED"]) {
      const { child, calls, outcome } = run(response);
      expect(child.status, child.stderr).toBe(0); expect((calls.match(/complete-rolling/g) ?? [])).toHaveLength(1); expect(outcome).toContain('"outcome":"UNKNOWN"');
    }
    const accepted = run("200"); expect(accepted.child.status).toBe(0); expect(accepted.outcome).toContain('"outcome":"ACCEPTED"');
    const knownFailed = run("400"); expect(knownFailed.child.status).toBe(1); expect(knownFailed.outcome).toContain('"outcome":"KNOWN_FAILED"');
  });
});
