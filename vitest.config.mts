import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.dirname(fileURLToPath(import.meta.url)),
    },
  },
  test: {
    include: [
      "commerce/test/**/*.test.ts",
      "apps/admin/**/*.test.ts",
      "components/**/*.test.ts",
      "lib/**/*.test.ts",
    ],
    environment: "node",
  },
});
