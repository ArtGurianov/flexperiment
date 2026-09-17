import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// test/export/** is deliberately absent: those run in their own project, and
// only after a build. See the `export` project below.
const nodeInclude = [
  "commerce/test/**/*.test.ts",
  "apps/admin/**/*.test.ts",
  "components/**/*.test.ts",
  "lib/**/*.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    globalSetup: ["./vitest.setup.test-temp-run.ts", "./vitest.setup.test-db-snapshot.ts"],
    setupFiles: ["./vitest.setup.test-temp-run-worker.ts", "./vitest.setup.test-db-snapshot-worker.ts"],
    // Workflow-contract cases intentionally run bounded shell-process
    // matrices. The contract remains the same, but 5s is insufficient when
    // all Vitest workers compete for local CPU and filesystem resources.
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: nodeInclude,
          // A .dom.test.tsx picked up by the widened admin glob above would
          // otherwise run in both environments.
          exclude: [...configDefaults.exclude, "apps/admin/**/*.dom.test.tsx", "components/**/*.dom.test.tsx", "hooks/**/*.dom.test.tsx"],
        },
      },
      {
        // Asserts against the BUILT EXPORT in out/, so it only makes sense
        // after `pnpm build` — CI runs it immediately afterwards, and the
        // helpers fail with that instruction rather than a bare ENOENT.
        //
        // It needs its own project because neither existing glob reaches the
        // repo root: `node` covers commerce/, apps/admin/, components/ and
        // lib/, and `jsdom` only *.dom.test.tsx. A conformance test placed
        // anywhere else would belong to no project and silently never run.
        extends: true,
        test: {
          name: "export",
          environment: "node",
          include: ["test/export/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          // hooks/ is included because a client hook's test belongs beside it,
          // and a *.dom.test.tsx outside every project's glob belongs to no
          // project and silently never runs — the same trap that let the
          // event/city social-image defect ship untested.
          include: [
            "apps/admin/**/*.dom.test.tsx",
            "components/**/*.dom.test.tsx",
            "hooks/**/*.dom.test.tsx",
          ],
          setupFiles: ["./vitest.setup.test-temp-run-worker.ts", "./vitest.setup.test-db-snapshot-worker.ts", "./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
