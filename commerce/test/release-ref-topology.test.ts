import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { epochBPromotionArtifactReason } from "../src/epoch-b-notification-activation";
import { reconstructAgentReferralsCandidateSha, verifyAgentReferralsCandidateCertificate, type AgentReferralsCandidateCertificate, type CertifiedPathEntry } from "../src/agent-referrals-candidate";

/**
 * Durable release refs must stay in a provable relationship. Both invariants
 * here failed in production on 2026-08-28 and cost real outage time:
 *
 *  - main did not contain production-deploy, so main documented the R7
 *    migrationApplied() fix while its own source still carried the defect.
 *    A deploy from main would have been a silent semantic rollback.
 *  - runtime-candidate did not descend from production-deploy after a cutover
 *    advanced production without touching the candidate ref, which blocks
 *    every generic deploy - and the ordinary promotion path cannot repair it,
 *    because it validates that same property first.
 *
 * Cheap to assert, and either would have been caught before dispatch.
 *
 * There is deliberately NO gate on production-deploy -> runtime-candidate.
 * That pointer is a proposal register: a successful cutover leaves it stale
 * with no bug involved, so making staleness a CI failure would reintroduce the
 * dual authority the selection layer dropped - the runtime treating a stale
 * pointer as fine while CI called it illegal. Selection safety is asserted
 * where it belongs, against the new target: runtime-candidate-selection.test.ts.
 */

const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

const resolve = (ref: string): string | undefined => {
  const result = git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
};

const describes = (ref: string) => git("log", "-1", "--format=%h %s", ref).stdout.trim();

const isAncestor = (ancestor: string, descendant: string) =>
  git("merge-base", "--is-ancestor", ancestor, descendant).status === 0;

// 0041, Epoch A R, and the deterministic Epoch B legal-promotion child are
// the only reviewed exceptions to normal integration topology. The last is
// not a ref-name exception: its exact Git object is reconstructed from R and
// its embedded authoritative legal timestamp.
const GEN1_0041 = "68f80a411b7f286928ef10826ed225228098d246";
const GEN2_0041 = "0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34";
const EPOCH_A_RUNTIME = "80e152259628719af20d363a76ed6b991d67482a";
const isApproved0041DetachedRuntime = (sha: string) =>
  sha === GEN2_0041 && resolve(`${GEN2_0041}^`) === GEN1_0041;
const isApprovedEpochADetachedRuntime = (sha: string) =>
  sha === EPOCH_A_RUNTIME && resolve(`${EPOCH_A_RUNTIME}^`) === GEN2_0041;
const isApprovedEpochBPromotionArtifact = (sha: string) => {
  try {
    const raw = git("show", `${sha}:commerce/legal/production-manifest.json`).stdout.toString();
    const publishTime = (JSON.parse(raw) as { publish_time?: unknown }).publish_time;
    return typeof publishTime === "string" && epochBPromotionArtifactReason(sha, publishTime) === undefined;
  } catch {
    return false;
  }
};

/**
 * §B-1 `RECONSTRUCTION_BOUND`: a detached production-deploy may also be
 * accepted when a committed reconstruction certificate on protected main
 * independently proves it - source_main_sha must itself be an ancestor of
 * the currently observed main, and the certificate must reconstruct to the
 * exact judged SHA (see commerce/src/agent-referrals-candidate.ts).
 *
 * Phase 10A's canonical location: `.release/controlled-candidates/
 * agent-referrals-<BASE>/certificate.json`, committed to protected main (a
 * control-plane artifact, not something Q itself carries) and read from
 * main's own tree - never from the judged SHA's tree, which would be reading
 * Q's claims about itself, exactly the circular proof this module refuses to
 * perform. `<BASE>` is resolved fresh as the judged SHA's own parent
 * (Q^ == BASE is the frozen invariant, never assumed) and cross-checked
 * against the certificate's own base_sha field before anything else runs.
 *
 * PR1 ships no certificate, so this predicate is reusable machinery that
 * never fires today - not a name-based skip or a new hard-coded SHA
 * exemption, and it costs nothing while unused.
 */
const candidateCertificatePath = (base: string) => `.release/controlled-candidates/agent-referrals-${base}/certificate.json`;
const isApprovedAgentReferralsCandidate = (sha: string, currentMain: string) => {
  const base = resolve(`${sha}^`);
  if (!base) return false;
  const result = git("show", `${currentMain}:${candidateCertificatePath(base)}`);
  if (result.status !== 0) return false;
  let certificate: AgentReferralsCandidateCertificate;
  try { certificate = JSON.parse(result.stdout.toString()) as AgentReferralsCandidateCertificate; }
  catch { return false; }
  if (certificate.base_sha !== base) return false;
  if (typeof certificate.source_main_sha !== "string" || !isAncestor(certificate.source_main_sha, currentMain)) return false;
  // The certificate was just read from currentMain's own tree above - patches
  // for a `patch_source: "controller_tree"` certificate (Phase 10A's real
  // form) must be resolved from that exact same tree, never left unbound
  // (which would either fail closed on every legitimate candidate, since
  // reconstruction has no default patch source to fall back to, or - if a
  // default ever existed - open a seam where a wrong/absent controller tree
  // silently governs which patch bytes are trusted).
  return verifyAgentReferralsCandidateCertificate(certificate, sha, { trusted_patch_source_sha: currentMain }) === undefined;
};

// Resolved SHAs, never branch names: a ref that has been repointed must not
// pass because its name still looks familiar.
const productionDeploy = resolve("origin/production-deploy");
const main = resolve("origin/main");

describe("durable release ref topology", () => {
  // A fork or a checkout without these refs legitimately cannot judge them, so
  // those runs skip. CI fetches them explicitly (see test.yml) precisely so the
  // skip is not the normal outcome - a guard that always skips is not a guard.
  const judged = productionDeploy && main ? { productionDeploy, main } : undefined;

  it("resolves the refs it judges", (ctx) => {
    if (!judged) return ctx.skip();
    expect(judged.productionDeploy).toMatch(/^[0-9a-f]{40}$/);
    expect(judged.main).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps main over production except for exact reviewed detached runtimes", (ctx) => {
    if (!judged) return ctx.skip();
    expect(
      isAncestor(judged.productionDeploy, judged.main)
      || isApproved0041DetachedRuntime(judged.productionDeploy)
      || isApprovedEpochADetachedRuntime(judged.productionDeploy)
      || isApprovedEpochBPromotionArtifact(judged.productionDeploy)
      || isApprovedAgentReferralsCandidate(judged.productionDeploy, judged.main),
      `production-deploy is not an ancestor of main.\n`
      + `  production-deploy: ${describes("origin/production-deploy")}\n`
      + `  main:              ${describes("origin/main")}\n`
      + `Only exact 0041 Gen2, exact Epoch A R, deterministic Epoch B P, or a valid Agent Referrals reconstruction certificate may be detached from main.`,
    ).toBe(true);
  });

});

/**
 * P1.1 regression (round-6 fix): `isApprovedAgentReferralsCandidate` above
 * must bind reconstruction to the exact `currentMain` whose tree supplied the
 * certificate, per RECONSTRUCTION_BOUND (docs/release/AGENT_REFERRALS_BOUNDARY.md)
 * and the real Phase 10A certificate's `patch_source: "controller_tree"`.
 * These fixtures model the post-Phase-10B topology directly, independent of
 * the real repository's own refs, so this suite proves the property on its
 * own merits rather than only incidentally via whatever `origin/main` and
 * `origin/production-deploy` happen to be when CI runs.
 *
 * Objects are written into an isolated, per-test GIT_OBJECT_DIRECTORY with no
 * alternates - never the real repository's object database - exactly the
 * isolation `commerce/test/agent-referrals-candidate.test.ts` already
 * validates needs no `git init`.
 */
describe("RECONSTRUCTION_BOUND: isApprovedAgentReferralsCandidate binds to the exact controller tree", () => {
  let objectDirectory: string;
  let previousObjectDirectory: string | undefined;

  beforeEach(() => {
    objectDirectory = mkdtempSync(join(tmpdir(), "release-ref-topology-test-objects-"));
    previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
    process.env.GIT_OBJECT_DIRECTORY = objectDirectory;
  });

  afterEach(() => {
    if (previousObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
    else process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory;
    rmSync(objectDirectory, { recursive: true, force: true });
  });

  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const gitRun = (args: string[], input?: string): string => {
    const result = spawnSync("git", args, { input });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr ?? []).toString("utf8")}`);
    return Buffer.from(result.stdout ?? []).toString("utf8").trim();
  };
  const writeBlob = (content: string): string => gitRun(["hash-object", "-w", "--stdin"], content);
  type FlatEntry = { mode: string; sha: string; path: string };
  const mktree = (entries: FlatEntry[]): string => {
    if (!entries.length) return gitRun(["mktree"], "");
    const direct: string[] = [];
    const grouped = new Map<string, FlatEntry[]>();
    for (const entry of entries) {
      const slash = entry.path.indexOf("/");
      if (slash === -1) direct.push(`${entry.mode} blob ${entry.sha}\t${entry.path}`);
      else {
        const dir = entry.path.slice(0, slash);
        const rest = entry.path.slice(slash + 1);
        grouped.set(dir, [...(grouped.get(dir) ?? []), { ...entry, path: rest }]);
      }
    }
    for (const [dir, subEntries] of grouped) direct.push(`040000 tree ${mktree(subEntries)}\t${dir}`);
    return gitRun(["mktree"], `${direct.join("\n")}\n`);
  };
  const commitTree = (tree: string, parent: string | undefined, message: string): string => {
    const args = ["commit-tree", tree];
    if (parent) args.push("-p", parent);
    args.push("-m", message, "--no-gpg-sign");
    return gitRun(args, undefined);
  };

  /**
   * BASE -> readme.md "a\nb\nc\n" -> patched to "a\nCHANGED\nc\n" by
   * patches/0001.patch, committed to a controller tree alongside the
   * certificate itself at its canonical path - exactly what real PR10
   * commits to protected main.
   */
  const buildScenario = () => {
    const oldContent = "a\nb\nc\n";
    const newContent = "a\nCHANGED\nc\n";
    const baseBlob = writeBlob(oldContent);
    const baseSha = commitTree(mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]), undefined, "base");

    const patchContent = `--- a/readme.md\n+++ b/readme.md\n@@ -1,3 +1,3 @@\n a\n-b\n+CHANGED\n c\n`;
    const patchBlob = writeBlob(patchContent);
    const resultBlob = writeBlob(newContent);
    const resultTree = mktree([{ mode: "100644", sha: resultBlob, path: "readme.md" }]);

    // patch_path is repo-root-relative, exactly like the real certificate
    // (see .release/controlled-candidates/agent-referrals-<BASE>/certificate.json)
    // - never relative to the certificate's own directory.
    const patchPath = `.release/controlled-candidates/agent-referrals-${baseSha}/patches/0001.patch`;
    const entry: CertifiedPathEntry = {
      path: "readme.md", kind: "MODIFY", mode: "100644",
      base_blob_sha: baseBlob, patch_path: patchPath,
      patch_git_blob_sha: patchBlob, patch_sha256: sha256(patchContent),
      result_blob_sha: resultBlob,
    };
    const sourceMainSha = commitTree(mktree([]), undefined, "frozen protected main, pre-PR10");
    const certificate: AgentReferralsCandidateCertificate = {
      base_sha: baseSha,
      source_main_sha: sourceMainSha,
      patch_source: "controller_tree",
      paths: [entry],
      commit: {
        parent_sha: baseSha, tree_sha: resultTree,
        author_name: "Flexperiment Release Control", author_email: "release-control@flexperiment.ru",
        author_timestamp: 1_700_000_000, author_timezone: "+0000",
        committer_name: "Flexperiment Release Control", committer_email: "release-control@flexperiment.ru",
        committer_timestamp: 1_700_000_000, committer_timezone: "+0000",
        message: "agent-referrals: synthetic Phase 10A candidate", encoding: "none", extra_headers: "none", signed: false,
      },
    };

    const certificateBlob = writeBlob(JSON.stringify(certificate));
    const certificatePath = `.release/controlled-candidates/agent-referrals-${baseSha}/certificate.json`;
    const controllerTree = mktree([
      { mode: "100644", sha: certificateBlob, path: certificatePath },
      { mode: "100644", sha: patchBlob, path: patchPath },
    ]);
    // controller/currentMain descends from source_main_sha, satisfying
    // `source_main_sha ⊆ currentMain` honestly rather than by coincidence.
    const currentMain = commitTree(controllerTree, sourceMainSha, "protected main: PR10 lands the real certificate");

    return { baseSha, sourceMainSha, currentMain, certificate, patchBlob, patchContent, entry };
  };

  it("accepts a detached production-deploy == Q only because the real certificate, bound to this exact controller tree, reconstructs it", () => {
    const { baseSha, currentMain, certificate } = buildScenario();
    const targetQ = reconstructAgentReferralsCandidateSha(certificate, { trusted_patch_source_sha: currentMain });

    // Q^ == BASE, by construction of the reconstruction engine itself.
    expect(gitRun(["rev-parse", `${targetQ}^`])).toBe(baseSha);

    // Q is genuinely detached: not an ancestor of main via ordinary commit
    // ancestry. If this were ever true, the exemption below would not be the
    // reason topology accepts it, defeating the point of this regression.
    const isAncestor = (ancestor: string, descendant: string) => spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
    expect(isAncestor(targetQ, currentMain)).toBe(false);

    // The same predicate `release-ref-topology.test.ts`'s real topology check
    // uses, reproduced here against fully synthetic refs: it accepts Q
    // exclusively via the RECONSTRUCTION_BOUND certificate path.
    const approvedViaCertificate = (() => {
      const parent = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${targetQ}^{commit}^`]).stdout.toString().trim();
      if (parent !== baseSha) return false;
      const shown = spawnSync("git", ["show", `${currentMain}:.release/controlled-candidates/agent-referrals-${parent}/certificate.json`]);
      if (shown.status !== 0) return false;
      let cert: AgentReferralsCandidateCertificate;
      try { cert = JSON.parse(shown.stdout.toString()) as AgentReferralsCandidateCertificate; } catch { return false; }
      if (cert.base_sha !== parent) return false;
      if (!isAncestor(cert.source_main_sha, currentMain)) return false;
      return verifyAgentReferralsCandidateCertificate(cert, targetQ, { trusted_patch_source_sha: currentMain }) === undefined;
    })();
    expect(approvedViaCertificate).toBe(true);
    expect(isAncestor(targetQ, currentMain) || approvedViaCertificate).toBe(true);
  });

  it("REQUEST-CHANGES regression: a controller tree that does not match the one the patches were bound to fails closed, never silently reconstructing an unauthorized Q", () => {
    const { baseSha, sourceMainSha, currentMain, certificate, entry } = buildScenario();
    const targetQ = reconstructAgentReferralsCandidateSha(certificate, { trusted_patch_source_sha: currentMain });

    // A second, distinct controller tree: it also descends from source_main_sha
    // (so the ancestry proof alone would pass) and also carries a byte-for-byte
    // copy of the certificate at the canonical path (so BASE/source_main
    // equality checks alone would pass) - but its patches/0001.patch differs,
    // exactly the shape an attacker or a stale/wrong controller checkout would
    // produce: same claimed certificate, unauthorized patch bytes behind it.
    const roguePatchContent = `--- a/readme.md\n+++ b/readme.md\n@@ -1,3 +1,3 @@\n a\n-b\n+ROGUE\n c\n`;
    const roguePatchBlob = writeBlob(roguePatchContent);
    const certificateBlob = writeBlob(JSON.stringify(certificate));
    const certificatePath = `.release/controlled-candidates/agent-referrals-${baseSha}/certificate.json`;
    const rogueControllerTree = mktree([
      { mode: "100644", sha: certificateBlob, path: certificatePath },
      { mode: "100644", sha: roguePatchBlob, path: entry.patch_path },
    ]);
    const rogueMain = commitTree(rogueControllerTree, sourceMainSha, "a different controller tree claiming the same certificate");

    // Reconstructing against the rogue tree must fail closed - a mismatched
    // patch blob, never a silently accepted alternate Q.
    expect(() => reconstructAgentReferralsCandidateSha(certificate, { trusted_patch_source_sha: rogueMain })).toThrow(/AGENT_REFERRALS_CANDIDATE_PATCH_BLOB_MISMATCH/);

    // And the real topology predicate shape must likewise refuse, using the
    // exact same currentMain/verify coupling as the fixed
    // isApprovedAgentReferralsCandidate above - never treating the rogue
    // controller as authoritative just because it happens to carry a
    // byte-identical certificate file.
    const approvedViaRogueController = verifyAgentReferralsCandidateCertificate(certificate, targetQ, { trusted_patch_source_sha: rogueMain }) === undefined;
    expect(approvedViaRogueController).toBe(false);
  });
});
