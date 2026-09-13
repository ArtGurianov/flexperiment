import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const production = "acfef97f15b45995e0f98a8ac0c649802c2bca9c";

const blob = (ref: string, path: string) =>
  execFileSync("git", ["show", `${ref}:${path}`], { encoding: "buffer" });

describe("topology normalization forward-port", () => {
  it("keeps every excluded boundary artifact byte-identical to production", () => {
    for (const path of [
      "commerce/src/certification-dispatch.ts",
      "certification.sh",
      "commerce/legal/production-manifest.json",
      "public/legal/privacy-policy.md",
      "public/legal/personal-data-consent.md",
      "release-surface-contract.json",
    ]) {
      expect(readFileSync(path), path).toEqual(blob(production, path));
    }
    expect(execFileSync("git", ["rev-parse", `${production}:commerce/migrations`], { encoding: "utf8" }).trim())
      .toBe(execFileSync("git", ["rev-parse", "HEAD:commerce/migrations"], { encoding: "utf8" }).trim());
    expect(statSync("certification.sh").mode & 0o777).toBe(0o644);
  });

  it("restores production-only Agent Referrals runtime wiring without dropping main recovery routes", () => {
    const api = readFileSync("commerce/src/api.ts", "utf8");
    const domain = readFileSync("commerce/src/domain.ts", "utf8");
    const releaseControl = readFileSync("commerce/src/release-control.ts", "utf8");
    const server = readFileSync("commerce/src/server.ts", "utf8");

    for (const route of [
      "/agent-referrals/stranded-rolling-supersede",
      "/agent-referrals/dormant-readiness",
      "/agent-referrals/activation-state",
      "/agent-referrals/activate",
      "/resolution/:releaseId",
      "/candidates/post-activation-email-provider-defect",
    ]) expect(api).toContain(route);

    expect(api).toContain("agentReferralsDormantReady");
    expect(api).toContain("domain.completeRolling(input");
    expect(domain).toContain("activateAgentReferralsIfReady");
    expect(domain).toContain("supersedeAgentReferralsStrandedRolling");
    expect(releaseControl).toContain("supersedeStrandedAgentReferralsRolling");
    expect(releaseControl).toContain("markPostActivationEmailProviderDefect");
    expect(server).toContain("otpSenderFromEnvironment");
  });
});
