import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeStaticReleaseDescriptor } from "../src/write-static-release-descriptor";
import { writeAdminReleaseDescriptor } from "../../apps/admin/scripts/write-release-descriptor.mjs";

const temporaryDirectories: string[] = [];
const sourceCommit = "30d2201e2535510d98af64e56aff2c379d0e6601";

function temporaryOutput(name: string) {
  const directory = mkdtempSync(join(tmpdir(), "flexperiment-release-descriptor-"));
  temporaryDirectories.push(directory);
  return join(directory, name, "release.json");
}

function readDescriptor(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("static release descriptors", () => {
  it("rejects missing and malformed frontend source commits", () => {
    expect(() => writeStaticReleaseDescriptor({ output: temporaryOutput("missing") })).toThrow("SOURCE_COMMIT");
    expect(() => writeStaticReleaseDescriptor({ sourceCommit: "not-a-sha", output: temporaryOutput("malformed") })).toThrow("SOURCE_COMMIT");
  });

  it("writes the supplied immutable frontend source commit into the static artifact", () => {
    const output = temporaryOutput("frontend");
    writeStaticReleaseDescriptor({ sourceCommit, output });

    expect(readDescriptor(output)).toEqual({ source_commit: sourceCommit, checkout_contract_version: "sales-availability-v1" });
  });

  it("rejects missing and malformed admin source commits", () => {
    expect(() => writeAdminReleaseDescriptor({ output: temporaryOutput("admin-missing") })).toThrow("SOURCE_COMMIT");
    expect(() => writeAdminReleaseDescriptor({ sourceCommit: "A".repeat(40), output: temporaryOutput("admin-malformed") })).toThrow("SOURCE_COMMIT");
  });

  it("writes the supplied immutable admin source commit into the static artifact", () => {
    const output = temporaryOutput("admin");
    writeAdminReleaseDescriptor({ sourceCommit, output });

    expect(readDescriptor(output)).toEqual({ source_commit: sourceCommit, admin_contract_version: "sales-availability-v1" });
  });

  it("copies both static exports, including release.json, into their final nginx images", () => {
    const frontendDockerfile = readFileSync("Dockerfile.frontend", "utf8");
    const adminDockerfile = readFileSync("Dockerfile.admin", "utf8");

    expect(frontendDockerfile).toContain("ARG SOURCE_COMMIT");
    expect(frontendDockerfile).toContain("ENV SOURCE_COMMIT=${SOURCE_COMMIT}");
    expect(frontendDockerfile).toContain("RUN pnpm build");
    expect(frontendDockerfile).toContain("COPY --from=build /app/out /usr/share/nginx/html");
    expect(adminDockerfile).toContain("ARG SOURCE_COMMIT");
    expect(adminDockerfile).toContain("ENV SOURCE_COMMIT=${SOURCE_COMMIT}");
    expect(adminDockerfile).toContain("COPY release-surface-contract.json ./");
    expect(adminDockerfile.indexOf("COPY release-surface-contract.json ./")).toBeLessThan(adminDockerfile.indexOf("RUN pnpm --filter @flexperiment/admin build"));
    expect(adminDockerfile).toContain("COPY --from=build /app/apps/admin/out /usr/share/nginx/html");
  });
});
