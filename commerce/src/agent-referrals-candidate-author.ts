import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ControlledCandidateError,
  verifyControlledCandidateCertificate,
  type CandidateCommitEnvelope,
  type CertifiedPathEntry,
  type ControlledCandidateCertificate,
  type GitFileMode,
} from "./controlled-candidate";

/**
 * The authoring half of the controlled-candidate contract.
 *
 * `controlled-candidate.ts` reconstructs and verifies a certificate;
 * nothing in this repository ever produced one. The previous certificates
 * were assembled by hand inside their own PRs, which is exactly the step a
 * later release cannot repeat reviewably - and the reason this exists is
 * that production's BASE has moved, so the committed certificate cannot be
 * retargeted: it pins `base_sha` and every `base_blob_sha` of a tree that is
 * no longer production's.
 *
 * THE VERIFIER IS NOT MODIFIED, and this module is deliberately not trusted
 * by it. Everything here is re-derived independently by
 * reconstructAgentReferralsCandidateSha from the certificate alone; if this
 * author is wrong, the reconstruction fails rather than agreeing with it.
 *
 * WHAT THIS MODULE MAY NOT DO, and why:
 *
 * 1. It never reads the target commit. There is no target: the candidate SHA
 *    is an OUTPUT of reconstruction, not an input to authoring. Reading one
 *    would be the circular proof the verifier exists to refuse.
 *
 * 2. It never takes "the whole BASE..MAIN diff" as the product intent. The
 *    two histories are diverged, not linearly ahead, so that diff contains
 *    unrelated main-only work. The manifest is explicit, per path, and a
 *    shared path may only carry content the caller supplies deliberately -
 *    see ResultSource below.
 */

export type AuthoredResultSource =
  /**
   * Take the whole blob from `source_main_sha`. Legitimate only for paths
   * the feature owns outright, where "the approved source's version of this
   * file" IS the intent.
   */
  | { readonly from: "source_main" }
  /**
   * Exact bytes supplied by the caller. This is what a SHARED path must use:
   * `api.ts`, `domain.ts`, `db.ts`, `package.json` and their like diverge for
   * reasons that have nothing to do with this feature, so taking main's blob
   * would silently import unrelated work. The caller selects the hunks, and
   * the resulting patch is what a reviewer reads.
   */
  | { readonly from: "explicit"; readonly content: Buffer }
  /** Remove the path. Carries no patch - the certificate pins only the base blob. */
  | { readonly from: "delete" };

/**
 * Ownership is a PRODUCT judgement and stays human - machinery has no way to
 * know whether a file belongs to this feature outright. What machinery can
 * do, once the judgement is written down, is refuse the dangerous transport
 * for it. Before this, `from: "source_main"` was available for any path and
 * only manifest discipline kept it off shared files; a discipline is not a
 * fence.
 *
 * WHOLE_FILE - the feature owns the path outright, so "the approved source's
 *              version of this file" IS the intent and taking main's blob is
 *              correct.
 * SHARED     - the path diverges for reasons unrelated to this feature, so
 *              its result must be bytes a human selected. `source_main` is
 *              not expressible here, in the type AND at runtime.
 */
export type AuthoredPath =
  | { readonly path: string; readonly ownership: "WHOLE_FILE"; readonly source: AuthoredResultSource }
  | { readonly path: string; readonly ownership: "SHARED"; readonly source: Exclude<AuthoredResultSource, { from: "source_main" }> };

export type AuthorCandidateInput = {
  readonly baseSha: string;
  readonly sourceMainSha: string;
  readonly manifest: readonly AuthoredPath[];
  /** Directory the patch files live at inside the controller tree, e.g. `.release/controlled-candidates/agent-referrals-<BASE>/patches`. */
  readonly patchDirectory: string;
  /** Everything about the commit except parent_sha and tree_sha, which are derived, never accepted. */
  readonly envelope: Omit<CandidateCommitEnvelope, "parent_sha" | "tree_sha">;
};

export type AuthoredCandidate = {
  readonly certificate: ControlledCandidateCertificate;
  /** Patch files to write into the controller tree, keyed by their repository path. */
  readonly patches: ReadonlyMap<string, Buffer>;
  /**
   * The commit this author derives - an output, never an input, and only a
   * CLAIM until proveAuthoredCandidate confirms it against a controller tree
   * that really contains the patches.
   */
  readonly claimedCandidateSha: string;
};

/** Mirrors the verifier's own list: legal state is inherited from BASE unchanged. */
const FORBIDDEN_PATH_PREFIXES = ["public/legal/", "commerce/legal/"] as const;

/** The closed domains a manifest entry may use. Never inferred, never defaulted. */
const OWNERSHIPS = ["WHOLE_FILE", "SHARED"] as const;
const RESULT_SOURCES = ["source_main", "explicit", "delete"] as const;

/**
 * The verifier's own path predicate (controlled-candidate.ts), mirrored here
 * because the author WRITES FILES and the verifier runs far too late to
 * prevent that: `buildPatch` materializes content under a scratch directory,
 * and `writeAuthoredCandidate` writes under the repository root, so a path
 * escaping either one has already had its effect by the time any
 * reconstruction could object.
 *
 * Deliberately a duplicate rather than an import: it guards a different act
 * (writing) at a different moment (before any of it), and the two would have
 * to be kept in agreement anyway.
 */
const assertSafeRepositoryPath = (path: string, code: string): void => {
  if (!path || path.startsWith("/") || path.includes("..") || path.startsWith(".git/") || path === ".git") {
    fail(`${code}:${path}`);
  }
};

const fail = (code: string): never => { throw new ControlledCandidateError(code); };

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

const git = (args: string[], options: { cwd?: string; input?: Buffer } = {}): Buffer => {
  const result = spawnSync("git", args, { cwd: options.cwd, input: options.input, maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_GIT_FAILED:${args.join(" ")}:${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
  return Buffer.from(result.stdout ?? []);
};

const gitText = (args: string[], options: { cwd?: string; input?: Buffer } = {}): string =>
  git(args, options).toString("utf8").trimEnd();

/** `<mode> <type> <sha>\t<path>` for one path in a tree, or undefined when the path is absent. */
const treeEntry = (commit: string, path: string): { mode: GitFileMode; sha: string } | undefined => {
  const result = spawnSync("git", ["ls-tree", "-z", commit, "--", path]);
  if (result.status !== 0) return undefined;
  const line = Buffer.from(result.stdout ?? []).toString("utf8").split("\0").filter(Boolean)[0];
  if (!line) return undefined;
  const [meta] = line.split("\t");
  const [mode, type, sha] = meta.split(/\s+/);
  if (type !== "blob") return undefined;
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_UNSUPPORTED_MODE:${path}:${mode}`);
  return { mode: mode as GitFileMode, sha };
};

/**
 * A patch in exactly the shape the verifier's `git apply -p1` consumes, with
 * `a/<path>` and `b/<path>` headers.
 *
 * Produced by git itself in a scratch repository rather than assembled by
 * hand: the diff format is git's to define, and a hand-rolled one would be a
 * second implementation of it that could drift from the applier.
 */
const buildPatch = (path: string, baseContent: Buffer | undefined, resultContent: Buffer): Buffer => {
  const scratch = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-author-"));
  try {
    git(["init", "--quiet", scratch]);
    git(["-C", scratch, "config", "user.email", "author@invalid"]);
    git(["-C", scratch, "config", "user.name", "author"]);
    const target = join(scratch, path);
    mkdirSync(dirname(target), { recursive: true });

    if (baseContent !== undefined) {
      writeFileSync(target, baseContent);
      git(["-C", scratch, "add", "--", path]);
      git(["-C", scratch, "commit", "--quiet", "-m", "base"]);
    }
    writeFileSync(target, resultContent);
    // --intent-to-add makes a CREATE show as a real addition rather than an
    // untracked file the diff would skip entirely.
    if (baseContent === undefined) git(["-C", scratch, "add", "--intent-to-add", "--", path]);

    // Binary patches are refused rather than silently emitted: `git apply`
    // would need --binary and the certificate's reviewability rests on a
    // human being able to read the hunks.
    const patch = git(["-C", scratch, "diff", "--no-color", "--no-ext-diff", "--", path]);
    if (patch.length === 0) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_EMPTY_PATCH:${path}`);
    // Two shapes, depending on whether --binary was requested: git either
    // emits "GIT binary patch" or refuses with "Binary files ... differ".
    // Either way the result is unreadable, and a certificate's reviewability
    // rests on a human being able to read the hunks.
    const asText = patch.toString("utf8");
    if (asText.includes("GIT binary patch") || /^Binary files .* differ$/m.test(asText)) {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_BINARY_PATH:${path}`);
    }
    return patch;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/**
 * Builds a certificate for an explicit manifest, then proves it by running
 * the real reconstruction. The returned candidate SHA is whatever that
 * reconstruction derives - this module never asserts a target of its own.
 */
export const authorAgentReferralsCandidate = (input: AuthorCandidateInput): AuthoredCandidate => {
  const { baseSha, sourceMainSha, manifest, patchDirectory, envelope } = input;
  if (manifest.length === 0) fail("AGENT_REFERRALS_CANDIDATE_AUTHOR_EMPTY_MANIFEST");

  // Output locations are validated BEFORE anything is derived or written:
  // both end up in `join(repositoryRoot, ...)`, so the same escape applies.
  assertSafeRepositoryPath(patchDirectory, "AGENT_REFERRALS_CANDIDATE_AUTHOR_PATCH_DIRECTORY_UNSAFE");

  const seen = new Set<string>();
  for (const entry of manifest) {
    // Path safety first, before treeEntry() or buildPatch() touch a
    // filesystem: a refusal that arrives after the write is not a refusal.
    assertSafeRepositoryPath(entry.path, "AGENT_REFERRALS_CANDIDATE_AUTHOR_PATH_UNSAFE");

    // Closed-domain validation, not a pair of equality checks. The previous
    // fence was fail-OPEN on a malformed classification: `ownership:
    // "SHRAED"` with `from: "source_main"` matched neither arm and sailed
    // through, importing the whole file - which is exactly the JSON/plain-JS
    // case the runtime check exists for. Classification may be wrong only as
    // a deliberate WHOLE_FILE judgement, never as a typo.
    const declared = entry as { ownership: string; source: { from: string } };
    if (!(OWNERSHIPS as readonly string[]).includes(declared.ownership)) {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_OWNERSHIP_INVALID:${entry.path}:${declared.ownership}`);
    }
    if (!declared.source || !(RESULT_SOURCES as readonly string[]).includes(declared.source.from)) {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_RESULT_SOURCE_INVALID:${entry.path}`);
    }
    if (declared.ownership === "SHARED" && declared.source.from === "source_main") {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_SHARED_PATH_REQUIRES_EXPLICIT_CONTENT:${entry.path}`);
    }

    if (seen.has(entry.path)) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_DUPLICATE_PATH:${entry.path}`);
    seen.add(entry.path);
    // Legal state is inherited from BASE unchanged, and the verifier refuses
    // these outright. Refused HERE as well because authoring no longer runs
    // the reconstruction - otherwise the refusal would arrive only after the
    // patches were written and committed.
    if (FORBIDDEN_PATH_PREFIXES.some((prefix) => entry.path.startsWith(prefix))) {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_FORBIDDEN_PATH:${entry.path}`);
    }
  }

  const paths: CertifiedPathEntry[] = [];
  const patches = new Map<string, Buffer>();

  manifest.forEach((entry, index) => {
    const base = treeEntry(baseSha, entry.path);

    if (entry.source.from === "delete") {
      if (!base) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_DELETE_PATH_ABSENT_IN_BASE:${entry.path}`);
      paths.push({ path: entry.path, kind: "DELETE", base_blob_sha: base!.sha });
      return;
    }

    let resultContent: Buffer;
    let mode: GitFileMode;
    if (entry.source.from === "source_main") {
      const main = treeEntry(sourceMainSha, entry.path);
      if (!main) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_PATH_ABSENT_IN_SOURCE_MAIN:${entry.path}`);
      resultContent = git(["cat-file", "-p", main!.sha]);
      mode = main!.mode;
    } else {
      resultContent = entry.source.content;
      // An explicit result keeps BASE's mode where the path exists, and is a
      // regular file where it does not. A mode change is not expressible
      // this way on purpose - it would be an unreviewable side effect of
      // supplying content.
      mode = base?.mode ?? "100644";
    }

    const baseContent = base ? git(["cat-file", "-p", base.sha]) : undefined;
    if (baseContent !== undefined && baseContent.equals(resultContent)) {
      fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_NO_CHANGE:${entry.path}`);
    }

    const patchContent = buildPatch(entry.path, baseContent, resultContent);
    const patchPath = `${patchDirectory}/${String(index + 1).padStart(4, "0")}.patch`;
    patches.set(patchPath, patchContent);

    const resultBlobSha = gitText(["hash-object", "-t", "blob", "--stdin"], { input: resultContent });
    const common = {
      path: entry.path,
      mode,
      patch_path: patchPath,
      // The blob SHA the patch file WILL have once committed unchanged. Git's
      // object id is a pure function of the content, so this is derivable
      // now and is what binds the certificate to the controller tree.
      patch_git_blob_sha: gitText(["hash-object", "-t", "blob", "--stdin"], { input: patchContent }),
      patch_sha256: sha256(patchContent),
      result_blob_sha: resultBlobSha,
    };

    paths.push(base
      ? { ...common, kind: "MODIFY", base_blob_sha: base.sha }
      : { ...common, kind: "CREATE" });
  });

  // tree_sha and the candidate SHA are DERIVED by the real reconstruction,
  // never asserted here. The two-pass shape is deliberate: the first pass
  // exists only to learn the tree the certified paths produce.
  const provisional = {
    base_sha: baseSha,
    source_main_sha: sourceMainSha,
    patch_source: "controller_tree" as const,
    paths,
    commit: { ...envelope, parent_sha: baseSha, tree_sha: "0".repeat(40) },
  };

  const treeSha = deriveTreeSha(baseSha, paths, patches);
  const certificate = { ...provisional, commit: { ...provisional.commit, tree_sha: treeSha } };

  return { certificate, patches, claimedCandidateSha: deriveCandidateSha(baseSha, treeSha, certificate.commit) };
};

/**
 * The proof, and the only authoritative answer.
 *
 * It reads the certificate out of the COMMITTED controller tree - the same
 * `git show <sha>:<path>` the production controller performs - rather than
 * trusting the object this module returned. That distinction is the whole
 * point: an earlier version verified the author's in-memory certificate
 * while binding only the patches to the committed tree, so a certificate
 * altered between authoring and commit would still have proved PASS while
 * the controller later read something else entirely.
 *
 * Returns undefined when the committed artifacts really reconstruct to the
 * claimed SHA, or a failure code. Calling it is not optional: an authored
 * certificate is a proposal until this passes against a real commit.
 */
export const proveAuthoredCandidate = (input: {
  /** The controller commit whose tree holds both the certificate and its patches. */
  readonly trustedPatchSourceSha: string;
  /** Repository path of the certificate inside that tree. */
  readonly certificatePath: string;
  readonly claimedCandidateSha: string;
}): string | undefined => {
  const shown = spawnSync("git", ["show", `${input.trustedPatchSourceSha}:${input.certificatePath}`], { maxBuffer: 1024 * 1024 * 256 });
  if (shown.status !== 0) return "AGENT_REFERRALS_CANDIDATE_AUTHOR_CERTIFICATE_NOT_COMMITTED";

  let committed: ControlledCandidateCertificate;
  try {
    committed = JSON.parse(Buffer.from(shown.stdout ?? []).toString("utf8")) as ControlledCandidateCertificate;
  } catch {
    return "AGENT_REFERRALS_CANDIDATE_AUTHOR_CERTIFICATE_UNPARSEABLE";
  }

  return verifyControlledCandidateCertificate(committed, input.claimedCandidateSha, {
    trusted_patch_source_sha: input.trustedPatchSourceSha,
  });
};

/** Derives the candidate commit from the envelope, exactly as the reconstruction does. */
const deriveCandidateSha = (baseSha: string, treeSha: string, envelope: CandidateCommitEnvelope): string => {
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: envelope.author_name,
    GIT_AUTHOR_EMAIL: envelope.author_email,
    GIT_AUTHOR_DATE: `@${envelope.author_timestamp} ${envelope.author_timezone}`,
    GIT_COMMITTER_NAME: envelope.committer_name,
    GIT_COMMITTER_EMAIL: envelope.committer_email,
    GIT_COMMITTER_DATE: `@${envelope.committer_timestamp} ${envelope.committer_timezone}`,
  };
  const commit = spawnSync("git", ["-c", "i18n.commitEncoding=UTF-8", "commit-tree", treeSha, "-p", baseSha, "-m", envelope.message, "--no-gpg-sign"], { env: commitEnv });
  if (commit.status !== 0) fail("AGENT_REFERRALS_CANDIDATE_AUTHOR_COMMIT_TREE_FAILED");
  return Buffer.from(commit.stdout ?? []).toString("utf8").trimEnd();
};

/**
 * Derives the tree the certified paths produce, without consulting any
 * target. Mirrors the verifier's own index steps - deliberately a second,
 * simpler derivation rather than a shared helper, so a mistake here shows up
 * as a TREE_SHA_MISMATCH from the real reconstruction rather than being
 * hidden by both sides sharing one implementation.
 */
const deriveTreeSha = (baseSha: string, paths: readonly CertifiedPathEntry[], patches: ReadonlyMap<string, Buffer>): string => {
  const indexDirectory = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-author-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(indexDirectory, "index") };
  const indexed = (args: string[]): string => {
    const result = spawnSync("git", args, { env });
    if (result.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_GIT_FAILED:${args.join(" ")}:${Buffer.from(result.stderr ?? []).toString("utf8").trim()}`);
    return Buffer.from(result.stdout ?? []).toString("utf8").trimEnd();
  };
  try {
    indexed(["read-tree", baseSha]);
    for (const entry of paths) {
      if (entry.kind === "DELETE") {
        indexed(["update-index", "--force-remove", entry.path]);
        continue;
      }
      const patch = patches.get(entry.patch_path);
      if (!patch) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_PATCH_MISSING:${entry.path}`);
      const written = gitText(["hash-object", "-w", "-t", "blob", "--stdin"], { input: applyForTree(entry, baseSha, patch!) });
      if (written !== entry.result_blob_sha) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_RESULT_BLOB_MISMATCH:${entry.path}`);
      indexed(["update-index", "--add", "--cacheinfo", `${entry.mode},${written},${entry.path}`]);
    }
    return indexed(["write-tree"]);
  } finally {
    rmSync(indexDirectory, { recursive: true, force: true });
  }
};

const applyForTree = (entry: CertifiedPathEntry, baseSha: string, patch: Buffer): Buffer => {
  if (entry.kind === "DELETE") return Buffer.alloc(0);
  const scratch = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-author-apply-"));
  try {
    const target = join(scratch, entry.path);
    if (entry.kind === "MODIFY") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, git(["cat-file", "-p", entry.base_blob_sha]));
    }
    const patchFile = join(scratch, ".authored.patch");
    writeFileSync(patchFile, patch);
    const applied = spawnSync("git", ["apply", "-p1", "--unsafe-paths", "--whitespace=nowarn", patchFile], { cwd: scratch });
    if (applied.status !== 0) fail(`AGENT_REFERRALS_CANDIDATE_AUTHOR_PATCH_APPLY_FAILED:${entry.path}`);
    return readFileSync(target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** Writes an authored candidate into a repository tree: the certificate and every patch it names. */
export const writeAuthoredCandidate = (repositoryRoot: string, certificateDirectory: string, authored: AuthoredCandidate): void => {
  // Same escape surface as the manifest's own paths: this resolves under the
  // repository root, and a refusal after the write would be worthless.
  assertSafeRepositoryPath(certificateDirectory, "AGENT_REFERRALS_CANDIDATE_AUTHOR_CERTIFICATE_DIRECTORY_UNSAFE");
  for (const path of authored.patches.keys()) assertSafeRepositoryPath(path, "AGENT_REFERRALS_CANDIDATE_AUTHOR_PATH_UNSAFE");

  const certificatePath = join(repositoryRoot, certificateDirectory, "certificate.json");
  mkdirSync(dirname(certificatePath), { recursive: true });
  writeFileSync(certificatePath, `${JSON.stringify(authored.certificate, null, 2)}\n`);
  for (const [path, content] of authored.patches) {
    const absolute = join(repositoryRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
};
