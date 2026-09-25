import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { deriveCandidate, type CommitTreeReader } from "../../src/release/candidate-publication";
import { ForwardSupersessionAdmissionGuard, GitHubCheckRunsAttestation, ReleaseAdmissionError, ReleaseAdmissionGuard, remoteMainTipRefresh, type InstalledRunner } from "../../src/release/forward-admission";
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

describe("release admission: what every deploy must prove first", () => {
  const release = (options: { main?: () => Promise<string>; runner?: InstalledRunner; attest?: { attest(sha: string): Promise<string> } } = {}) =>
    new ReleaseAdmissionGuard(tree(), options.main ?? (async () => MAIN), options.runner ?? runnerAt(), options.attest ?? ci());

  it("admits main's exact tip, run by itself, with green CI - no forward ancestry asked", async () => {
    await expect(release().admit(await mainCandidate())).resolves.toEqual({ ciEvidence: "ci-evidence" });
  });

  it("refuses every other case with its own code, DEPLOY_ADMISSION_REFUSED", async () => {
    const candidate = await mainCandidate();
    const cases: [string, ReleaseAdmissionGuard, typeof candidate, string][] = [
      ["a foreign class (a hand-edited file)", release(), { ...candidate, releaseClass: "ROLLING_COMPATIBLE" as never }, "RELEASE_CANDIDATE_INVALID"],
      ["main moved on", release({ main: async () => SIDE }), candidate, "is not main's tip"],
      ["another runner", release({ runner: runnerAt({ sha: SIDE }) }), candidate, `installed runner is ${SIDE}`],
      ["an edited runner", release({ runner: runnerAt({ clean: false }) }), candidate, "not clean"],
      ["CI not green", release({ attest: { attest: async () => { throw new Error("CI check test is completed/failure"); } } }), candidate, "admission evidence unreadable"],
    ];
    for (const [, guardFor, subject, detail] of cases) {
      const refused = guardFor.admit(subject);
      await expect(refused).rejects.toThrow("DEPLOY_ADMISSION_REFUSED");
      await expect(refused).rejects.toThrow(detail);
    }
  });

  it("passes a CI refusal through with its own detail", async () => {
    const attestation = new GitHubCheckRunsAttestation({ repository: "o/r", fetch: (async () => Response.json({ total_count: 0, check_runs: [] })) as typeof fetch });
    await expect(release({ attest: attestation }).admit(await mainCandidate())).rejects.toThrow(`DEPLOY_ADMISSION_REFUSED: CI check test missing for ${MAIN}`);
  });
});

describe("every refusal carries its guard's own code", () => {
  // The composition root's CI source when FLEXPERIMENT_CI_REPOSITORY is unset
  // throws an already-coded refusal. Each guard must still answer with its own.
  const unconfigured = { attest: async () => { throw new ReleaseAdmissionError("RELEASE_ADMISSION_REFUSED", "FLEXPERIMENT_CI_REPOSITORY is not configured"); } };

  it("forward-deploy: FORWARD_DEPLOY_ADMISSION_REFUSED, detail kept", async () => {
    await expect(guard({ attest: unconfigured }).admit(await mainCandidate(), binding))
      .rejects.toThrow("FORWARD_DEPLOY_ADMISSION_REFUSED: FLEXPERIMENT_CI_REPOSITORY is not configured");
  });

  it("deploy: DEPLOY_ADMISSION_REFUSED, detail kept", async () => {
    await expect(new ReleaseAdmissionGuard(tree(), async () => MAIN, runnerAt(), unconfigured).admit(await mainCandidate()))
      .rejects.toThrow("DEPLOY_ADMISSION_REFUSED: FLEXPERIMENT_CI_REPOSITORY is not configured");
  });
});

describe("forward supersession admission", () => {
  it("admits main's exact tip, descended from the current target, run by itself, with green CI", async () => {
    await expect(guard().admit(await mainCandidate(), binding)).resolves.toEqual({ ciEvidence: "ci-evidence" });
  });

  it("admits only a MAINTENANCE_REQUIRED candidate", async () => {
    // No other class exists; a file claiming one fails validation first.
    const foreign = { ...await mainCandidate(), releaseClass: "ROLLING_COMPATIBLE" as never };
    await expect(guard().admit(foreign, binding)).rejects.toThrow("RELEASE_CANDIDATE_INVALID");
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
  /** GitHub's shape: `total_count` is every run for the commit, `check_runs` this page of them. */
  const github = (body: { check_runs?: unknown[]; total_count?: number; message?: string }, status = 200, seen: { headers?: Record<string, string>; url?: string; signal?: AbortSignal | null } = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.headers = init?.headers as Record<string, string>;
      seen.signal = init?.signal;
      const full = body.check_runs && body.total_count === undefined ? { ...body, total_count: body.check_runs.length } : body;
      return new Response(JSON.stringify(full), { status });
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

  it("refuses when GitHub has more check runs than the page it returned", async () => {
    await expect(attest(github({ total_count: 150, check_runs: [run("test"), run("docker-build")] })))
      .rejects.toThrow("CI_ATTESTATION_INCOMPLETE: 150 check runs, 2 read");
  });

  it("reads GitHub with a bounded timeout", async () => {
    const seen: { signal?: AbortSignal | null } = {};
    await attest(github({ check_runs: [run("test"), run("docker-build")] }, 200, seen));
    expect(seen.signal).toBeInstanceOf(AbortSignal);
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

describe("the main tip admission reads", () => {
  it("refreshes origin/main from the trusted remote on every read", async () => {
    const MAIN = "a".repeat(40);
    const git = vi.fn(async () => "");
    const resolve = vi.fn(async () => MAIN);
    const commitTree = { list: async () => [], read: async () => "", isAncestor: async () => true, resolve } as unknown as CommitTreeReader;
    const refresh = remoteMainTipRefresh({ remote: "trusted-origin", cwd: "/repo", tree: commitTree, git });

    await expect(refresh()).resolves.toBe(MAIN);
    expect(git).toHaveBeenCalledWith(["fetch", "--no-tags", "trusted-origin", "main:refs/remotes/origin/main"], "/repo");
    expect(resolve).toHaveBeenCalledWith("origin/main");
  });
});
