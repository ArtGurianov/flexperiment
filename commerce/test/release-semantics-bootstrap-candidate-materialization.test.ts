import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  reconstructControlledCandidateSha,
  type ControlledCandidateCertificate,
} from "../src/controlled-candidate";

/**
 * §P->B2 release-semantics bootstrap (docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md):
 * proves the committed certificate reconstructs the exact, real, minimal
 * two-path detached candidate B2 from the exact frozen production BASE (P),
 * mirroring commerce/test/agent-referrals-candidate-materialization.test.ts's
 * proof shape for the machinery's other real consumer.
 */
const BASE_SHA = "24a382929740a7ead6fb0bb49f5ffc77e063c77a";
const SOURCE_MAIN_SHA = "08f21d2293fcc1d908b2cfe23c0b64d8c4ef7e9f";
const TARGET_B2 = "f540b997d6d31a22293909ded7ce464c3f51732f";
const CERTIFICATE_PATH = `.release/controlled-candidates/release-semantics-bootstrap-${BASE_SHA}/certificate.json`;
const EXPECTED_PATHS = ["commerce/src/api.ts", "commerce/src/release-control-schema.ts"] as const;

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

describe("release-semantics bootstrap committed B2 materialization", () => {
  it("reconstructs the pinned detached candidate B2 from the committed controller tree", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;

    expect(certificate.base_sha).toBe(BASE_SHA);
    expect(certificate.source_main_sha).toBe(SOURCE_MAIN_SHA);
    expect(certificate.patch_source).toBe("controller_tree");
    expect(git("merge-base", "--is-ancestor", certificate.source_main_sha, controllerSha)).toBe("");
    expect(reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha })).toBe(TARGET_B2);

    const changedPaths = git("diff", "--name-only", BASE_SHA, TARGET_B2).split("\n").filter(Boolean).sort();
    expect(changedPaths).toEqual(certificate.paths.map((entry) => entry.path).sort());
    // Exactly the minimal two paths: release-control-schema.ts (CREATE,
    // adopted verbatim from protected main) and api.ts (MODIFY, a two-line
    // import move only) - see docs/release/RELEASE_SEMANTICS_BOOTSTRAP.md for
    // why this must never widen to include Agent Referrals content.
    expect(changedPaths).toEqual([...EXPECTED_PATHS].sort());
    expect(changedPaths.some((path) => path.startsWith("public/legal/") || path.startsWith("commerce/legal/"))).toBe(false);
    expect(spawnSync("git", ["cat-file", "-e", `${TARGET_B2}:${CERTIFICATE_PATH}`]).status).not.toBe(0);
  }, 30_000);

  it("B2^ == BASE (the frozen production-deploy SHA at bootstrap time)", () => {
    expect(git("rev-parse", `${TARGET_B2}^`)).toBe(BASE_SHA);
  });

  it("release-control.ts is byte-identical between BASE and B2 - the bootstrap adds no domain-level change", () => {
    expect(git("rev-parse", `${TARGET_B2}:commerce/src/release-control.ts`)).toBe(git("rev-parse", `${BASE_SHA}:commerce/src/release-control.ts`));
  });

  it("B2's release-control-schema.ts is byte-identical to the already-reviewed protected-main file it was adopted from", () => {
    const controllerSha = git("rev-parse", "HEAD");
    expect(git("rev-parse", `${TARGET_B2}:commerce/src/release-control-schema.ts`)).toBe(git("rev-parse", `${controllerSha}:commerce/src/release-control-schema.ts`));
  });

  it("fails closed if the committed certificate's patch binding is corrupted", () => {
    const controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;
    const corrupted = {
      ...certificate,
      paths: [{ ...certificate.paths[0], patch_sha256: "0".repeat(64) }, certificate.paths[1]],
    } as ControlledCandidateCertificate;

    expect(() => reconstructControlledCandidateSha(corrupted, { trusted_patch_source_sha: controllerSha })).toThrow("CONTROLLED_CANDIDATE_PATCH_SHA256_MISMATCH");
  });
});
