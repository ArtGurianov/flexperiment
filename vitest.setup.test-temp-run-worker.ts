import { TEST_TEMP_ROOT_ENV } from "./vitest.setup.test-temp-run";

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
 * the shell it runs in can see the variable. The five scripts that do this all
 * remove their own temporary state on a normal exit, so the cost is not a
 * steady leak; what it costs is recoverability, because anything they leave
 * behind on an abnormal exit lands OUTSIDE the namespace where a
 * namespace-scoped collector will never see it. test-temp-run-root.test.ts
 * pins that list so it cannot grow unnoticed.
 *
 * Worker-scoped on purpose. Setting TMPDIR in globalSetup instead would put the
 * Vitest/Vite controller's own scratch state inside the tree we delete at
 * teardown, which is not state this suite owns.
 *
 * The controller resolves the real temp directory and publishes it; this does
 * not try to reconstruct it from $TMPDIR, which is unset on some CI runners.
 */
const runRoot = process.env[TEST_TEMP_ROOT_ENV];
if (runRoot) process.env.TMPDIR = runRoot;
