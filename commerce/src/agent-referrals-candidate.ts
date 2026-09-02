import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Deterministic detached candidate reconstruction, per §B-1 of the Agent
 * Referrals plan and docs/release/AGENT_REFERRALS_BOUNDARY.md. This is
 * reusable machinery only - PR1 ships no real certificate, because Q's SHA
 * depends on PR2-PR9's actual patches; PR10 commits the real one to
 * .release/controlled-candidates/agent-referrals-<BASE>/certificate.json.
 * See commerce/test/agent-referrals-candidate.test.ts for synthetic fixtures
 * proving every property below.
 *
 * Reconstruction is patch-based, never whole-file overlay: `P` and `main`
 * already diverge in files this feature touches, so copying a blob straight
 * out of main's tree would silently import unrelated main-only changes. Each
 * certified path instead pins a transformation - a committed patch, applied
 * to an exact BASE blob - and the verifier proves the result independently
 * rather than trusting whatever the builder produced. Result content is never
 * read out of the target commit Q; that would be a circular proof, and this
 * module never reads anything at the target SHA at all.
 *
 * `public/legal/**` and `commerce/legal/**` may never appear in a certified
 * path: the certified manifest excludes them by construction so Q inherits
 * production legal state from BASE unchanged. This module refuses any
 * certificate that tries to touch them, as a machine-checked invariant rather
 * than a review convention.
 */

export type GitFileMode = "100644" | "100755" | "120000";

const gitFileModes: readonly GitFileMode[] = ["100644", "100755", "120000"];

export type CertifiedPathEntry =
  | { readonly path: string; readonly kind: "MODIFY"; readonly mode: GitFileMode; readonly base_blob_sha: string; readonly patch_path: string; readonly patch_git_blob_sha: string; readonly patch_sha256: string; readonly result_blob_sha: string }
  | { readonly path: string; readonly kind: "CREATE"; readonly mode: GitFileMode; readonly patch_path: string; readonly patch_git_blob_sha: string; readonly patch_sha256: string; readonly result_blob_sha: string }
  | { readonly path: string; readonly kind: "DELETE"; readonly base_blob_sha: string };

/**
 * Every field the plan's frozen envelope names, pinned as independently
 * reviewable evidence rather than left implicit in the reconstruction code:
 * `parent_sha` and `tree_sha` are cross-checked against what reconstruction
 * actually derives (base_sha and the write-tree result), not merely trusted,
 * and `encoding`/`extra_headers`/`signed` are pinned to their one frozen
 * value and rejected otherwise - a certificate cannot silently ask for a
 * signed commit or an unexpected encoding.
 */
export type CandidateCommitEnvelope = {
  readonly parent_sha: string;
  readonly tree_sha: string;
  readonly author_name: string;
  readonly author_email: string;
  readonly author_timestamp: number;
  readonly author_timezone: string;
  readonly committer_name: string;
  readonly committer_email: string;
  readonly committer_timestamp: number;
  readonly committer_timezone: string;
  readonly message: string;
  readonly encoding: "none";
  readonly extra_headers: "none";
  readonly signed: false;
};

export type AgentReferralsCandidateCertificate = {
  /** The freshly observed production-deploy SHA at candidate build time. Q^ == base_sha. */
  readonly base_sha: string;
  /**
   * The exact protected-main commit whose tree every patch_path is read
   * from - and the ancestry root a controller must independently prove is
   * reachable from its own checkout before trusting anything else here. See
   * RECONSTRUCTION_BOUND in commerce/test/controller-not-older-than-target.test.ts:
   * a workflow must extract this exact field from this exact certificate to
   * feed its ancestry check, never take SOURCE_MAIN_SHA from an unrelated
   * input that merely happens to look safe.
   */
  readonly source_main_sha: string;
  readonly paths: readonly CertifiedPathEntry[];
  readonly commit: CandidateCommitEnvelope;
};

export class AgentReferralsCandidateError extends Error {
  constructor(readonly code: string) { super(code); }
}

const FORBIDDEN_PATH_PREFIXES = ["public/legal/", "commerce/legal/"] as const;

// This repository's Git objects are SHA-1 (40 hex chars); patch_sha256 is a
// genuine SHA-256 content digest (64 hex chars), independent of Git's own
// object format. Never conflate the two - a blob SHA is 40 chars here.
const shaPattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const timezonePattern = /^[+-]\d{4}$/;

const fail = (code: string): never => { throw new AgentReferralsCandidateError(code); };

const git = (args: string[], options: { cwd?: string; input?: Buffer } = {}): Buffer => {
  const result = spawnSync("git", args, { cwd: options.cwd, input: options.input });
  if (result.error) fail(`AGENT_REFERRALS_CANDIDATE_GIT_SPAWN_FAILED:${args[0]}`);
  if (result.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_GIT_FAILED:${args.join(" ")}:${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
  return Buffer.from(result.stdout ?? []);
};

const gitText = (args: string[], options: { cwd?: string; input?: Buffer } = {}): string => git(args, options).toString("utf8").trimEnd();

const gitOk = (args: string[], options: { cwd?: string } = {}): boolean => spawnSync("git", args, { cwd: options.cwd }).status === 0;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

/** Never reads content, so it cannot be spoofed by a wrong-but-matching hash claimed elsewhere. */
const blobShaAt = (commitish: string, path: string): string | undefined => {
  if (!gitOk(["cat-file", "-e", `${commitish}:${path}`])) return undefined;
  return gitText(["rev-parse", `${commitish}:${path}`]);
};

const validateCertificate = (certificate: AgentReferralsCandidateCertificate) => {
  if (!shaPattern.test(certificate.base_sha)) fail("AGENT_REFERRALS_CANDIDATE_BASE_SHA_INVALID");
  if (!shaPattern.test(certificate.source_main_sha)) fail("AGENT_REFERRALS_CANDIDATE_SOURCE_MAIN_SHA_INVALID");
  if (!certificate.paths.length) fail("AGENT_REFERRALS_CANDIDATE_EMPTY_MANIFEST");
  const seen = new Set<string>();
  for (const entry of certificate.paths) {
    if (!entry.path || entry.path.startsWith("/") || entry.path.includes("..") || entry.path.startsWith(".git/")) fail("AGENT_REFERRALS_CANDIDATE_PATH_INVALID");
    if (seen.has(entry.path)) fail("AGENT_REFERRALS_CANDIDATE_DUPLICATE_PATH");
    seen.add(entry.path);
    if (FORBIDDEN_PATH_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) fail("AGENT_REFERRALS_CANDIDATE_LEGAL_PATH_FORBIDDEN");
    if (entry.kind === "DELETE") {
      if (!shaPattern.test(entry.base_blob_sha)) fail("AGENT_REFERRALS_CANDIDATE_BASE_BLOB_SHA_INVALID");
      continue;
    }
    if (!gitFileModes.includes(entry.mode)) fail("AGENT_REFERRALS_CANDIDATE_MODE_INVALID");
    if (!shaPattern.test(entry.patch_git_blob_sha)) fail("AGENT_REFERRALS_CANDIDATE_PATCH_BLOB_SHA_INVALID");
    if (!hashPattern.test(entry.patch_sha256)) fail("AGENT_REFERRALS_CANDIDATE_PATCH_SHA256_INVALID");
    if (!shaPattern.test(entry.result_blob_sha)) fail("AGENT_REFERRALS_CANDIDATE_RESULT_BLOB_SHA_INVALID");
    if (entry.kind === "MODIFY" && !shaPattern.test(entry.base_blob_sha)) fail("AGENT_REFERRALS_CANDIDATE_BASE_BLOB_SHA_INVALID");
  }
  const envelope = certificate.commit;
  if (!shaPattern.test(envelope.tree_sha)) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_TREE_SHA_INVALID");
  // parent_sha is pinned as independently reviewable evidence, but it must
  // still agree with the certificate's own base_sha - there is exactly one
  // BASE, and the envelope cannot silently name a different one.
  if (envelope.parent_sha !== certificate.base_sha) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_PARENT_SHA_MISMATCH");
  for (const field of [envelope.author_name, envelope.author_email, envelope.committer_name, envelope.committer_email, envelope.message] as const) {
    if (typeof field !== "string" || !field.length) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_FIELD_INVALID");
  }
  for (const timestamp of [envelope.author_timestamp, envelope.committer_timestamp]) {
    if (!Number.isInteger(timestamp) || timestamp <= 0) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_TIMESTAMP_INVALID");
  }
  for (const timezone of [envelope.author_timezone, envelope.committer_timezone]) {
    if (!timezonePattern.test(timezone)) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_TIMEZONE_INVALID");
  }
  // Frozen, single-value fields: a certificate cannot silently ask for a
  // signed commit, extra headers, or a non-default encoding.
  if ((envelope.encoding as string) !== "none") fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_ENCODING_INVALID");
  if ((envelope.extra_headers as string) !== "none") fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_EXTRA_HEADERS_INVALID");
  if ((envelope.signed as boolean) !== false) fail("AGENT_REFERRALS_CANDIDATE_ENVELOPE_SIGNED_INVALID");
};

/**
 * Applies one certified patch to its BASE (or to nothing, for a CREATE) in an
 * isolated scratch directory that is never the real working tree - a pure
 * text transform, touching no repository state. Uses real `git apply` rather
 * than the legacy `patch(1)` utility specifically so behavior does not vary
 * between a BSD and a GNU host: the same git binary already governs every
 * other step of reconstruction.
 */
const applyPatch = (path: string, patchContent: Buffer, baseContent: Buffer | undefined): Buffer => {
  const scratch = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-apply-"));
  try {
    const target = join(scratch, path);
    if (baseContent !== undefined) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, baseContent);
    }
    const patchFile = join(scratch, ".certified.patch");
    writeFileSync(patchFile, patchContent);
    const result = spawnSync("git", ["apply", "-p1", "--unsafe-paths", "--whitespace=nowarn", patchFile], { cwd: scratch });
    if (result.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_PATCH_APPLY_FAILED:${path}`);
    try {
      return readFileSync(target);
    } catch {
      return fail(`AGENT_REFERRALS_CANDIDATE_PATCH_APPLY_PRODUCED_NO_FILE:${path}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * The reconstruction engine shared by the builder and the verifier below.
 * Every check here is independently re-derived from the certificate and the
 * two named commits (base_sha, source_main_sha) - nothing is trusted from a
 * prior run, and Q's own tree is never read.
 */
export const reconstructAgentReferralsCandidateSha = (certificate: AgentReferralsCandidateCertificate): string => {
  validateCertificate(certificate);
  const { base_sha: baseSha, source_main_sha: mainSha } = certificate;

  const indexDirectory = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-index-"));
  const index = join(indexDirectory, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  // Every mutation to the scratch index (read-tree, update-index, write-tree)
  // MUST run with this env - it is what keeps this operation from ever
  // touching the real repository's actual staged index.
  const gitIndexed = (args: string[]): string => {
    const result = spawnSync("git", args, { env });
    if (result.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_GIT_FAILED:${args.join(" ")}:${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
    return Buffer.from(result.stdout ?? []).toString("utf8").trimEnd();
  };
  try {
    gitIndexed(["read-tree", baseSha]);

    for (const entry of certificate.paths) {
      if (entry.kind === "DELETE") {
        const observedBase = blobShaAt(baseSha, entry.path);
        if (observedBase !== entry.base_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_BASE_BLOB_MISMATCH:${entry.path}`);
        gitIndexed(["update-index", "--force-remove", entry.path]);
        continue;
      }

      // "certificate read from the controller/main tree": the blob at
      // patch_path is resolved from source_main_sha's own tree, never from disk.
      const observedPatchBlob = blobShaAt(mainSha, entry.patch_path);
      if (observedPatchBlob !== entry.patch_git_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_PATCH_BLOB_MISMATCH:${entry.path}`);
      const patchContent = git(["cat-file", "-p", entry.patch_git_blob_sha]);
      if (sha256(patchContent) !== entry.patch_sha256) fail(`AGENT_REFERRALS_CANDIDATE_PATCH_SHA256_MISMATCH:${entry.path}`);

      let baseContent: Buffer | undefined;
      if (entry.kind === "MODIFY") {
        const observedBase = blobShaAt(baseSha, entry.path);
        if (observedBase !== entry.base_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_BASE_BLOB_MISMATCH:${entry.path}`);
        baseContent = git(["cat-file", "-p", entry.base_blob_sha]);
      } else if (blobShaAt(baseSha, entry.path) !== undefined) {
        // CREATE means the path must not already exist in BASE.
        fail(`AGENT_REFERRALS_CANDIDATE_CREATE_PATH_ALREADY_EXISTS_IN_BASE:${entry.path}`);
      }

      const resultContent = applyPatch(entry.path, patchContent, baseContent);
      const resultShaNoWrite = gitText(["hash-object", "-t", "blob", "--stdin"], { input: resultContent });
      if (resultShaNoWrite !== entry.result_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_RESULT_BLOB_MISMATCH:${entry.path}`);
      const written = gitText(["hash-object", "-w", "-t", "blob", "--stdin"], { input: resultContent });
      if (written !== entry.result_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_RESULT_BLOB_MISMATCH:${entry.path}`);
      gitIndexed(["update-index", "--add", "--cacheinfo", `${entry.mode},${written},${entry.path}`]);
    }

    const treeSha = gitIndexed(["write-tree"]);

    // The envelope's own pinned tree_sha is independently reviewable
    // evidence, not merely implied by the reconstruction steps above - cross
    // -check it against what was actually derived.
    if (treeSha !== certificate.commit.tree_sha) fail("AGENT_REFERRALS_CANDIDATE_TREE_SHA_MISMATCH");

    // "BASE..Q changed paths == certified manifest": no maintenance or
    // unexpected paths entered the reconstructed tree.
    const expectedPaths = [...new Set(certificate.paths.map((entry) => entry.path))].sort();
    const changedPaths = gitText(["diff", "--name-only", baseSha, treeSha]).split("\n").filter(Boolean).sort();
    if (changedPaths.join("\n") !== expectedPaths.join("\n")) fail("AGENT_REFERRALS_CANDIDATE_UNEXPECTED_CHANGED_PATHS");

    const envelope = certificate.commit;
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: envelope.author_name,
      GIT_AUTHOR_EMAIL: envelope.author_email,
      GIT_AUTHOR_DATE: `@${envelope.author_timestamp} ${envelope.author_timezone}`,
      GIT_COMMITTER_NAME: envelope.committer_name,
      GIT_COMMITTER_EMAIL: envelope.committer_email,
      GIT_COMMITTER_DATE: `@${envelope.committer_timestamp} ${envelope.committer_timezone}`,
    };
    // encoding=none, extra_headers=none, signed=false: no -S, and the
    // encoding config is pinned to the value that makes git omit the header.
    const commit = spawnSync("git", ["-c", "i18n.commitEncoding=UTF-8", "commit-tree", treeSha, "-p", baseSha, "-m", envelope.message, "--no-gpg-sign"], { env: commitEnv });
    if (commit.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_GIT_FAILED:commit-tree:${Buffer.from(commit.stderr ?? []).toString("utf8").trim()}`);
    return Buffer.from(commit.stdout ?? []).toString("utf8").trimEnd();
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
};

/** Alias emphasizing the builder role: constructs Q from a certificate, throwing on any failure. */
export const buildAgentReferralsCandidateCommit = reconstructAgentReferralsCandidateSha;

/**
 * Independently proves a certificate against an externally supplied target
 * SHA. Re-derives every step from scratch (see reconstructAgentReferralsCandidateSha)
 * rather than trusting a prior builder run's output; the only new work here is
 * the final equality assertion.
 */
export const verifyAgentReferralsCandidateCertificate = (certificate: AgentReferralsCandidateCertificate, targetSha: string): string | undefined => {
  if (!shaPattern.test(targetSha)) return "AGENT_REFERRALS_CANDIDATE_TARGET_SHA_INVALID";
  try {
    const reconstructed = reconstructAgentReferralsCandidateSha(certificate);
    if (reconstructed !== targetSha) return "AGENT_REFERRALS_CANDIDATE_SHA_MISMATCH";
    return undefined;
  } catch (error) {
    return error instanceof AgentReferralsCandidateError ? error.code : "AGENT_REFERRALS_CANDIDATE_RECONSTRUCTION_FAILED";
  }
};
