import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { deriveCandidate, type CommitTreeReader } from "../../src/release/candidate-publication";
import { LaunchBaselineAdmissionGuard, remoteMainTipRefresh } from "../../src/release/launch-baseline-admission";

const MAIN = "a".repeat(40);
const NEXT = "b".repeat(40);
const STALE = "c".repeat(40);
const manifestJson = readFileSync("commerce/legal/production-manifest.json", "utf8");

const tree = (): CommitTreeReader => ({
  async list() { return ["0001_launch_baseline.sql", "0002_after.sql"]; },
  async read() { return manifestJson; },
  async isAncestor(ancestor, descendant) { return ancestor === descendant; },
  async resolve(ref) { return ref; },
});

const current = () => deriveCandidate(tree(), { sha: MAIN, releaseClass: "LAUNCH_BASELINE", mainRef: MAIN });

describe("launch baseline consumption admission", () => {
  it("admits the exact current-main artifact", async () => {
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => MAIN).admit(await current())).resolves.toBeUndefined();
  });

  it("rejects a stale artifact even when its derived expectation is byte-for-byte current", async () => {
    const candidate = { ...(await current()), id: STALE, sha: STALE } satisfies ReleaseCandidate;
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => MAIN).admit(candidate))
      .rejects.toThrow(`LAUNCH_BASELINE_MUST_BE_MAIN_TIP: ${STALE} != ${MAIN}`);
  });

  it("rejects a current commit carrying an expectation from another tree", async () => {
    const candidate = await current();
    const changed = {
      ...candidate,
      expectation: { ...candidate.expectation, legalVersion: "2026-09-20.2" },
    } satisfies ReleaseCandidate;
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => MAIN).admit(changed))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP");
  });

  it("fails closed when main changes during the final derivation window", async () => {
    const tips = [MAIN, NEXT];
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => tips.shift() ?? NEXT).admit(await current()))
      .rejects.toThrow(`LAUNCH_BASELINE_MUST_BE_MAIN_TIP: origin/main changed from ${MAIN} to ${NEXT}`);
  });

  it("normalizes an unreadable main/ref to the admission refusal", async () => {
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => { throw new Error("network unavailable"); }).admit(await current()))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP: origin/main unreadable");
  });

  it("normalizes invalid candidate bytes before tree admission", async () => {
    const invalid = { ...(await current()), sha: "not-a-sha" } as ReleaseCandidate;
    await expect(new LaunchBaselineAdmissionGuard(tree(), async () => MAIN).admit(invalid))
      .rejects.toThrow("LAUNCH_BASELINE_MUST_BE_MAIN_TIP: RELEASE_CANDIDATE_INVALID");
  });

  it("refreshes origin/main from the trusted remote on every read", async () => {
    const git = vi.fn(async () => "");
    const commitTree = tree();
    const resolve = vi.spyOn(commitTree, "resolve").mockResolvedValue(MAIN);
    const refresh = remoteMainTipRefresh({ remote: "trusted-origin", cwd: "/repo", tree: commitTree, git });

    await expect(refresh()).resolves.toBe(MAIN);
    expect(git).toHaveBeenCalledWith(
      ["fetch", "--no-tags", "trusted-origin", "main:refs/remotes/origin/main"],
      "/repo",
    );
    expect(resolve).toHaveBeenCalledWith("origin/main");
  });
});
