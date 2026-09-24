import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { deriveCandidate, type CommitTreeReader } from "../../src/release/candidate-publication";
import { ForwardSupersessionAdmissionGuard, GitHubCheckRunsAttestation, type InstalledRunner } from "../../src/release/forward-admission";
import type { ReleaseBinding } from "../../src/release/forward-target";

/**
 * Admission of a NEW forward revision, and the CI it rests on.
 *
 * Every rule refuses on its own: the class, main's tip read fresh, the
 * re-derivation, forward-only ancestry, the runner being the candidate, and
 * the exact-SHA CI attestation - which is what makes the real-router
 * certification E2E a gate rather than a convention.
 */

const CURRENT = "a".repeat(40);
const MAIN = "b".repeat(40);
const SIDE = "c".repeat(40);
const manifest = readFileSync("commerce/legal/production-manifest.json", "utf8");
const binding: ReleaseBinding = { revision: 0, targetSha: CURRENT, candidateId: CURRENT };

const tree = (over: Partial<CommitTreeReader> = {}): CommitTreeReader => ({
  async list() { return ["0001_launch_baseline.sql", "0004_deploy_session_forward_targets.sql"]; },
  async read() { return manifest; },
  async isAncestor(ancestor, descendant) { return ancestor === descendant || (ancestor === CURRENT && descendant === MAIN); },
  async resolve(ref) { return ref; },
  ...over,
});

const mainCandidate = () => deriveCandidate(tree(), { sha: MAIN, releaseClass: "MAINTENANCE_REQUIRED", mainRef: MAIN });
const runnerAt = (over: Partial<Awaited<ReturnType<InstalledRunner>>> = {}): InstalledRunner =>
  async () => ({ sha: MAIN, tree: "t".repeat(40), candidateTree: "t".repeat(40), clean: true, ...over });
const ci = (evidence = "ci-evidence") => ({ attest: async () => evidence });
const guard = (options: { tree?: CommitTreeReader; main?: () => Promise<string>; runner?: InstalledRunner; attest?: { attest(sha: string): Promise<string> } } = {}) =>
  new ForwardSupersessionAdmissionGuard(options.tree ?? tree(), options.main ?? (async () => MAIN), options.runner ?? runnerAt(), options.attest ?? ci());

describe("forward supersession admission", () => {
  it("admits main's exact tip, descended from the current target, run by itself, with green CI", async () => {
    await expect(guard().admit(await mainCandidate(), binding)).resolves.toEqual({ ciEvidence: "ci-evidence" });
  });

  it("admits only a MAINTENANCE_REQUIRED candidate", async () => {
    const launch = await deriveCandidate(tree(), { sha: MAIN, releaseClass: "LAUNCH_BASELINE", mainRef: MAIN });
    await expect(guard().admit(launch, binding)).rejects.toThrow("is LAUNCH_BASELINE");
  });

  it("refuses a candidate that is not main's tip, read afresh", async () => {
    await expect(guard({ main: async () => SIDE }).admit(await mainCandidate(), binding)).rejects.toThrow("is not main's tip");
  });

  it("refuses when main moves while it is being inspected", async () => {
    let reads = 0;
    await expect(guard({ main: async () => (reads++ === 0 ? MAIN : SIDE) }).admit(await mainCandidate(), binding))
      .rejects.toThrow(`origin/main changed from ${MAIN} to ${SIDE}`);
  });

  it("refuses an artifact that does not re-derive from its own commit", async () => {
    const edited = { ...(await mainCandidate()), expectation: { ...(await mainCandidate()).expectation, legalVersion: "2099-01-01.1" } } satisfies ReleaseCandidate;
    await expect(guard().admit(edited, binding)).rejects.toThrow("does not re-derive");
  });

  it("refuses the current target, and anything the current target is not an ancestor of", async () => {
    await expect(guard().admit(await mainCandidate(), { ...binding, targetSha: MAIN })).rejects.toThrow("is the current target");
    await expect(guard().admit(await mainCandidate(), { ...binding, targetSha: SIDE })).rejects.toThrow(`${SIDE} is not an ancestor of ${MAIN}`);
  });

  it("refuses a runner that is not exactly the candidate, or has been edited", async () => {
    const candidate = await mainCandidate();
    await expect(guard({ runner: runnerAt({ sha: SIDE }) }).admit(candidate, binding)).rejects.toThrow(`installed runner is ${SIDE}`);
    await expect(guard({ runner: runnerAt({ tree: "u".repeat(40) }) }).admit(candidate, binding)).rejects.toThrow("installed runner tree");
    await expect(guard({ runner: runnerAt({ clean: false }) }).admit(candidate, binding)).rejects.toThrow("not clean");
  });

  it("refuses when CI cannot attest the exact commit", async () => {
    const failing = { attest: async () => { throw new Error("FORWARD_DEPLOY_ADMISSION_REFUSED: CI check test is completed/failure"); } };
    await expect(guard({ attest: failing }).admit(await mainCandidate(), binding)).rejects.toThrow("FORWARD_DEPLOY_ADMISSION_REFUSED");
  });

  it("never lets a git error's detail out", async () => {
    const leaky = tree({ async isAncestor() { throw new Error("fatal: https://user:secret@github.com/x unreachable"); } });
    const error = await guard({ tree: leaky }).admit(await mainCandidate(), binding).catch((caught: Error) => caught);
    expect(String(error)).toContain("FORWARD_DEPLOY_ADMISSION_REFUSED");
    expect(String(error)).not.toContain("secret");
  });
});

describe("the exact-SHA CI attestation", () => {
  const run = (name: string, over: Record<string, unknown> = {}) =>
    ({ id: Math.floor(Math.random() * 1e6), name, head_sha: MAIN, status: "completed", conclusion: "success", completed_at: "2026-09-24T10:00:00Z", ...over });
  const github = (body: unknown, status = 200, seen: { headers?: Record<string, string>; url?: string } = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify(body), { status });
    }) as typeof globalThis.fetch;
  const attest = (fetch: typeof globalThis.fetch, tokenFile?: string) =>
    new GitHubCheckRunsAttestation({ repository: "ArtGurianov/flexperiment", fetch, tokenFile, now: () => new Date("2026-09-24T11:00:00Z") }).attest(MAIN);

  it("returns evidence when every required check for exactly this commit succeeded", async () => {
    const seen: { url?: string } = {};
    const evidence = JSON.parse(await attest(github({ check_runs: [run("test"), run("docker-build"), run("unrelated", { conclusion: "failure" })] }, 200, seen)));
    expect(seen.url).toBe(`https://api.github.com/repos/ArtGurianov/flexperiment/commits/${MAIN}/check-runs?per_page=100`);
    expect(evidence).toMatchObject({ sha: MAIN, checks: [{ name: "test", conclusion: "success" }, { name: "docker-build", conclusion: "success" }] });
  });

  it.each([
    ["a required check is missing", { check_runs: [run("test")] }, "docker-build missing"],
    ["a required check failed", { check_runs: [run("test", { conclusion: "failure" }), run("docker-build")] }, "test is completed/failure"],
    ["a required check is still running", { check_runs: [run("test", { status: "in_progress", conclusion: null }), run("docker-build")] }, "test is in_progress/null"],
    ["any run of a required check failed", { check_runs: [run("test"), run("test", { conclusion: "cancelled" }), run("docker-build")] }, "test is completed/cancelled"],
    ["a check is for another commit", { check_runs: [run("test", { head_sha: SIDE }), run("docker-build")] }, `test is for ${SIDE}`],
  ])("refuses when %s", async (_label, body, message) => {
    await expect(attest(github(body))).rejects.toThrow(message);
  });

  it("refuses when GitHub cannot be read", async () => {
    await expect(attest(github({ message: "rate limited" }, 403))).rejects.toThrow("CI attestation unreadable (HTTP 403)");
    await expect(attest((async () => { throw new Error("ENOTFOUND"); }) as typeof globalThis.fetch)).rejects.toThrow("CI attestation unreadable");
  });

  it("sends a configured token in a header, read fresh, and never in the URL", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "forward-ci-token-")), "token");
    writeFileSync(file, "github-token-value\n");
    const seen: { headers?: Record<string, string>; url?: string } = {};
    await attest(github({ check_runs: [run("test"), run("docker-build")] }, 200, seen), file);
    expect(seen.headers?.Authorization).toBe("Bearer github-token-value");
    expect(seen.url).not.toContain("github-token-value");
  });
});
