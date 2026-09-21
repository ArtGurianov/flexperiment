import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import setupTestTempRun, {
  OWNER_MARKER,
  TEST_TEMP_CONTAINER,
  TEST_TEMP_ORIGINAL_TMPDIR_ENV,
  TEST_TEMP_ROOT_ENV,
} from "../../vitest.setup.test-temp-run";

/**
 * The contract: a successful run leaves NOTHING in the OS temp directory, and
 * abnormal termination leaves something a collector can positively recognise as
 * ours. These prove containment from inside a worker, which is the only place
 * the redirect is supposed to apply.
 */

const runRoot = process.env[TEST_TEMP_ROOT_ENV];
// NOT os.tmpdir(): inside a worker that now resolves to the run root itself.
const originalTmpdir = process.env[TEST_TEMP_ORIGINAL_TMPDIR_ENV];
const container = () => dirname(runRoot!);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const canonical = (path: string) => realpathSync(path);
const marker = (root: string) => JSON.parse(readFileSync(join(root, OWNER_MARKER), "utf8"));

describe("test temp run root", () => {
  it("exposes one owned run root to the worker", () => {
    expect(runRoot, `${TEST_TEMP_ROOT_ENV} must be set by globalSetup`).toBeTruthy();
    expect(existsSync(runRoot!)).toBe(true);
    // The container is the single exact parent a namespace-aware GC will
    // canonicalise against, instead of matching directory name shapes.
    expect(canonical(container())).toBe(join(canonical(originalTmpdir!), TEST_TEMP_CONTAINER));
  });

  it("carries an ownership marker that proves who made it", () => {
    const owner = marker(runRoot!);
    expect(owner.schema_version).toBe(1);
    expect(owner.owner).toBe("flexperiment-test-run");
    expect(owner.run_id).toMatch(/^run-/);
    expect(Number.isInteger(owner.pid)).toBe(true);
    expect(Date.parse(owner.created_at)).not.toBeNaN();
  });

  /**
   * Cardinality. Vitest instantiates the globalSetup module once per inline
   * project PLUS once for the root config, so this suite's topology calls it
   * four times - and every call shares the Vitest main process. If the env
   * singleton failed to dedupe, each call would create its own root and all of
   * them would carry that same pid, so counting roots by pid is the proof.
   */
  it("creates exactly one run root per run, not one per project", () => {
    const mine = readdirSync(container())
      .map((entry) => join(container(), entry))
      .filter((path) => existsSync(join(path, OWNER_MARKER)))
      .filter((path) => marker(path).pid === process.ppid);
    expect(mine, `one root for main process ${process.ppid}`).toHaveLength(1);
    expect(canonical(mine[0])).toBe(canonical(runRoot!));
  });

  it("contains temp directories created through node's os.tmpdir()", () => {
    const probe = mkdtempSync(join(tmpdir(), "node-containment-probe-"));
    try {
      expect(canonical(probe).startsWith(canonical(runRoot!))).toBe(true);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  /**
   * The shell case is why the redirect lives in the environment rather than in
   * a TypeScript helper: no helper a test imports can reach a shell fixture.
   * Children inherit TMPDIR, so the repo's standard `${TMPDIR}` template form
   * lands in the namespace.
   */
  it("contains child-process temp dirs created with an explicit TMPDIR template", () => {
    const result = spawnSync("bash", ["-c", 'mktemp -d "${TMPDIR:-/tmp}/child-probe.XXXXXX"'], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const probe = result.stdout.trim();
    try {
      expect(canonical(probe).startsWith(canonical(runRoot!))).toBe(true);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  });

  /**
   * The known hole, pinned rather than assumed. macOS BSD mktemp resolves
   * confstr(_CS_DARWIN_USER_TEMP_DIR) and ignores $TMPDIR even when the shell
   * it runs in can see the variable, so a BARE `mktemp`/`mktemp -d` escapes the
   * namespace. Node and Python both honour $TMPDIR; only this one does not.
   *
   * All five remove their own temporary state on a normal exit, so this is not
   * a steady leak. What it costs is recoverability: anything they leave behind
   * on an ABNORMAL exit lands outside the namespace, where a namespace-scoped
   * collector will never see it.
   *
   * Pinning the exact call sites keeps the gap visible and stops it growing:
   * a new bare mktemp fails here, and converting one to the template form
   * (P1) fails here too, which is the prompt to shorten this list.
   */
  it("pins the shell call sites that escape the namespace", () => {
    // This probe really does create a directory, and because the point of it is
    // that the directory escapes the namespace, nothing else will ever collect
    // it - so it has to remove its own. Leaving it behind made every full suite
    // report exactly +1 top-level entry.
    const escaped = spawnSync("bash", ["-c", 'TMPDIR="$1" mktemp -d', "_", "/nonexistent-probe-root"], {
      encoding: "utf8",
    }).stdout.trim();
    try {
      expect(
        escaped.startsWith("/nonexistent-probe-root"),
        "if this ever becomes true, mktemp started honouring TMPDIR and the list below can go",
      ).toBe(false);
    } finally {
      if (escaped) rmSync(escaped, { recursive: true, force: true });
    }

    const found = spawnSync(
      "bash",
      ["-c", `grep -rlE '\\$\\(mktemp( -d)?\\)' --include='*.sh' . | grep -v node_modules | sort`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout.trim().split("\n").filter(Boolean)).toEqual([
      "./deploy/test-admin-nginx-config.sh",
      "./deploy/test-frontend-nginx-routing.sh",
    ]);
  });

  /**
   * Abnormal termination. A run that is SIGKILLed never runs its teardown, and
   * what it leaves has to be recognisable as ours rather than anonymous. This
   * drives the module directly and deliberately never calls the teardown it
   * returns.
   */
  it("leaves a marked root behind when teardown never runs", () => {
    const saved = process.env[TEST_TEMP_ROOT_ENV];
    delete process.env[TEST_TEMP_ROOT_ENV];
    let abandoned: string | undefined;
    try {
      const teardown = setupTestTempRun();
      abandoned = process.env[TEST_TEMP_ROOT_ENV];
      expect(teardown, "a creating call returns a teardown").toBeTypeOf("function");
      expect(abandoned).toBeTruthy();
      // Never invoked - this is the crash.
      expect(existsSync(abandoned!)).toBe(true);
      expect(marker(abandoned!).owner).toBe("flexperiment-test-run");
    } finally {
      if (abandoned) rmSync(abandoned, { recursive: true, force: true });
      process.env[TEST_TEMP_ROOT_ENV] = saved;
    }
  });

  it("is idempotent: a second call adopts the existing root", () => {
    expect(setupTestTempRun(), "a non-creating call must not return a teardown").toBeUndefined();
    expect(process.env[TEST_TEMP_ROOT_ENV]).toBe(runRoot);
  });
});
