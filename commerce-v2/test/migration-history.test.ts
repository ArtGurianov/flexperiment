import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkV2MigrationHistory } from "../../scripts/ci/check-v2-migrations";
import { writeMigrationBundle } from "./fixtures/migrations";

const temporary: string[] = [];
const baseline = { "0001_baseline.sql": "SELECT 1;\n" };
const next = { ...baseline, "0002_next.sql": "SELECT 2;\n" };
function repository(withLock = true) {
  const root = mkdtempSync(join(tmpdir(), "v2-history-")); temporary.push(root);
  const directory = join(root, "commerce-v2", "migrations"); mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" },
  });
  const commit = () => { git("add", "-A"); git("commit", "-m", "migration fixture"); };
  git("init", "-b", "main"); writeMigrationBundle(directory, baseline);
  if (!withLock) unlinkSync(join(directory, "migration.lock"));
  commit();
  return { root, directory, git, commit };
}
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("full-history migration CI", () => {
  it("accepts initial lock adoption and append-only additions", () => {
    const repo = repository(false); writeMigrationBundle(repo.directory, baseline);
    expect(checkV2MigrationHistory(repo.root).migrations).toBe(1);
    repo.commit(); writeMigrationBundle(repo.directory, next); repo.commit();
    expect(checkV2MigrationHistory(repo.root)).toEqual({ migrations: 2, revisions: 3 });
  });

  it.each([false, true])("rejects historical SQL and lock rewritten together (committed=%s)", (committed) => {
    const repo = repository(); writeMigrationBundle(repo.directory, { "0001_baseline.sql": "SELECT 99;\n" });
    if (committed) repo.commit();
    expect(() => checkV2MigrationHistory(repo.root)).toThrow(/committed (SQL|lock entry) changed or removed/);
  });

  it("protects SQL committed before the first lock existed", () => {
    const repo = repository(false); writeMigrationBundle(repo.directory, { "0001_baseline.sql": "SELECT 99;\n" });
    repo.commit();
    expect(() => checkV2MigrationHistory(repo.root)).toThrow("committed SQL changed or removed");
  });

  it("rejects an intermediate rewrite even when later reverted", () => {
    const repo = repository(); writeMigrationBundle(repo.directory, { "0001_baseline.sql": "SELECT 99;\n" }); repo.commit();
    writeMigrationBundle(repo.directory, baseline); repo.commit();
    expect(() => checkV2MigrationHistory(repo.root)).toThrow(/committed (SQL|lock entry) changed or removed/);
  });

  it.each(["SQL", "lock"])("rejects committed %s deletion/restoration with unchanged final bytes", (kind) => {
    const repo = repository();
    unlinkSync(join(repo.directory, kind === "SQL" ? "0001_baseline.sql" : "migration.lock")); repo.commit();
    writeMigrationBundle(repo.directory, baseline); repo.commit();
    expect(() => checkV2MigrationHistory(repo.root)).toThrow("committed migration/lock deletion");
  });

  it("rejects removal or renaming of an old migration and its lock entry", () => {
    const repo = repository();
    unlinkSync(join(repo.directory, "0001_baseline.sql"));
    writeMigrationBundle(repo.directory, { "0001_renamed.sql": baseline["0001_baseline.sql"] }); repo.commit();
    expect(() => checkV2MigrationHistory(repo.root)).toThrow(/committed (SQL|lock entry) changed or removed/);
  });

  it("checks both sides of a merge, including a rewrite hidden on its second parent", () => {
    const repo = repository(); repo.git("checkout", "-b", "side");
    writeMigrationBundle(repo.directory, { "0001_baseline.sql": "SELECT 99;\n" }); repo.commit();
    repo.git("checkout", "main"); writeFileSync(join(repo.root, "unrelated.txt"), "unrelated"); repo.commit();
    repo.git("merge", "--no-ff", "-s", "ours", "side", "-m", "keep original bytes");
    expect(() => checkV2MigrationHistory(repo.root)).toThrow(/committed (SQL|lock entry) changed or removed/);
  });

  it("fails closed on shallow checkouts", () => {
    const repo = repository(); writeMigrationBundle(repo.directory, next); repo.commit();
    const clone = join(repo.root, "shallow");
    repo.git("clone", "--depth=1", `file://${repo.root}`, clone);
    expect(() => checkV2MigrationHistory(clone)).toThrow("full Git history required");
  });
});
