import { TEST_TEMP_ORIGINAL_TMPDIR_ENV, TEST_TEMP_ROOT_ENV } from "./vitest.setup.test-temp-run";

/**
 * Points this WORKER's temp directory at the run root created by globalSetup.
 *
 * os.tmpdir() re-reads $TMPDIR on every call rather than caching it, so this
 * redirects every existing `mkdtempSync(join(tmpdir(), ...))` call site in the
 * suite - 168 of them across 111 files - without touching any of them. Child
 * processes inherit it, so Node, Python and any `mktemp` invoked with an
 * explicit "${TMPDIR}/..." template land in the namespace too.
 *
 * It does NOT capture bare `mktemp -d` on macOS: BSD mktemp reads
 * confstr(_CS_DARWIN_USER_TEMP_DIR) and ignores $TMPDIR entirely, even though
 * the shell it runs in can see the variable. test-temp-run-root.test.ts pins
 * the call sites that escape for that reason, so the gap stays visible.
 *
 * Worker-scoped on purpose. Setting TMPDIR in globalSetup instead would put the
 * Vitest/Vite controller's own scratch state inside the tree we delete at
 * teardown, which is not state this suite owns.
 */
const runRoot = process.env[TEST_TEMP_ROOT_ENV];
if (runRoot) {
  // Kept so tests (and anything debugging a stray fixture) can still name the
  // real temp directory after os.tmpdir() has been pointed at the run root.
  process.env[TEST_TEMP_ORIGINAL_TMPDIR_ENV] = process.env.TMPDIR ?? "";
  process.env.TMPDIR = runRoot;
}
