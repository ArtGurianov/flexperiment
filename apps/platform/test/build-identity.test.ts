import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildIdentity } from "../lib/build-identity";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("platform build identity", () => {
  it("reads the immutable image artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-platform-identity-"));
    directories.push(directory);
    const target = join(directory, "identity.json");
    execFileSync(process.execPath, [resolve(import.meta.dirname, "../../../scripts/write-build-identity.mjs"), target, "platform"], {
      env: { ...process.env, SOURCE_COMMIT: "c".repeat(40) },
    });
    expect(statSync(target).mode & 0o777).toBe(0o444);
    expect(readBuildIdentity("platform", { BUILD_IDENTITY_FILE: target })).toEqual({
      schema: "flexperiment.build-identity/1",
      service: "platform",
      sourceCommit: "c".repeat(40),
    });
  });
});
