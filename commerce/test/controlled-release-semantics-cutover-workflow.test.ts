import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseSemanticsPaths } from "../src/generic-production-deploy-boundary";

const workflow = readFileSync(".github/workflows/controlled-release-semantics-cutover.yml", "utf8");
const generic = readFileSync(".github/workflows/controlled-production-deploy.yml", "utf8");

const assertBoundary = (paths: readonly string[]) => {
  const file = join(mkdtempSync(join(tmpdir(), "release-semantics-boundary-")), "paths.bin");
  writeFileSync(file, paths.join("\0"));
  try {
    execFileSync("node", ["--import", "tsx", "commerce/src/assert-release-semantics-cutover-boundary.ts", file], { encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: "" };
  } catch (error) {
    const failure = error as { stderr?: string };
    return { ok: false, output: (failure.stderr ?? "").trim() };
  }
};

/**
 * This lane can carry release-control changes that the generic controller
 * refuses. That makes its admission test the only thing standing between a
 * purpose-built cutover and a general-purpose way around the boundary, so the
 * tests below are mostly about what it must REFUSE.
 */
describe("controlled release-semantics cutover", () => {
  it("admits a change that is exactly release-semantic", () => {
    expect(assertBoundary([...releaseSemanticsPaths]).ok).toBe(true);
    expect(assertBoundary(["commerce/src/release-control.ts", "commerce/src/domain.ts"]).ok).toBe(true);
  });

  it("refuses a benign change and names the lane that proves more about it", () => {
    const result = assertBoundary(["docs/release/DEPLOYMENT_INVARIANTS.md", "README.md"]);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("RELEASE_SEMANTICS_CUTOVER_CHANGE_IS_BENIGN_USE_GENERIC_DEPLOY");
  });

  it.each([
    ["a migration", "commerce/migrations/0039_x.sql", "SCHEMA"],
    ["a legal document", "public/legal/privacy-policy.md", "LEGAL"],
    ["a legal manifest", "commerce/legal/production-manifest.json", "LEGAL"],
    ["a surface contract", "release-surface-contract.json", "SURFACE_CONTRACT"],
  ])("refuses %s even when bundled with release-semantic files", (_label, path, category) => {
    const result = assertBoundary(["commerce/src/release-control.ts", path]);
    expect(result.ok, `${path} was admitted into the release-semantics lane`).toBe(false);
    expect(result.output).toContain(`RELEASE_SEMANTICS_CUTOVER_BOUNDARY_TOO_WIDE=${category}`);
  });

  it("shares the generic controller's concurrency group", () => {
    // Two controllers pausing and CAS-ing production concurrently is the one
    // interleaving neither is written to survive.
    const group = (source: string) => /concurrency:\s*\n\s*group:\s*(\S+)/.exec(source)?.[1];
    expect(group(workflow)).toBe(group(generic));
    expect(group(workflow)).toBeTruthy();
  });

  it("keeps the production environment gate", () => {
    expect(workflow).toContain("environment: production");
  });

  it("uses the strict admission script, never the generic one", () => {
    expect(workflow).toContain("pnpm commerce:release-semantics-cutover:assert-boundary");
    expect(workflow).not.toContain("pnpm commerce:production-deploy:assert-boundary");
  });

  it("pauses before it deploys and reopens only after convergence", () => {
    const pause = workflow.indexOf("Acquire owner and pause registrations");
    const provePause = workflow.indexOf("Prove public checkout pause before deployment");
    const deploy = workflow.indexOf("Deploy exact production candidate");
    const reopen = workflow.indexOf("Prove all surfaces and guarded reopen");
    for (const index of [pause, provePause, deploy, reopen]) expect(index).toBeGreaterThan(-1);
    expect(provePause).toBeGreaterThan(pause);
    expect(deploy).toBeGreaterThan(provePause);
    expect(reopen).toBeGreaterThan(deploy);
  });

  it("differs from the generic controller only in its admission test", () => {
    // The value of this lane is that it is the same machinery. If it drifts,
    // it stops being the generic path with a stricter door and becomes a second
    // deployment implementation to keep correct.
    const strip = (source: string) =>
      source
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .filter((line) => !line.startsWith("name: Controlled "))
        .join("\n")
        .replace(/commerce:(production-deploy|release-semantics-cutover):assert-boundary/g, "ASSERT_BOUNDARY");
    expect(strip(workflow)).toBe(strip(generic));
  });
});
