import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const sourceCommit = "a".repeat(40);
const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const runScript = (script: string, options: {
  remote?: string;
  catFileFails?: boolean;
  maintenanceMarkerPresent?: boolean;
  remoteMode?: "missing" | "malformed" | "ambiguous";
  pushMode?: "lease-rejects" | "postcondition-mismatch";
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-deploy-ref-"));
  temporaryDirectories.push(directory);
  const gitLog = join(directory, "git.log");
  const curlLog = join(directory, "curl.log");
  const git = join(directory, "git");
  const curl = join(directory, "curl");
  const remoteState = join(directory, "remote-state");
  writeFileSync(gitLog, "");
  writeFileSync(curlLog, "");
  writeFileSync(remoteState, options.remote ?? "");
  writeFileSync(git, `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
case "$1" in
  ls-remote)
    case "$GIT_REMOTE_MODE" in
      missing) [ "$2" = --exit-code ] && exit 2 || exit 0 ;;
      malformed) printf '%s\\t%s\\n' malformed-sha "$4" ;;
      ambiguous) printf '%s\\t%s\\n%s\\t%s\\n' "$(cat "$GIT_REMOTE_STATE")" "$4" "b$(printf 'b%.0s' $(seq 1 39))" "$4" ;;
      *) printf '%s\\t%s\\n' "$(cat "$GIT_REMOTE_STATE")" "$4" ;;
    esac
    ;;
  cat-file)
    case "$3" in
      *:.release/maintenance-only)
        [ "$GIT_MAINTENANCE_MARKER_PRESENT" = 1 ] && exit 0 || exit 1
        ;;
      *)
        if [ "$GIT_CAT_FILE_FAILS" = 1 ]; then exit 1; fi
        ;;
    esac
    ;;
  push)
    if [ "$GIT_PUSH_MODE" = lease-rejects ]; then exit 1; fi
    if [ "$GIT_PUSH_MODE" != postcondition-mismatch ]; then printf '%s' "$GIT_EXPECTED_SOURCE" > "$GIT_REMOTE_STATE"; fi
    ;;
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
      GIT_REMOTE_STATE: remoteState,
      GIT_REMOTE_MODE: options.remoteMode ?? (options.remote === undefined ? "missing" : "present"),
      GIT_PUSH_MODE: options.pushMode ?? "success",
      GIT_EXPECTED_SOURCE: sourceCommit,
      GIT_CAT_FILE_FAILS: options.catFileFails ? "1" : "0",
      GIT_MAINTENANCE_MARKER_PRESENT: options.maintenanceMarkerPresent ? "1" : "0",
      COOLIFY_TOKEN: "test-token",
      COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL: "https://commerce.example.test/deploy",
      COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL: "https://frontend.example.test/deploy",
      COOLIFY_ADMIN_DEPLOY_WEBHOOK_URL: "https://admin.example.test/deploy",
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

  it("CAS-moves only production-deploy across unrelated histories and proves the remote postcondition", () => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40) });
    expect(result.status).toBe(0);
    expect(gitLog).toContain(`push --force-with-lease=refs/heads/production-deploy:${"b".repeat(40)} origin ${sourceCommit}:refs/heads/production-deploy`);
    expect(gitLog).not.toMatch(/(?:^|\s)--force(?:\s|$)/m);
    expect(gitLog).not.toContain("refs/heads/main");
    expect(gitLog).not.toContain("merge-base");
    expect(gitLog.match(/ls-remote --exit-code origin refs\/heads\/production-deploy/g)).toHaveLength(2);
  });

  it("accepts an already exact deployment pointer without rewriting it", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit });
    expect(result.status).toBe(0);
    expect(gitLog).not.toContain("push ");
    expect(gitLog.match(/ls-remote --exit-code origin refs\/heads\/production-deploy/g)).toHaveLength(2);
  });

  it("fails closed when a concurrent pointer movement invalidates the lease", () => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40), pushMode: "lease-rejects" });
    expect(result.status).toBe(1);
    expect(gitLog).toContain(`push --force-with-lease=refs/heads/production-deploy:${"b".repeat(40)} origin ${sourceCommit}:refs/heads/production-deploy`);
  });

  it("fails closed when the pointer does not satisfy the post-push exact target", () => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40), pushMode: "postcondition-mismatch" });
    expect(result.status).toBe(1);
    expect(gitLog.match(/ls-remote --exit-code origin refs\/heads\/production-deploy/g)).toHaveLength(2);
    expect(result.stderr).toContain("PRODUCTION_DEPLOY_POINTER_POSTCONDITION_FAILED");
  });

  it.each(["missing", "malformed", "ambiguous"] as const)("fails closed for a %s remote deployment pointer", (remoteMode) => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40), remoteMode });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PRODUCTION_DEPLOY_REMOTE_POINTER_INVALID");
    expect(gitLog).not.toContain("push ");
  });

  it("refuses an unavailable target before it can push a deployment ref", () => {
    const { result, gitLog } = runScript(setRef, { remote: sourceCommit, catFileFails: true });
    expect(result.status).toBe(1);
    expect(gitLog).not.toContain("push origin");
  });

  it("refuses a maintenance/audit commit marked ineligible for deployment", () => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40), maintenanceMarkerPresent: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PRODUCTION_DEPLOY_TARGET_IS_MAINTENANCE_ONLY");
    expect(gitLog).not.toContain("push origin");
  });

  it("allows a runtime candidate that carries no maintenance-only marker", () => {
    const { result, gitLog } = runScript(setRef, { remote: "b".repeat(40), maintenanceMarkerPresent: false });
    expect(result.status).toBe(0);
    expect(gitLog).toContain(`push --force-with-lease=refs/heads/production-deploy:${"b".repeat(40)} origin ${sourceCommit}:refs/heads/production-deploy`);
  });

});
