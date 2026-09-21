/**
 * Asks one Coolify installation whether it can do what a cutover needs.
 *
 * The API reference says `PATCH git_commit_sha`, `POST /deploy`, `GET
 * /deployments/{uuid}` and `POST /applications/{uuid}/rollback` exist. What it
 * cannot say is whether THIS installation, at this version, with a Docker
 * Compose application, honours them - whether the pinned commit is actually
 * used, and whether the rollback endpoint still finds a retained image. A
 * recovery driver written against the documentation and wrong about the
 * installation would fail in the one place it exists for.
 *
 * So this probes, and it probes somewhere disposable. It refuses to run
 * against any application named in the cutover configuration, restores the
 * original `git_commit_sha` whatever happens, and mutates nothing until it has
 * read the starting state and been told explicitly to proceed.
 *
 *   COOLIFY_API_URL          https://coolify.example/api/v1
 *   COOLIFY_TOKEN            a token with application read/deploy rights
 *   COOLIFY_PROBE_APP_UUID   a DISPOSABLE application, never a production one
 *   COOLIFY_PROBE_COMMIT     a commit the probe may deploy there
 *   COOLIFY_COMMERCE_APP_UUID, COOLIFY_FRONTEND_APP_UUID, COOLIFY_ADMIN_APP_UUID
 *                            read only, to prove the probe target is none of them
 *
 * Run it with `--mutate` to perform the deploy and rollback. Without that it
 * reads and reports, which is the safe default.
 */

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`COOLIFY_PROBE_CONFIG_MISSING: ${name}`);
  return value;
};

const MUTATE = process.argv.includes("--mutate");

/**
 * Read inside `main`, not at import. Configuration missing at module scope
 * throws before anything can catch it, and the operator sees a stack trace
 * where they should see which variable is unset.
 */
let API = "";
let TOKEN = "";
let PROBE_APP = "";
let PROBE_COMMIT = "";

const PRODUCTION_APPS = ["COOLIFY_COMMERCE_APP_UUID", "COOLIFY_FRONTEND_APP_UUID", "COOLIFY_ADMIN_APP_UUID"]
  .map((name) => process.env[name]?.trim()).filter((value): value is string => Boolean(value));

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { json = { raw: text.slice(0, 400) }; }
  return { status: response.status, json };
};

const findings: { step: string; ok: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => {
  findings.push({ step, ok, detail });
  console.log(`  ${ok ? "ok      " : "MISSING "}${step.padEnd(42)} ${detail}`);
};

/** Polls one deployment to a terminal state. Acceptance is not convergence, so the queue entry is followed. */
const awaitDeployment = async (uuid: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const { json } = await call("GET", `/deployments/${uuid}`);
    const status = String(json.status ?? "unknown");
    if (["finished", "failed", "cancelled", "error"].includes(status)) return json;
    if (Date.now() > deadline) return { ...json, status: "TIMED_OUT" };
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
};

const main = async () => {
  API = required("COOLIFY_API_URL").replace(/\/+$/, "");
  TOKEN = required("COOLIFY_TOKEN");
  PROBE_APP = required("COOLIFY_PROBE_APP_UUID");
  PROBE_COMMIT = required("COOLIFY_PROBE_COMMIT");

  console.log(`Coolify capability probe against ${API}`);
  console.log(MUTATE ? "  mutating: the probe application will be deployed and rolled back\n" : "  read-only: pass --mutate to perform the deploy and rollback\n");

  if (PRODUCTION_APPS.includes(PROBE_APP)) {
    throw new Error("COOLIFY_PROBE_TARGET_IS_PRODUCTION: refusing to probe an application the cutover deploys");
  }
  record("probe target is not a cutover surface", true, `${PRODUCTION_APPS.length} production uuid(s) compared`);

  const before = await call("GET", `/applications/${PROBE_APP}`);
  if (before.status !== 200) throw new Error(`COOLIFY_PROBE_APPLICATION_UNREADABLE: HTTP ${before.status}`);
  const originalCommit = before.json.git_commit_sha === null || before.json.git_commit_sha === undefined
    ? null : String(before.json.git_commit_sha);
  record("GET /applications/{uuid}", true, `git_branch=${String(before.json.git_branch ?? "?")} git_commit_sha=${originalCommit ?? "null"}`);

  if (before.json.settings && typeof before.json.settings === "object") {
    const auto = (before.json.settings as Record<string, unknown>).is_auto_deploy_enabled;
    record("auto-deploy is off on the probe target", auto !== true, `is_auto_deploy_enabled=${String(auto)}`);
  }

  if (!MUTATE) {
    console.log("\nRead-only probe complete. Nothing was changed.");
    return;
  }

  let restored = false;
  try {
    const patched = await call("PATCH", `/applications/${PROBE_APP}`, { git_commit_sha: PROBE_COMMIT });
    record("PATCH git_commit_sha", patched.status >= 200 && patched.status < 300, `HTTP ${patched.status}`);

    const readBack = await call("GET", `/applications/${PROBE_APP}`);
    const stored = String(readBack.json.git_commit_sha ?? "");
    record("the pinned commit is stored", stored === PROBE_COMMIT, `git_commit_sha=${stored || "null"}`);

    const deploy = await call("POST", `/deploy?uuid=${encodeURIComponent(PROBE_APP)}`);
    const queued = Array.isArray(deploy.json.deployments) ? (deploy.json.deployments as Record<string, unknown>[])[0] : undefined;
    const deploymentUuid = String(queued?.deployment_uuid ?? deploy.json.deployment_uuid ?? "");
    record("POST /deploy returns a deployment uuid", Boolean(deploymentUuid), deploymentUuid || `HTTP ${deploy.status}`);

    if (deploymentUuid) {
      const finished = await awaitDeployment(deploymentUuid);
      record("the deployment reaches a terminal state", String(finished.status) === "finished", `status=${String(finished.status)}`);
      // The one that decides whether C is implementable at all.
      record("the deployment reports the pinned commit", String(finished.commit ?? "") === PROBE_COMMIT,
        `deployment.commit=${String(finished.commit ?? "none")}`);
    }

    if (originalCommit) {
      const rollback = await call("POST", `/applications/${PROBE_APP}/rollback`, { commit: originalCommit });
      record("POST /applications/{uuid}/rollback", rollback.status >= 200 && rollback.status < 300, `HTTP ${rollback.status}`);
      const rollbackUuid = String((rollback.json as Record<string, unknown>).deployment_uuid ?? "");
      if (rollbackUuid) {
        const finished = await awaitDeployment(rollbackUuid);
        record("the rollback finds a retained image", String(finished.status) === "finished", `status=${String(finished.status)}`);
        record("the rollback reports the earlier commit", String(finished.commit ?? "") === originalCommit,
          `deployment.commit=${String(finished.commit ?? "none")}`);
      }
    } else {
      record("rollback could be attempted", false, "the probe application had no git_commit_sha to return to");
    }
  } finally {
    // The configuration goes back whatever happened above. A probe that leaves
    // an application pinned to a commit nobody chose is worse than no probe.
    const restore = await call("PATCH", `/applications/${PROBE_APP}`, { git_commit_sha: originalCommit });
    restored = restore.status >= 200 && restore.status < 300;
    record("original git_commit_sha restored", restored, `HTTP ${restore.status} -> ${originalCommit ?? "null"}`);
  }
};

main().then(() => {
  const missing = findings.filter((finding) => !finding.ok);
  console.log(`\n${missing.length ? `${missing.length} capability(ies) missing` : "every probed capability is present"}`);
  if (missing.length) {
    console.log("Implementing the Coolify recovery driver needs each of these; stop here rather than working around one.");
    for (const finding of missing) console.log(`  - ${finding.step}: ${finding.detail}`);
  }
  process.exit(missing.length ? 1 : 0);
}).catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
