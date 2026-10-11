import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { ErasureInstallationEvidence } from "../../src/erasure-installation";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
});
/** Real permission/file checks; synthetic kernel mount adapter for non-root host
 * unit tests. Actual-image CI additionally verifies the real root-owned ro mount. */
export function installationFixture(state: "NEVER_INSTALLED" | "REQUIRED", fenceDirectory = "/fixture/fence",
  scope: "canary" | "production" = "canary") {
  const directory = mkdtempSync(join(tmpdir(), "erasure-host-admission-")); directories.push(directory);
  const policy = { version: 1, installationId: randomUUID(), scope, state, ...(state === "REQUIRED" ? { fenceDirectory } : {}) };
  writeFileSync(join(directory, "installation.json"), JSON.stringify(policy), { mode: 0o444 });
  chmodSync(directory, 0o555);
  const options = { directory, ownerUid: process.getuid!(), mountInfo: `1 0 0:1 / ${directory} ro - tmpfs fixture rw\n` };
  return { policy, options, read: () => ErasureInstallationEvidence.read({ DEPLOY_ENV: scope === "canary" ? "staging" : "production" }, options) };
}
