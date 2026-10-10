import { describe, expect, it, vi } from "vitest";
import { admitRelease, deployFoundation, validateApp, validateCheckout, verifyRuntime } from "../../scripts/v2/deployment.mjs";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const sha = "a".repeat(40);
const ids = { canary: "c".repeat(24), production: "p".repeat(24) };
function fixture() {
  const apps = Object.fromEntries(Object.entries(ids).map(([target, uuid]) => [target, {
    uuid, name: target === "canary" ? "flexperiment-commerce-v2-canary" : "flexperiment-commerce-v2",
    git_repository: "ArtGurianov/flexperiment", git_branch: "main", git_commit_sha: "b".repeat(40),
    build_pack: "dockerfile", dockerfile_location: "/Dockerfile.commerce-v2", ports_exposes: "3002", fqdn: null,
    settings: { is_auto_deploy_enabled: false },
    portsMapped: false, customRouting: false, hasUnsafeOverrides: false,
  }]));
  const env = Object.fromEntries(Object.keys(ids).map((target) => [target, Object.entries({
    NODE_ENV: "production", DEPLOY_ENV: target === "canary" ? "staging" : "production", COMMERCE_V2_FOUNDATION_MODE: "true", COMMERCE_V2_ENVIRONMENT: target,
    PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false", KINESCOPE_DELIVERY_MODE: "open", COMMERCE_V2_DATABASE_PATH: "/var/lib/flexperiment-v2/commerce.sqlite",
    COMMERCE_V2_BACKUP_PATH: "/var/lib/flexperiment-v2-backups", PORT: "3002", MERCHANT_PROMOTION_PREFIX: "FX-",
    REFREF_READINESS_URL: target === "canary" ? "https://canary-ops.refref.ru/readyz" : "https://ops.refref.ru/readyz",
    COMMERCE_V2_BACKUP_AGE_RECIPIENT: "age1" + "a".repeat(58), PLATFORM_SERVICE_TOKEN: "redacted", SOURCE_COMMIT: "b".repeat(40),
  }).map(([key, value]) => ({ key, value, is_runtime: true, is_buildtime: key === "SOURCE_COMMIT", is_preview: false, present: true, length: key === "PLATFORM_SERVICE_TOKEN" ? 43 : value.length }))]));
  const storage = Object.fromEntries(Object.entries(ids).map(([target, uuid]) => [target, { file_storages: [], persistent_storages: [
    { name: uuid + "-data", mount_path: "/var/lib/flexperiment-v2", host_path: null },
    { name: uuid + "-backup", mount_path: "/var/lib/flexperiment-v2-backups", host_path: null },
  ] }]));
  const counts: Record<string, number> = { canary: 0, production: 0 };
  const checks = ["test", "docker-build"].map((name, id) => ({ id, name, head_sha: sha, app: { slug: "github-actions" }, status: "completed", conclusion: "success" }));
  const io = {
    apps: ids, github: vi.fn(async (path: string) => path === "/commits/main" ? { sha } : { check_runs: checks }),
    api: vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
      const target = path.includes(ids.canary) ? "canary" : "production";
      if (path.endsWith("/envs")) {
        if (method === "PATCH") Object.assign(env[target].find((entry) => entry.key === "SOURCE_COMMIT")!, body);
        return env[target];
      }
      if (path.endsWith("/storages")) return storage[target];
      if (method === "PATCH") Object.assign(apps[target], body);
      return apps[target];
    }),
    casRef: vi.fn(async () => {}), deploy: vi.fn(async () => {}), restart: vi.fn(async () => {}),
    runtime: vi.fn(async () => null),
    waitRuntime: vi.fn(async (target: string) => ({
      identity: { schema: "flexperiment.build-identity/1", service: "commerce-v2", sourceCommit: sha }, baked: { sourceCommit: sha }, identityMode: "444",
      ready: { ok: true, sourceCommit: sha, service: "commerce-v2", foundationMode: true, core: { paymentMode: "disabled", database: "ok" }, capabilities: { refref: "ready" } },
      containerId: target + (++counts[target]), startedAt: target + counts[target],
      mounts: storage[target].persistent_storages.map((volume) => ({ type: "volume", name: volume.name, destination: volume.mount_path, rw: true })),
    })),
    storage: vi.fn(async (_target: string, command: string) => command === "mark" ? { marker: "a".repeat(36) } : command === "backup" ? { filename: "encrypted.age", sha256: "c".repeat(64), size: 100 } : { durability: "PASS" }),
    archiveBackup: vi.fn(async () => ({ sha256: "c".repeat(64) })), record: vi.fn(async () => {}),
  };
  return { io, apps, env, storage, checks };
}

describe("exact-source admission and independent promotion", () => {
  it("requires an exact clean controller checkout and the approved Git remote", () => {
    expect(() => validateCheckout(sha, sha, "", "git@github.com:ArtGurianov/flexperiment.git")).not.toThrow();
    expect(() => validateCheckout(sha, "b".repeat(40), "", "git@github.com:ArtGurianov/flexperiment.git")).toThrow("V2_CONTROLLER_CHECKOUT_DIFFERS");
    expect(() => validateCheckout(sha, sha, " M scripts/v2/deployment.mjs", "git@github.com:ArtGurianov/flexperiment.git")).toThrow("V2_CONTROLLER_CHECKOUT_DIFFERS");
    expect(() => validateCheckout(sha, sha, "", "https://evil.invalid/repo")).toThrow("V2_CONTROLLER_REMOTE_DIFFERS");
    const cli = readFileSync("scripts/v2/deploy-cli.mjs", "utf8");
    expect(cli.indexOf("validateCheckout(sha,")).toBeLessThan(cli.indexOf('await rpc({ operation: "config" })'));
  });
  it("qualifies canary before production and proves both restart and redeploy", async () => {
    const { io } = fixture(); const proof = await deployFoundation(sha, io) as Record<string, { persistence: string; paymentMode: string }>;
    expect(proof.canary.persistence).toBe("PASS"); expect(proof.production.paymentMode).toBe("disabled");
    expect(io.deploy.mock.calls).toEqual([["canary", sha], ["canary", sha], ["production", sha], ["production", sha]]);
    expect(io.storage.mock.calls.filter((call) => call[1] === "verify")).toHaveLength(4);
    expect(io.record.mock.invocationCallOrder[0]).toBeLessThan(io.casRef.mock.invocationCallOrder[1]);
  });
  it("refuses non-main SHA before any write", async () => {
    const { io } = fixture(); io.github.mockImplementation(async () => ({ sha: "b".repeat(40) }));
    await expect(deployFoundation(sha, io)).rejects.toThrow("V2_SOURCE_NOT_MAIN_HEAD");
    expect(io.api).not.toHaveBeenCalled(); expect(io.casRef).not.toHaveBeenCalled();
  });
  it.each(["failure", "neutral", null])("requires exact successful CI, not %s", async (conclusion) => {
    const { io, checks } = fixture(); checks[1].conclusion = conclusion as string;
    await expect(admitRelease(sha, io.github)).rejects.toThrow("V2_EXACT_SOURCE_CI_REQUIRED");
  });
  it("ignores checks from another SHA or app and rejects newer pending reruns", async () => {
    const { io, checks } = fixture(); checks[1].head_sha = "b".repeat(40);
    await expect(admitRelease(sha, io.github)).rejects.toThrow(); checks[1].head_sha = sha; checks[1].app.slug = "foreign";
    await expect(admitRelease(sha, io.github)).rejects.toThrow(); checks[1].app.slug = "github-actions";
    checks.push({ ...checks[1], id: 20, status: "in_progress", conclusion: "success" });
    await expect(admitRelease(sha, io.github)).rejects.toThrow();
  });
  it("refuses production config failure before changing canary", async () => {
    const { io, apps } = fixture(); apps.production.fqdn = "https://api.flexperiment.ru" as unknown as null;
    await expect(deployFoundation(sha, io)).rejects.toThrow("V2_APP_NOT_ISOLATED");
    expect(io.casRef).not.toHaveBeenCalled();
  });
  it("stops after failed canary durability without production writes", async () => {
    const { io } = fixture(); io.storage.mockImplementation(async (_target: string, command: string) => {
      if (command === "verify") throw new Error("SQLITE_DURABILITY_FAILED");
      return command === "mark" ? { marker: "a".repeat(36) } : { filename: "encrypted.age", sha256: "c".repeat(64), size: 100 };
    });
    await expect(deployFoundation(sha, io)).rejects.toThrow("SQLITE_DURABILITY_FAILED");
    expect(io.casRef.mock.calls).toHaveLength(1); expect(io.record).not.toHaveBeenCalled();
  });
  it("rechecks main at production consumption and stops on head movement", async () => {
    const { io } = fixture(); let mainReads = 0;
    io.github.mockImplementation(async (path: string) => path === "/commits/main" ? { sha: ++mainReads >= 3 ? "b".repeat(40) : sha } : { check_runs: fixture().checks });
    await expect(deployFoundation(sha, io)).rejects.toThrow("V2_SOURCE_NOT_MAIN_HEAD");
    expect(io.record).toHaveBeenCalledTimes(1); expect(io.casRef).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit durability PASS, not a successful empty command", async () => {
    const { io } = fixture();
    const original = io.storage.getMockImplementation()!;
    io.storage.mockImplementation(async (target, command) => command === "verify" ? { durability: "UNKNOWN" } : original(target, command));
    await expect(deployFoundation(sha, io)).rejects.toThrow("V2_DURABILITY_NOT_PROVEN");
    expect(io.casRef).toHaveBeenCalledTimes(1); expect(io.record).not.toHaveBeenCalled();
  });
  it("never retries an ambiguous deployment or moves on", async () => {
    const { io } = fixture(); io.deploy.mockRejectedValue(new Error("unknown commit"));
    await expect(deployFoundation(sha, io)).rejects.toThrow("unknown commit");
    expect(io.deploy).toHaveBeenCalledTimes(1); expect(io.record).not.toHaveBeenCalled();
  });
});

describe("target, configuration and runtime controls", () => {
  it.each(["portsMapped", "customRouting", "hasUnsafeOverrides"])("refuses public exposure or arbitrary override: %s", (flag) => {
    const { apps, env, storage } = fixture(); Object.assign(apps.canary, { [flag]: true });
    expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_APP_NOT_ISOLATED");
  });
  it.each(["PAYMENT_MODE", "MARKETING_BROADCASTS_ENABLED", "REFREF_READINESS_URL", "COMMERCE_V2_FOUNDATION_MODE", "COMMERCE_V2_ENVIRONMENT"])("refuses drift in %s", (key) => {
    const { apps, env, storage } = fixture(); env.canary.find((row) => row.key === key)!.value = "unexpected";
    expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_ENVIRONMENT_DIFFERS");
  });
  it("requires runtime-only service token and refuses provider credentials", () => {
    const { apps, env, storage } = fixture(); const token = env.canary.find((row) => row.key === "PLATFORM_SERVICE_TOKEN")!;
    token.is_buildtime = true; expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_SERVICE_TOKEN_REQUIRED"); token.is_buildtime = false;
    env.canary.push({ ...token, key: "TOCHKA_JWT" }); expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_PROVIDER_CREDENTIAL_FORBIDDEN");
  });
  it("refuses shared, missing and bind-mounted SQLite storage", () => {
    const { apps, env, storage } = fixture(); storage.canary.persistent_storages[0].name = "v1-data";
    expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_VOLUME_NOT_ISOLATED");
    storage.canary.persistent_storages = []; expect(() => validateApp(apps.canary, env.canary, storage.canary, "canary", ids.canary)).toThrow("V2_STORAGE_CONFIGURATION_DIFFERS");
  });
  it("rejects runtime SHA/payment/readiness/mount drift", async () => {
    const { io, storage } = fixture(); const result = await io.waitRuntime("canary");
    const mounts = storage.canary.persistent_storages.map((v) => ({ name: v.name, destination: v.mount_path }));
    expect(() => verifyRuntime(result, sha, mounts)).not.toThrow();
    result.baked.sourceCommit = "b".repeat(40); expect(() => verifyRuntime(result, sha, mounts)).toThrow("V2_RUNTIME_IDENTITY_DIFFERS"); result.baked.sourceCommit = sha;
    result.ready.core.paymentMode = "refref"; expect(() => verifyRuntime(result, sha, mounts)).toThrow("V2_RUNTIME_NOT_READY"); result.ready.core.paymentMode = "disabled";
    result.mounts = []; expect(() => verifyRuntime(result, sha, mounts)).toThrow("V2_RUNTIME_VOLUME_DIFFERS");
  });
  it("wires a separate manual workflow, admission, no cancellation and the actual controller", () => {
    const workflow = parse(readFileSync(".github/workflows/deploy-commerce-v2.yml", "utf8"));
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.concurrency.cancel_in_progress ?? workflow.concurrency["cancel-in-progress"]).toBe(false);
    const steps = workflow.jobs.qualify.steps;
    expect(steps.find((step: { name: string }) => step.name === "Validate source identity before checkout").run).toContain("docker-build");
    expect(steps.at(-1).run).toBe("node scripts/v2/deploy-cli.mjs");
    expect(JSON.stringify(workflow)).not.toContain("flexperiment-release");
  });
});
