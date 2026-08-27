import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scriptPath = resolve(repositoryRoot, "commerce/src/create-certification-fixture.ts");

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function fixtureEnvironment() {
  const directory = mkdtempSync(resolve(tmpdir(), "flexperiment-certification-fixture-"));
  directories.push(directory);
  const databasePath = resolve(directory, "commerce.sqlite3");
  const db = openDatabase(databasePath);
  migrate(db);
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'kemerovo', 'Кемерово')").run(cityId);
  db.close();
  return {
    directory,
    databasePath,
    cityId,
    keyPath: resolve(directory, "checkout-key"),
    manifestPath: resolve(directory, "manifest.json"),
  };
}

function run(env: Record<string, string>) {
  return execFileSync("node", ["--import", "tsx", scriptPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runFailure(env: Record<string, string>) {
  try {
    run(env);
    return undefined;
  } catch (error) {
    return error as { stderr: string; status: number };
  }
}

function baseEnv(fixture: ReturnType<typeof fixtureEnvironment>) {
  return {
    COMMERCE_DATABASE_PATH: fixture.databasePath,
    COMMERCE_CERTIFICATION_FIXTURE_LABEL: "gen-test-certification-fixture",
    COMMERCE_CERTIFICATION_FIXTURE_CITY_ID: fixture.cityId,
    COMMERCE_CERTIFICATION_FIXTURE_STARTS_AT: "2027-03-01T12:00:00+03:00",
    COMMERCE_CERTIFICATION_FIXTURE_ENDS_AT: "2027-03-01T15:00:00+03:00",
    COMMERCE_CERTIFICATION_FIXTURE_KEY_PATH: fixture.keyPath,
    COMMERCE_CERTIFICATION_FIXTURE_MANIFEST_PATH: fixture.manifestPath,
  };
}

describe("certification fixture creation script", () => {
  it("defaults to a dry run that mutates nothing", () => {
    const fixture = fixtureEnvironment();
    const output = JSON.parse(run(baseEnv(fixture)));
    expect(output.dry_run).toBe(true);

    expect(existsSync(fixture.keyPath)).toBe(false);
    expect(existsSync(fixture.manifestPath)).toBe(false);
    const db = openDatabase(fixture.databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrences").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM promo_codes").get()).toEqual({ count: 0 });
    db.close();
  });

  it("piping the dry run through a truncating pipe still performs zero mutation", () => {
    const fixture = fixtureEnvironment();
    execFileSync("bash", ["-lc", `node --import tsx ${JSON.stringify(scriptPath)} | head -1`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...baseEnv(fixture) },
    });
    expect(existsSync(fixture.keyPath)).toBe(false);
    expect(existsSync(fixture.manifestPath)).toBe(false);
    const db = openDatabase(fixture.databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrences").get()).toEqual({ count: 0 });
    db.close();
  });

  it("requires every fixture parameter before running", () => {
    const fixture = fixtureEnvironment();
    const env = baseEnv(fixture);
    for (const key of Object.keys(env)) {
      const partial = { ...env, [key]: "" } as Record<string, string>;
      const failure = runFailure(partial);
      expect(failure, `expected failure when ${key} is missing`).toBeDefined();
    }
  });

  it("creates the occurrence, promo, key file, and manifest only when explicitly executed", () => {
    const fixture = fixtureEnvironment();
    const output = JSON.parse(run({ ...baseEnv(fixture), COMMERCE_CERTIFICATION_FIXTURE_EXECUTE: "CREATE-CERTIFICATION-FIXTURE" }));
    expect(output.dry_run).toBe(false);
    expect(output.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(output.occurrence_visibility).toBe("HIDDEN");
    expect(output.occurrence_sales_status).toBe("CLOSED");
    expect(output.promo_discount_type).toBe("FIXED");
    expect(output.promo_discount_value).toBe(1);

    expect(statSync(fixture.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(fixture.manifestPath).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    expect(manifest.run_id).toBe(output.run_id);
    expect(manifest.occurrence_id).toBe(output.occurrence_id);
    expect(manifest.promo_id).toBe(output.promo_id);
    expect(manifest.idempotency_key_sha256).toBe(output.idempotency_key_sha256);

    const db = openDatabase(fixture.databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrences").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM promo_codes").get()).toEqual({ count: 1 });
    db.close();
  });

  it("refuses to overwrite an existing key file and creates no duplicate fixture rows", () => {
    const fixture = fixtureEnvironment();
    const executeEnv = { ...baseEnv(fixture), COMMERCE_CERTIFICATION_FIXTURE_EXECUTE: "CREATE-CERTIFICATION-FIXTURE" };
    run(executeEnv);

    const failure = runFailure(executeEnv);
    expect(failure).toBeDefined();
    expect(failure!.stderr).toContain("Refusing to overwrite existing key file");

    const db = openDatabase(fixture.databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrences").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM promo_codes").get()).toEqual({ count: 1 });
    db.close();
  });

  it("allows an explicit replace of an unused key without blocking on a stale file", () => {
    const fixture = fixtureEnvironment();
    const executeEnv = { ...baseEnv(fixture), COMMERCE_CERTIFICATION_FIXTURE_EXECUTE: "CREATE-CERTIFICATION-FIXTURE" };
    run(executeEnv);
    const output = JSON.parse(run({ ...executeEnv, COMMERCE_CERTIFICATION_FIXTURE_REPLACE_KEY: "REPLACE-EXISTING-KEY" }));
    expect(output.dry_run).toBe(false);

    const db = openDatabase(fixture.databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrences").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM promo_codes").get()).toEqual({ count: 2 });
    db.close();
  });
});
