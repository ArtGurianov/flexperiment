import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

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
    globalSetup: ["./vitest.setup.test-db-snapshot.ts"],
    setupFiles: ["./vitest.setup.test-db-snapshot-worker.ts"],
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
          exclude: [...configDefaults.exclude, "apps/admin/**/*.dom.test.tsx", "components/**/*.dom.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["apps/admin/**/*.dom.test.tsx", "components/**/*.dom.test.tsx"],
          setupFiles: ["./vitest.setup.test-db-snapshot-worker.ts", "./vitest.setup.dom.ts"],
        },
      },
    ],
  },
});
