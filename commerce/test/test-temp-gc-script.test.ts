import { chmodSync, mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The GC points at a shared TMPDIR, so "does it delete the right things" is
 * only half the question - "does it leave everything else alone" is the half
 * that matters. These run the real script against a synthetic root.
 */

const SCRIPT = resolve(process.cwd(), "scripts/test-temp-gc.sh");
const temporary: string[] = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

const HOURS = 60 * 60 * 1000;
const aged = (path: string, hoursOld: number) => {
  const when = new Date(Date.now() - hoursOld * HOURS);
  utimesSync(path, when, when);
};

const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "temp-gc-root-"));
  temporary.push(directory);
  return directory;
};

const fixture = (root: string, name: string, hoursOld: number, files: string[] = ["commerce.sqlite"]) => {
  const directory = join(root, name);
  mkdirSync(directory);
  for (const file of files) writeFileSync(join(directory, file), "x");
  aged(directory, hoursOld);
  return directory;
};

const run = (root: string, ...args: string[]) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, TEST_TEMP_GC_ROOT: root } });

describe("test temp GC", () => {
  it("removes aged fixture directories and leaves recent ones alone", () => {
    const r = root();
    const old = fixture(r, "agent-referrals-settlement-Ab12Cd", 48);
    const recent = fixture(r, "agent-referrals-settlement-Ef34Gh", 1);
    const result = run(r);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(old), "48h old fixture").toBe(false);
    expect(existsSync(recent), "a concurrent run must survive").toBe(true);
  });

  it("never touches a directory holding anything but SQLite files", () => {
    const r = root();
    const foreign = fixture(r, "some-other-tool-Xy99Zz", 48, ["session.json"]);
    const mixed = fixture(r, "agent-referrals-settlement-Mm77Nn", 48, ["commerce.sqlite", "secrets.env"]);
    const ours = fixture(r, "db-migrate-Qq11Rr", 48, ["commerce.sqlite", "commerce.sqlite-wal"]);
    const result = run(r);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(foreign), "another tool's temp").toBe(true);
    expect(existsSync(mixed), "unexpected content means hands off").toBe(true);
    expect(existsSync(ours), "sqlite plus its WAL is still ours").toBe(false);
  });

  it("ignores names that are not mkdtemp-shaped, including system temps", () => {
    const r = root();
    for (const name of ["com.apple.ThreadCommissionerService", "TemporaryItems", "Xcode", "UPPERCASE-Ab12Cd"]) {
      const directory = join(r, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "commerce.sqlite"), "x");
      aged(directory, 72);
    }
    const result = run(r);
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["com.apple.ThreadCommissionerService", "TemporaryItems", "Xcode", "UPPERCASE-Ab12Cd"]) {
      expect(existsSync(join(r, name)), name).toBe(true);
    }
  });

  it("honours the age threshold and reports without deleting on --dry-run", () => {
    const r = root();
    const sixHours = fixture(r, "activation-Aa11Bb", 6);
    expect(run(r, "--older-than-hours", "12").status).toBe(0);
    expect(existsSync(sixHours), "younger than the threshold").toBe(true);

    const dry = run(r, "--older-than-hours", "1", "--dry-run");
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Would remove 1");
    expect(existsSync(sixHours), "--dry-run deletes nothing").toBe(true);

    expect(run(r, "--older-than-hours", "1").status).toBe(0);
    expect(existsSync(sixHours)).toBe(false);
  });

  it("refuses bad input rather than guessing", () => {
    const r = root();
    expect(run(r, "--older-than-hours", "soon").status).toBe(2);
    expect(run(r, "--nonsense").status).toBe(2);
    const missing = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, TEST_TEMP_GC_ROOT: join(r, "absent") } });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("TEST_TEMP_GC_ROOT_MISSING");
  });
});
