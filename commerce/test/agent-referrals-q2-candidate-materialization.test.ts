import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  reconstructControlledCandidateSha,
  type ControlledCandidateCertificate,
} from "../src/controlled-candidate";

/**
 * Q2: the fresh Agent Referrals candidate rematerialized with Q2^ == B2 (the
 * release-semantics bootstrap candidate, now production's actual
 * production-deploy). PR #61's old candidate (Q, Q^ == P) is permanently
 * obsolete - production no longer runs P. This proves the fresh materialization
 * the same way commerce/test/agent-referrals-candidate-materialization.test.ts
 * and commerce/test/release-semantics-bootstrap-candidate-materialization.test.ts
 * already prove their own candidates, reusing the same generic
 * RECONSTRUCTION_BOUND core (commerce/src/controlled-candidate.ts) both of
 * those already use - no new reconstruction module was needed.
 */
const B2_SHA = "f540b997d6d31a22293909ded7ce464c3f51732f";
const SOURCE_MAIN_SHA = "af019452a60b6e968e326eb4684641c5d33cfa58";
const TARGET_Q2 = "a264ee68f597e7a40b6fe4b05359d99365be9149";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-${B2_SHA}/certificate.json`;
const MIGRATIONS = [
  "0042_agent_referrals_agents_rebuild.sql",
  "0043_agent_referrals_foundation.sql",
  "0044_partner_identity.sql",
  "0045_engagement_publication.sql",
  "0046_attribution_reward.sql",
  "0047_act_payment_settlement.sql",
  "0048_ord_reporting.sql",
  "0049_agent_referrals_integration_hardening.sql",
] as const;

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

describe("Agent Referrals Q2 committed materialization", () => {
  it("reconstructs the pinned detached candidate Q2 from the committed controller tree", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;

    expect(certificate.base_sha).toBe(B2_SHA);
    expect(certificate.source_main_sha).toBe(SOURCE_MAIN_SHA);
    expect(certificate.patch_source).toBe("controller_tree");
    expect(git("merge-base", "--is-ancestor", certificate.source_main_sha, controllerSha)).toBe("");
    expect(reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha })).toBe(TARGET_Q2);

    const changedPaths = git("diff", "--name-only", B2_SHA, TARGET_Q2).split("\n").filter(Boolean).sort();
    expect(changedPaths).toEqual(certificate.paths.map((entry) => entry.path).sort());
    expect(changedPaths).toHaveLength(91);
    expect(changedPaths.some((path) => path.startsWith("public/legal/") || path.startsWith("commerce/legal/"))).toBe(false);
    // B2's own certified inheritance - never a second, Q2-owned patch for
    // the schema file B2 already created.
    expect(changedPaths).not.toContain("commerce/src/release-control-schema.ts");
    expect(spawnSync("git", ["cat-file", "-e", `${TARGET_Q2}:${CERTIFICATE_PATH}`]).status).not.toBe(0);

    for (const migration of MIGRATIONS) {
      expect(git("rev-parse", `${TARGET_Q2}:commerce/migrations/${migration}`)).toBe(git("rev-parse", `${SOURCE_MAIN_SHA}:commerce/migrations/${migration}`));
    }
    // No migration beyond the immutable 0042-0049 set - the migration
    // invariant this PR must not silently widen.
    expect(changedPaths.filter((path) => path.startsWith("commerce/migrations/"))).toHaveLength(MIGRATIONS.length);
  }, 30_000);

  it("Q2^ == B2 (the release-semantics bootstrap candidate, now production's actual production-deploy)", () => {
    expect(git("rev-parse", `${TARGET_Q2}^`)).toBe(B2_SHA);
  });

  it("commerce/src/release-control-schema.ts is inherited from B2 unchanged - byte-identical, never re-certified by Q2", () => {
    expect(git("rev-parse", `${TARGET_Q2}:commerce/src/release-control-schema.ts`)).toBe(git("rev-parse", `${B2_SHA}:commerce/src/release-control-schema.ts`));
  });

  it("Q2's release-control.ts genuinely adds ROLLING completion machinery B2 does not have", () => {
    const q2Blob = git("rev-parse", `${TARGET_Q2}:commerce/src/release-control.ts`);
    const b2Blob = git("rev-parse", `${B2_SHA}:commerce/src/release-control.ts`);
    expect(q2Blob).not.toBe(b2Blob);
    expect(git("show", `${TARGET_Q2}:commerce/src/release-control.ts`)).toContain("completeRolling(request: ReleaseControlRequest");
  });

  it("fails closed if the committed certificate's patch binding is corrupted", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;
    const corrupted = {
      ...certificate,
      paths: [{ ...certificate.paths[0], patch_sha256: "0".repeat(64) }, ...certificate.paths.slice(1)],
    } as ControlledCandidateCertificate;

    expect(() => reconstructControlledCandidateSha(corrupted, { trusted_patch_source_sha: controllerSha })).toThrow("CONTROLLED_CANDIDATE_PATCH_SHA256_MISMATCH");
  });
});
