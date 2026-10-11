import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve("payload")), "../bin.js");
const preload = resolve(root, "lib/payload-cli-preload.mjs");
const directories: string[] = [];
const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", DEPLOY_ENV: "staging", PAYLOAD_JOBS_ENABLED: "false",
  PLATFORM_V2_CANARY: "false", PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false",
  SOURCE_COMMIT: "a".repeat(40), PAYLOAD_SECRET: "isolated-synthetic-cli-admission", PLATFORM_ORIGIN: "https://isolated.invalid" };
const run = (args: string[], env = environment, protectedStart = true) => spawnSync(process.execPath,
  [...(protectedStart ? ["--import", preload] : []), cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 20000 });
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("pinned Payload CLI migration admission", () => {
  it("causally refuses an unsettled real CLI command that the old CLI calls success", () => {
    const args = ["--disable-transpile", "run", resolve(root, "test/fixtures/payload-cli-unsettled.mjs")];
    expect(run(args, environment, false).status).toBe(0);
    const guarded = run(args);
    expect(guarded.status).toBe(1); expect(guarded.stderr).toContain("PAYLOAD_CLI_INCOMPLETE");
  });
  it.each(["0", "23"])("preserves explicit command exit %s", code => {
    const result = run(["--disable-transpile", "run", resolve(root, "test/fixtures/payload-cli-explicit-exit.mjs")], { ...environment, CLI_FIXTURE_EXIT: code });
    expect(result.status).toBe(Number(code)); expect(result.stderr).not.toContain("PAYLOAD_CLI_INCOMPLETE");
  });
  it.each(["production", "development"] as const)("selects real static Lexical export in %s", mode => {
    const result = spawnSync(process.execPath, ["--import", preload, "--experimental-import-meta-resolve", "--input-type=module", "-e",
      'import {createRequire} from "node:module";import {pathToFileURL} from "node:url";const r=createRequire(import.meta.url);console.log(import.meta.resolve("lexical",pathToFileURL(r.resolve("@payloadcms/richtext-lexical")).href));process.exit(0);'], { cwd: root, env: { ...environment, NODE_ENV: mode }, encoding: "utf8", timeout: 20000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain(mode === "production" ? "Lexical.prod.mjs" : "Lexical.dev.mjs");
    expect(result.stdout).not.toContain("Lexical.node.mjs");
  });
  it("preserves an explicit condition and leaves non-Lexical built-ins unchanged", () => {
    const result = spawnSync(process.execPath, ["--import", preload, "--conditions=development", "--experimental-import-meta-resolve", "--input-type=module", "-e",
      'import {createRequire} from "node:module";import {pathToFileURL} from "node:url";const r=createRequire(import.meta.url);console.log(import.meta.resolve("lexical",pathToFileURL(r.resolve("@payloadcms/richtext-lexical")).href));console.log(import.meta.resolve("node:crypto"));process.exit(0);'], { cwd: root, env: environment, encoding: "utf8", timeout: 20000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Lexical.dev.mjs");
    expect(result.stdout).toContain("node:crypto"); expect(result.stdout).not.toContain("Lexical.prod.mjs");
  });
  it("executes actual config and migrations before qualifying schema, then preserves an existing database", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "flex-payload-cli-test-")); directories.push(directory);
    const file = resolve(directory, "editorial.sqlite"); const env = { ...environment, PAYLOAD_DATABASE_URL: `file:${file}` };
    for (let i = 0; i < 2; i++) {
      const result = run(["migrate"], env);
      expect(result.status, result.stderr).toBe(0);
      const db = new Database(file, { readonly: true });
      try {
        expect(db.pragma("quick_check", { simple: true })).toBe("ok");
        expect(db.prepare("SELECT count(*) AS n FROM payload_migrations").get()).toEqual({ n: 6 });
        expect(db.prepare("SELECT count(*) AS n FROM courses").get()).toEqual({ n: 0 });
      } finally { db.close(); }
    }
  }, 30000);
});
