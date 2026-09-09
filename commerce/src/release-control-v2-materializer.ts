import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_CONTROL_V2_COMMIT_METADATA,
  RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
  RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
  releaseControlV2MaterializationMessage,
  validateReleaseControlV2MaterializationCertificate,
  type ReleaseControlV2CommitMetadata,
  type ReleaseControlV2MaterializationCertificate,
} from "./release-control-v2-materialization-schema";

export {
  RELEASE_CONTROL_V2_COMMIT_METADATA,
  RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
  RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
  validateReleaseControlV2MaterializationCertificate,
  type ReleaseControlV2CommitMetadata,
  type ReleaseControlV2MaterializationCertificate,
} from "./release-control-v2-materialization-schema";

const GIT_DATE = "946684800 +0000";
const SHA = /^[a-f0-9]{40}$/;
const patchArgs = [
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.quotePath=true",
  "-c", "diff.renames=false",
  "-c", "diff.orderFile=/dev/null",
  "-c", "diff.indentHeuristic=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "diff",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--no-indent-heuristic",
  "--diff-algorithm=myers",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;
const manifestArgs = [
  "-c", "core.quotePath=true",
  "-c", "diff.orderFile=/dev/null",
  "diff",
  "--name-only",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--diff-algorithm=myers",
] as const;

export type MaterializedReleaseControlV2Candidate = {
  readonly certificate: ReleaseControlV2MaterializationCertificate;
  readonly canonical_patch: Buffer;
};

export class ReleaseControlV2MaterializationError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code, { cause });
    this.name = "ReleaseControlV2MaterializationError";
  }
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const canonicalManifest = (paths: readonly string[]) => [...new Set(paths)].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
const isManifestPath = (path: string) => Boolean(path) && !path.includes("\0") && !path.startsWith("/") && !path.split("/").includes("..");

const fail = (code: string, cause?: unknown): never => { throw new ReleaseControlV2MaterializationError(code, cause); };

const git = (cwd: string, args: readonly string[], options: { readonly input?: string | Buffer; readonly env?: Readonly<Record<string, string | undefined>> } = {}): Buffer => {
  try {
    return execFileSync("git", [...args], {
      cwd,
      input: options.input,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return fail("MATERIALIZATION_GIT_FAILED", error);
  }
};

const gitText = (cwd: string, args: readonly string[], options?: { readonly input?: string | Buffer; readonly env?: Readonly<Record<string, string | undefined>> }) =>
  git(cwd, args, options).toString("utf8").trim();
const gitBytes = (cwd: string, args: readonly string[]) => git(cwd, args);

const assertSha = (value: string, code: string) => {
  if (!SHA.test(value)) fail(code);
};
const treeAt = (cwd: string, sha: string, code: string) => {
  const tree = gitText(cwd, ["rev-parse", `${sha}^{tree}`]);
  assertSha(tree, code);
  return tree;
};
const assertCommit = (cwd: string, sha: string, code: string) => {
  assertSha(sha, code);
  try {
    gitText(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    fail(code);
  }
};
const parentsOf = (cwd: string, sha: string) => {
  const tokens = gitText(cwd, ["rev-list", "--parents", "-n", "1", sha]).split(" ").filter(Boolean);
  if (tokens[0] !== sha) fail("MATERIALIZATION_SOURCE_IDENTITY_INVALID");
  return tokens.slice(1);
};

/** Refuses a side-branch commit even when it is otherwise reachable from main. */
export const assertReleaseControlV2SourceOnFirstParentIntegrationLineage = (cwd: string, source: string, integrationTip: string) => {
  assertCommit(cwd, source, "MATERIALIZATION_SOURCE_COMMIT_INVALID");
  assertCommit(cwd, integrationTip, "MATERIALIZATION_INTEGRATION_TIP_INVALID");
  const firstParentLineage = gitText(cwd, ["rev-list", "--first-parent", integrationTip]).split("\n").filter(Boolean);
  if (!firstParentLineage.includes(source)) fail("MATERIALIZATION_SOURCE_NOT_FIRST_PARENT_INTEGRATION_LINE");
};
const manifestBetween = (cwd: string, from: string, to: string) => {
  const bytes = gitBytes(cwd, [...manifestArgs, from, to]);
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index !== start) {
      try {
        paths.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, index)));
      } catch (error) {
        fail("MATERIALIZATION_PATH_MANIFEST_ENCODING_INVALID", error);
      }
    }
    start = index + 1;
  }
  if (start !== bytes.length) fail("MATERIALIZATION_PATH_MANIFEST_INVALID");
  if (paths.some((path) => !isManifestPath(path))) fail("MATERIALIZATION_PATH_MANIFEST_INVALID");
  return canonicalManifest(paths);
};
const patchBetween = (cwd: string, from: string, to: string) => gitBytes(cwd, [...patchArgs, from, to]);

const materializeTree = (cwd: string, base: string, patch: Buffer) => {
  const scratch = mkdtempSync(join(tmpdir(), "release-control-v2-index-"));
  const index = join(scratch, "index");
  const env = { GIT_INDEX_FILE: index };
  try {
    gitText(cwd, ["read-tree", `${base}^{tree}`], { env });
    try {
      gitText(cwd, ["apply", "--cached", "--whitespace=error"], { env, input: patch });
    } catch (error) {
      fail("MATERIALIZATION_APPLY_FAILED", error);
    }
    return gitText(cwd, ["write-tree"], { env });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

const commitCandidate = (cwd: string, tree: string, base: string, parent: string, source: string) => {
  const message = releaseControlV2MaterializationMessage(base, parent, source);
  const env = {
    GIT_AUTHOR_NAME: RELEASE_CONTROL_V2_COMMIT_METADATA.author_name,
    GIT_AUTHOR_EMAIL: RELEASE_CONTROL_V2_COMMIT_METADATA.author_email,
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_NAME: RELEASE_CONTROL_V2_COMMIT_METADATA.committer_name,
    GIT_COMMITTER_EMAIL: RELEASE_CONTROL_V2_COMMIT_METADATA.committer_email,
    GIT_COMMITTER_DATE: GIT_DATE,
  };
  const candidate = gitText(cwd, ["commit-tree", tree, "-p", base], { env, input: `${message}\n` });
  assertSha(candidate, "MATERIALIZATION_CANDIDATE_SHA_INVALID");
  return { candidate, message };
};

const exactMetadata = (message: string): ReleaseControlV2CommitMetadata => ({ ...RELEASE_CONTROL_V2_COMMIT_METADATA, message });

export const materializeReleaseControlV2Candidate = (cwd: string, input: { readonly production_base_sha: string; readonly source_commit_sha: string }): MaterializedReleaseControlV2Candidate => {
  const base = input.production_base_sha;
  const source = input.source_commit_sha;
  assertCommit(cwd, base, "MATERIALIZATION_PRODUCTION_BASE_INVALID");
  assertCommit(cwd, source, "MATERIALIZATION_SOURCE_COMMIT_INVALID");
  const parents = parentsOf(cwd, source);
  if (parents.length !== 1) fail("MATERIALIZATION_SOURCE_NOT_SINGLE_PARENT");
  const parent = parents[0]!;
  if (base === source || base === parent) fail("MATERIALIZATION_SOURCE_BASE_RELATIONSHIP_INVALID");
  const baseTree = treeAt(cwd, base, "MATERIALIZATION_PRODUCTION_BASE_TREE_INVALID");
  const sourceTree = treeAt(cwd, source, "MATERIALIZATION_SOURCE_TREE_INVALID");
  const parentTree = treeAt(cwd, parent, "MATERIALIZATION_SOURCE_PARENT_TREE_INVALID");
  const sourceManifest = manifestBetween(cwd, parent, source);
  const patch = patchBetween(cwd, parent, source);
  const candidateTree = materializeTree(cwd, base, patch);
  assertSha(candidateTree, "MATERIALIZATION_CANDIDATE_TREE_INVALID");
  const candidateManifest = manifestBetween(cwd, base, candidateTree);
  if (JSON.stringify(candidateManifest) !== JSON.stringify(sourceManifest)) fail("MATERIALIZATION_MANIFEST_MISMATCH");
  const { candidate, message } = commitCandidate(cwd, candidateTree, base, parent, source);
  if (gitText(cwd, ["rev-parse", `${candidate}^`]) !== base || treeAt(cwd, candidate, "MATERIALIZATION_CANDIDATE_TREE_INVALID") !== candidateTree) {
    fail("MATERIALIZATION_CANDIDATE_COMMIT_MISMATCH");
  }
  const certificate: ReleaseControlV2MaterializationCertificate = {
    schema_version: RELEASE_CONTROL_V2_MATERIALIZATION_SCHEMA_VERSION,
    production_base_sha: base,
    production_base_tree: baseTree,
    source_commit_sha: source,
    source_commit_tree: sourceTree,
    source_parent_sha: parent,
    source_parent_tree: parentTree,
    canonical_path_manifest: sourceManifest,
    path_manifest_sha256: sha256(JSON.stringify(sourceManifest)),
    patch_format_version: RELEASE_CONTROL_V2_PATCH_FORMAT_VERSION,
    patch_sha256: sha256(patch),
    candidate_sha: candidate,
    candidate_tree: candidateTree,
    candidate_parent_sha: base,
    commit_metadata: exactMetadata(message),
    materializer_version: RELEASE_CONTROL_V2_MATERIALIZER_VERSION,
  };
  validateReleaseControlV2MaterializationCertificate(certificate);
  return { certificate, canonical_patch: patch };
};

/** Recreates the sealed local candidate from immutable source and base objects. */
export const reconstructReleaseControlV2Candidate = (cwd: string, certificateInput: unknown): MaterializedReleaseControlV2Candidate => {
  const certificate = validateReleaseControlV2MaterializationCertificate(certificateInput);
  assertCommit(cwd, certificate.production_base_sha, "MATERIALIZATION_PRODUCTION_BASE_INVALID");
  assertCommit(cwd, certificate.source_commit_sha, "MATERIALIZATION_SOURCE_COMMIT_INVALID");
  if (treeAt(cwd, certificate.production_base_sha, "MATERIALIZATION_PRODUCTION_BASE_TREE_INVALID") !== certificate.production_base_tree ||
    treeAt(cwd, certificate.source_commit_sha, "MATERIALIZATION_SOURCE_TREE_INVALID") !== certificate.source_commit_tree ||
    treeAt(cwd, certificate.source_parent_sha, "MATERIALIZATION_SOURCE_PARENT_TREE_INVALID") !== certificate.source_parent_tree) {
    fail("MATERIALIZATION_SOURCE_TREE_MISMATCH");
  }
  const parents = parentsOf(cwd, certificate.source_commit_sha);
  if (parents.length !== 1) fail("MATERIALIZATION_SOURCE_NOT_SINGLE_PARENT");
  if (parents[0] !== certificate.source_parent_sha) fail("MATERIALIZATION_SOURCE_PARENT_MISMATCH");
  const sourceManifest = manifestBetween(cwd, certificate.source_parent_sha, certificate.source_commit_sha);
  if (JSON.stringify(sourceManifest) !== JSON.stringify(certificate.canonical_path_manifest)) fail("MATERIALIZATION_MANIFEST_MISMATCH");
  const patch = patchBetween(cwd, certificate.source_parent_sha, certificate.source_commit_sha);
  if (sha256(patch) !== certificate.patch_sha256) fail("MATERIALIZATION_PATCH_HASH_MISMATCH");
  const candidateTree = materializeTree(cwd, certificate.production_base_sha, patch);
  if (candidateTree !== certificate.candidate_tree || JSON.stringify(manifestBetween(cwd, certificate.production_base_sha, candidateTree)) !== JSON.stringify(certificate.canonical_path_manifest)) {
    fail("MATERIALIZATION_CANDIDATE_TREE_MISMATCH");
  }
  const candidate = commitCandidate(cwd, candidateTree, certificate.production_base_sha, certificate.source_parent_sha, certificate.source_commit_sha).candidate;
  if (candidate !== certificate.candidate_sha || gitText(cwd, ["rev-parse", `${candidate}^`]) !== certificate.production_base_sha) fail("MATERIALIZATION_CANDIDATE_SHA_MISMATCH");
  return { certificate, canonical_patch: patch };
};
