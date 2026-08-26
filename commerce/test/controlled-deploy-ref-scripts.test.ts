import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceCommit = "a".repeat(40);
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const runScript = (script: string, options: { remote?: string; catFileFails?: boolean; mergeBaseFails?: boolean; sourceRef?: string } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-deploy-ref-"));
  temporaryDirectories.push(directory);
  const gitLog = join(directory, "git.log");
  const curlLog = join(directory, "curl.log");
  const git = join(directory, "git");
  const curl = join(directory, "curl");
  writeFileSync(gitLog, "");
  writeFileSync(curlLog, "");
  writeFileSync(git, `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  ls-remote) [ "$GIT_REMOTE_MODE" = missing ] || printf '%s\\t%s\\n' "$GIT_REMOTE_SHA" "$3" ;;
  cat-file) if [ "$GIT_CAT_FILE_FAILS" = 1 ]; then exit 1; fi ;;
  merge-base) if [ "$GIT_MERGE_BASE_FAILS" = 1 ]; then exit 1; fi ;;
esac
`);
  writeFileSync(curl, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CURL_LOG\"\n");
  chmodSync(git, 0o755);
  chmodSync(curl, 0o755);
  const result = spawnSync("bash", [script, sourceCommit], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GIT_LOG: gitLog,
      CURL_LOG: curlLog,
      GIT_REMOTE_MODE: options.remote === undefined ? "missing" : "present",
      GIT_REMOTE_SHA: options.remote ?? "",
      GIT_CAT_FILE_FAILS: options.catFileFails ? "1" : "0",
      GIT_MERGE_BASE_FAILS: options.mergeBaseFails ? "1" : "0",
      COOLIFY_TOKEN: "test-token",
      COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL: "https://commerce.example.test/deploy",
      COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL: "https://frontend.example.test/deploy",
      COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL: "https://admin.example.test/deploy",
      ...(options.sourceRef ? { CONTROLLED_DEPLOY_SOURCE_REF: options.sourceRef } : {}),
    },
  });
  return { result, gitLog: readFileSync(gitLog, "utf8"), curlLog: readFileSync(curlLog, "utf8") };
};

describe("guarded production deployment ref scripts", () => {
  const deployHelper = "scripts/controlled-coolify-deploy.sh";
  const setRef = "scripts/set-production-deploy-ref.sh";

  it.each([undefined, "b".repeat(40)])("rejects a missing or wrong production-deploy ref before a webhook", (remote) => {
    const { result, curlLog } = runScript(deployHelper, { remote });
    expect(result.status).toBe(1);
    expect(curlLog).toBe("");
  });

  it("allows webhook enqueue only when production-deploy is exact", () => {
    const { result, gitLog, curlLog } = runScript(deployHelper, { remote: sourceCommit });
    expect(result.status).toBe(0);
    expect(gitLog).toContain("ls-remote origin refs/heads/production-deploy");
    expect(gitLog).not.toContain("refs/heads/main");
    expect(curlLog.trim().split("\n")).toHaveLength(3);
  });

  it("moves only production-deploy with a normal push and verifies the remote ref", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit });
    expect(result.status).toBe(0);
    expect(gitLog).toContain(`push origin ${sourceCommit}:refs/heads/production-deploy`);
    expect(gitLog).not.toContain("--force");
    expect(gitLog).not.toContain("refs/heads/main");
    expect(gitLog.match(/ls-remote origin refs\/heads\/production-deploy/g)).toHaveLength(1);
  });

  it("refuses an unavailable target before it can push a deployment ref", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit, catFileFails: true });
    expect(result.status).toBe(1);
    expect(gitLog).not.toContain("push origin");
  });

  it("refuses a target that is no longer reachable from origin/main before it can push", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit, mergeBaseFails: true });
    expect(result.status).toBe(1);
    expect(gitLog).toContain(`merge-base --is-ancestor ${sourceCommit} origin/main`);
    expect(gitLog).not.toContain("push origin");
  });

  it("allows a checked recovery branch as the explicit deploy source ref", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit, sourceRef: "recovery/checkout-legal" });
    expect(result.status).toBe(0);
    expect(gitLog).toContain("fetch --no-tags origin recovery/checkout-legal");
    expect(gitLog).toContain(`merge-base --is-ancestor ${sourceCommit} origin/recovery/checkout-legal`);
    expect(gitLog).toContain(`push origin ${sourceCommit}:refs/heads/production-deploy`);
  });

  it("rejects an unsafe deploy source ref before it can push", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit, sourceRef: "-unsafe" });
    expect(result.status).toBe(2);
    expect(gitLog).not.toContain("push origin");
  });
});
