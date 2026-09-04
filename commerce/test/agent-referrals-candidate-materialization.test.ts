import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  reconstructAgentReferralsCandidateSha,
  type AgentReferralsCandidateCertificate,
} from "../src/agent-referrals-candidate";

const BASE_SHA = "24a382929740a7ead6fb0bb49f5ffc77e063c77a";
const SOURCE_MAIN_SHA = "08f21d2293fcc1d908b2cfe23c0b64d8c4ef7e9f";
const TARGET_Q = "eeb7d09973ea59e5c3b959a6db94ab552e1221c9";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-${BASE_SHA}/certificate.json`;
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

describe("Phase 10A committed Agent Referrals materialization", () => {
  it("reconstructs the pinned detached candidate from the committed controller tree", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as AgentReferralsCandidateCertificate;

    expect(certificate.base_sha).toBe(BASE_SHA);
    expect(certificate.source_main_sha).toBe(SOURCE_MAIN_SHA);
    expect(certificate.patch_source).toBe("controller_tree");
    expect(git("merge-base", "--is-ancestor", certificate.source_main_sha, controllerSha)).toBe("");
    expect(reconstructAgentReferralsCandidateSha(certificate, { trusted_patch_source_sha: controllerSha })).toBe(TARGET_Q);

    const changedPaths = git("diff", "--name-only", BASE_SHA, TARGET_Q).split("\n").filter(Boolean).sort();
    expect(changedPaths).toEqual(certificate.paths.map((entry) => entry.path).sort());
    expect(changedPaths).toHaveLength(88);
    expect(changedPaths.some((path) => path.startsWith("public/legal/") || path.startsWith("commerce/legal/"))).toBe(false);
    expect(spawnSync("git", ["cat-file", "-e", `${TARGET_Q}:${CERTIFICATE_PATH}`]).status).not.toBe(0);

    for (const migration of MIGRATIONS) {
      expect(git("rev-parse", `${TARGET_Q}:commerce/migrations/${migration}`)).toBe(git("rev-parse", `${SOURCE_MAIN_SHA}:commerce/migrations/${migration}`));
    }
  }, 30_000);

  it("fails closed if the committed certificate's patch binding is corrupted", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as AgentReferralsCandidateCertificate;
    const corrupted = {
      ...certificate,
      paths: [{ ...certificate.paths[0], patch_sha256: "0".repeat(64) }],
    } as AgentReferralsCandidateCertificate;

    expect(() => reconstructAgentReferralsCandidateSha(corrupted, { trusted_patch_source_sha: controllerSha })).toThrow("AGENT_REFERRALS_CANDIDATE_PATCH_SHA256_MISMATCH");
  });
});
