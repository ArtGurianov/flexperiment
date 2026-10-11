// Production migrations must not report success after an unsettled CLI import.
// Use the pinned CLI itself; do not retry it or substitute schema push.
import * as nodeModule from "node:module";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

process.once("beforeExit", () => {
  console.error("PAYLOAD_CLI_INCOMPLETE");
  process.exitCode = process.exitCode || 1;
});

// Same environment loader as the pinned Payload CLI, before selecting Lexical's
// static production/development export. No keys or environment values are logged.
const require = createRequire(import.meta.url);
const payloadRoot = pathResolve(dirname(require.resolve("payload")), "..");
const { loadEnv } = await import(pathToFileURL(pathResolve(payloadRoot, "dist/bin/loadEnv.js")).href);
loadEnv();
const condition = process.env.NODE_ENV === "production" ? "production" : "development";
const loader = new URL("./payload-cli-lexical-loader.mjs", import.meta.url);
if (typeof nodeModule.registerHooks === "function") {
  const { initialize, resolve } = await import(loader.href);
  initialize(condition);
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register(loader.href, import.meta.url, { data: condition });
}
