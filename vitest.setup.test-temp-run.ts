import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives one test RUN one owned temp namespace, and deletes the whole namespace
 * at the end. A successful run must leave nothing behind in the OS temp
 * directory; scripts/test-temp-gc.sh exists only to recover what abnormal
 * termination leaves.
 *
 * Why the env var rather than module state: Vitest instantiates this module
 * once per inline project PLUS once for the root config - a 3-project run calls
 * the default export four times, each with its OWN module instance, so a
 * module-level `let` is four separate variables and cannot dedupe. All four
 * calls do share one process, so process.env is the only singleton available.
 * Proved in test-temp-run-root.test.ts rather than assumed: Vitest's docs say
 * root globalSetup is not inherited by inline projects, and in this repo's
 * topology it demonstrably is.
 *
 * The creating call is the only one that tears down. Teardowns all fire after
 * every project has finished, so no teardown can delete the root out from under
 * a still-running project, but they fire in arbitrary order - hence "the
 * creator cleans up" rather than "the last one cleans up".
 */

/** The single container every run root lives in, so the future namespace-aware
 *  GC can canonicalise one exact parent instead of matching name shapes. */
export const TEST_TEMP_CONTAINER = "flexperiment-tests";
export const TEST_TEMP_ROOT_ENV = "FLEXPERIMENT_TEST_TEMP_ROOT";
/** The worker's real TMPDIR, preserved before the redirect. */
export const TEST_TEMP_ORIGINAL_TMPDIR_ENV = "FLEXPERIMENT_TEST_ORIGINAL_TMPDIR";

export const OWNER_MARKER = ".owner.json";
const OWNER = "flexperiment-test-run";
const SCHEMA_VERSION = 1;

/** du(1) rather than a recursive walk: the tree is thousands of files and this
 *  runs on every suite. A failure here must never fail the run - it is a
 *  metric, not an invariant. The invariant is the existsSync check below. */
const footprintKb = (path: string): number | undefined => {
  const result = spawnSync("du", ["-skx", path], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const parsed = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const humanMb = (kb: number | undefined) => (kb === undefined ? "unknown" : `${(kb / 1024).toFixed(1)} MiB`);

export default function setupTestTempRun() {
  // A second, third or fourth call for the same run: the root already exists.
  if (process.env[TEST_TEMP_ROOT_ENV]) return;

  // realpath so the recorded parent is canonical - on macOS $TMPDIR is a
  // symlinked /var/folders path, and the GC will compare canonical parents.
  const container = join(realpathSync(tmpdir()), TEST_TEMP_CONTAINER);
  mkdirSync(container, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(join(container, "run-"));

  writeFileSync(
    join(runRoot, OWNER_MARKER),
    `${JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        owner: OWNER,
        run_id: runRoot.slice(runRoot.lastIndexOf("run-")),
        created_at: new Date().toISOString(),
        // Diagnostic only. This must never gain deletion-authority semantics:
        // PIDs are reused, and a reused PID would make a dead run look alive.
        pid: process.pid,
        // Also diagnostic. The GC derives the real location from the path it
        // is scanning and never trusts a path declared inside a marker.
        tmpdir_parent: container,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // Inherited by every worker forked after this point, and by every child
  // process those workers spawn - which is what puts `mktemp -d` in shell
  // fixtures inside the namespace too. Deliberately NOT process.env.TMPDIR:
  // that is set per worker, so the Vitest controller keeps the real TMPDIR and
  // its own scratch state stays outside what we delete.
  process.env[TEST_TEMP_ROOT_ENV] = runRoot;

  return () => {
    const before = footprintKb(runRoot);
    rmSync(runRoot, { recursive: true, force: true });
    delete process.env[TEST_TEMP_ROOT_ENV];

    // The proof, not the log line. A reported "residual 0 B" that nobody
    // checks is exactly the kind of observational invariant that let the
    // prefix registry drift.
    if (existsSync(runRoot)) throw new Error(`TEST_TEMP_TEARDOWN_RESIDUAL: ${runRoot}`);

    console.log(
      `test temp: footprint before teardown ${humanMb(before)}, reclaimed ${humanMb(before)}, residual 0 B (${runRoot})`,
    );
  };
}
