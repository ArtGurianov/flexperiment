import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBuildIdentity } from "../src/build-identity";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("baked build identity", () => {
  it("writes a validated read-only artifact and reads that instead of a mutable environment claim", () => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-build-identity-"));
    directories.push(directory);
    const target = join(directory, "identity.json");
    const sourceCommit = "a".repeat(40);
    execFileSync(process.execPath, [resolve("scripts/write-build-identity.mjs"), target, "commerce-v2"], {
      env: { ...process.env, SOURCE_COMMIT: sourceCommit },
    });

    expect(statSync(target).mode & 0o777).toBe(0o444);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      schema: "flexperiment.build-identity/1",
      service: "commerce-v2",
      sourceCommit,
    });
    expect(readBuildIdentity("commerce-v2", { BUILD_IDENTITY_FILE: target, SOURCE_COMMIT: "b".repeat(40) })).toEqual({
      schema: "flexperiment.build-identity/1",
      service: "commerce-v2",
      sourceCommit,
    });
  });

  it("fails closed on a missing, malformed or wrong-service artifact", () => {
    expect(() => readBuildIdentity("commerce-v2", { BUILD_IDENTITY_FILE: "/does/not/exist" })).toThrow("BUILD_IDENTITY_UNREADABLE");
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-build-identity-wrong-"));
    directories.push(directory);
    const target = join(directory, "identity.json");
    execFileSync(process.execPath, [resolve("scripts/write-build-identity.mjs"), target, "platform"], {
      env: { ...process.env, SOURCE_COMMIT: "a".repeat(40) },
    });
    expect(() => readBuildIdentity("commerce-v2", { BUILD_IDENTITY_FILE: target })).toThrow("BUILD_IDENTITY_INVALID");
  });
});
