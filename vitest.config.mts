import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["commerce/test/**/*.test.ts"], environment: "node" },
});
