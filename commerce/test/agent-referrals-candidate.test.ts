import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentReferralsCandidateError,
  buildAgentReferralsCandidateCommit,
  reconstructAgentReferralsCandidateSha,
  verifyAgentReferralsCandidateCertificate,
  type AgentReferralsCandidateCertificate,
  type CertifiedPathEntry,
} from "../src/agent-referrals-candidate";

/**
 * All fixture objects (blobs/trees/commits) are written into an isolated,
 * per-test GIT_OBJECT_DIRECTORY with no alternates - fully synthetic, never
 * touching the real repository's object database, and never referenced by
 * any ref. See the empirical confirmation this works in the PR1 delivery
 * notes: a fresh object directory needs no `git init`.
 */
let objectDirectory: string;
let previousObjectDirectory: string | undefined;

beforeEach(() => {
  objectDirectory = mkdtempSync(join(tmpdir(), "agent-referrals-candidate-test-objects-"));
  previousObjectDirectory = process.env.GIT_OBJECT_DIRECTORY;
  process.env.GIT_OBJECT_DIRECTORY = objectDirectory;
});

afterEach(() => {
  if (previousObjectDirectory === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
  else process.env.GIT_OBJECT_DIRECTORY = previousObjectDirectory;
  rmSync(objectDirectory, { recursive: true, force: true });
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const gitRun = (args: string[], input?: string, env: NodeJS.ProcessEnv = process.env): string => {
  const result = spawnSync("git", args, { input, env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr ?? []).toString("utf8")}`);
  return Buffer.from(result.stdout ?? []).toString("utf8").trim();
};

const writeBlob = (content: string): string => gitRun(["hash-object", "-w", "--stdin"], content);

type FlatEntry = { mode: string; sha: string; path: string };

/** `git mktree` (non-batch) only accepts direct children, so a path with a
 * slash needs its subtree built and referenced recursively. */
const mktree = (entries: FlatEntry[]): string => {
  if (!entries.length) return gitRun(["mktree"], "");
  const direct: string[] = [];
  const grouped = new Map<string, FlatEntry[]>();
  for (const entry of entries) {
    const slash = entry.path.indexOf("/");
    if (slash === -1) {
      direct.push(`${entry.mode} blob ${entry.sha}\t${entry.path}`);
    } else {
      const dir = entry.path.slice(0, slash);
      const rest = entry.path.slice(slash + 1);
      grouped.set(dir, [...(grouped.get(dir) ?? []), { ...entry, path: rest }]);
    }
  }
  for (const [dir, subEntries] of grouped) direct.push(`040000 tree ${mktree(subEntries)}\t${dir}`);
  return gitRun(["mktree"], `${direct.join("\n")}\n`);
};

// Never rely on ambient git identity config: a CI runner has none configured,
// unlike a developer machine, so commit-tree must carry its own explicit
// author/committer identity exactly like the production module does. Read
// fresh (never a module-level snapshot) so the per-test GIT_OBJECT_DIRECTORY
// override from beforeEach is always included.
const fixtureCommitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "Test Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Test Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test",
});

const commitTree = (tree: string, parent: string | undefined, message: string): string => {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", message, "--no-gpg-sign");
  return gitRun(args, undefined, fixtureCommitEnv());
};

/**
 * parent_sha and tree_sha are certificate-specific (they depend on baseSha
 * and the exact final tree), so they are required positional arguments
 * rather than defaults - there is no safe generic default for either, and a
 * wrong one should be a deliberate test choice, never an accident.
 */
const envelope = (parentSha: string, treeSha: string, overrides: Partial<Omit<AgentReferralsCandidateCertificate["commit"], "parent_sha" | "tree_sha">> = {}): AgentReferralsCandidateCertificate["commit"] => ({
  parent_sha: parentSha,
  tree_sha: treeSha,
  author_name: "Flexperiment Release Control",
  author_email: "release-control@flexperiment.ru",
  author_timestamp: 1_700_000_000,
  author_timezone: "+0000",
  committer_name: "Flexperiment Release Control",
  committer_email: "release-control@flexperiment.ru",
  committer_timestamp: 1_700_000_000,
  committer_timezone: "+0000",
  message: "agent-referrals: synthetic candidate",
  encoding: "none",
  extra_headers: "none",
  signed: false,
  ...overrides,
});

/** A committed unified diff, a` "--- a/<path>" / "+++ b/<path>"` shape identical to real git diff output for one file. */
const modifyPatch = (path: string, hunk: string): string => `--- a/${path}\n+++ b/${path}\n${hunk}`;
const createPatch = (path: string, hunk: string): string => `--- /dev/null\n+++ b/${path}\n${hunk}`;

/**
 * Base: readme.md = "a\nb\nc\n". Main: a patch turning it into "a\nCHANGED\nc\n"
 * at patches/0001.patch. Everything a MODIFY-only certificate scenario needs.
 */
function modifyScenario() {
  const oldContent = "a\nb\nc\n";
  const newContent = "a\nCHANGED\nc\n";
  const baseBlob = writeBlob(oldContent);
  const baseSha = commitTree(mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]), undefined, "base");

  const patchContent = modifyPatch("readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+CHANGED\n c\n");
  const patchBlob = writeBlob(patchContent);
  const mainSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0001.patch" }]), undefined, "main");

  const resultBlob = writeBlob(newContent);
  const entry: CertifiedPathEntry = {
    path: "readme.md", kind: "MODIFY", mode: "100644",
    base_blob_sha: baseBlob, patch_path: "patches/0001.patch",
    patch_git_blob_sha: patchBlob, patch_sha256: sha256(patchContent),
    result_blob_sha: resultBlob,
  };
  const treeSha = mktree([{ mode: "100644", sha: resultBlob, path: "readme.md" }]);
  const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths: [entry], commit: envelope(baseSha, treeSha) };
  return { baseSha, mainSha, baseBlob, patchBlob, patchContent, resultBlob, newContent, treeSha, entry, certificate };
}

describe("reconstruction: determinism and correctness", () => {
  it("two independent builds from one certificate produce the exact same reconstructed commit SHA", () => {
    const { certificate } = modifyScenario();
    const first = reconstructAgentReferralsCandidateSha(certificate);
    const second = reconstructAgentReferralsCandidateSha(certificate);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the reconstructed commit is an exact linear child of BASE carrying the patched content", () => {
    const { certificate, baseSha, newContent } = modifyScenario();
    const sha = buildAgentReferralsCandidateCommit(certificate);
    expect(gitRun(["rev-list", "--parents", "-n", "1", sha]).split(/\s+/)).toEqual([sha, baseSha]);
    expect(gitRun(["cat-file", "-p", `${sha}:readme.md`])).toBe(newContent.trim());
  });

  it("verifyAgentReferralsCandidateCertificate accepts the certificate against its own reconstructed SHA", () => {
    const { certificate } = modifyScenario();
    const sha = buildAgentReferralsCandidateCommit(certificate);
    expect(verifyAgentReferralsCandidateCertificate(certificate, sha)).toBeUndefined();
  });

  it("never reads anything at a supplied target SHA - only compares the final reconstructed value", () => {
    const { certificate } = modifyScenario();
    // An unresolvable target SHA (well-formed, but no such object exists) must
    // still be handled purely by comparison, proving nothing is dereferenced.
    const unresolvable = "9".repeat(40);
    expect(verifyAgentReferralsCandidateCertificate(certificate, unresolvable)).toBe("AGENT_REFERRALS_CANDIDATE_SHA_MISMATCH");
  });
});

describe("reconstruction: mutation detection", () => {
  it("rejects changed patch bytes (patch_sha256 no longer matches)", () => {
    const { certificate, entry } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, patch_sha256: "0".repeat(64) }] };
    expect(() => reconstructAgentReferralsCandidateSha(corrupted)).toThrow(AgentReferralsCandidateError);
    expect(verifyAgentReferralsCandidateCertificate(corrupted, "1".repeat(40))).toMatch(/^AGENT_REFERRALS_CANDIDATE_PATCH_SHA256_MISMATCH/);
  });

  it("rejects a wrong patch_git_blob_sha", () => {
    const { certificate, entry, baseBlob } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, patch_git_blob_sha: baseBlob }] };
    expect(verifyAgentReferralsCandidateCertificate(corrupted, "1".repeat(40))).toMatch(/^AGENT_REFERRALS_CANDIDATE_PATCH_BLOB_MISMATCH/);
  });

  it("rejects a wrong base blob", () => {
    const { certificate, entry, patchBlob } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, base_blob_sha: patchBlob }] };
    expect(verifyAgentReferralsCandidateCertificate(corrupted, "1".repeat(40))).toMatch(/^AGENT_REFERRALS_CANDIDATE_BASE_BLOB_MISMATCH/);
  });

  it("rejects a wrong result_blob_sha", () => {
    const { certificate, entry, baseBlob } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, result_blob_sha: baseBlob }] };
    expect(verifyAgentReferralsCandidateCertificate(corrupted, "1".repeat(40))).toMatch(/^AGENT_REFERRALS_CANDIDATE_RESULT_BLOB_MISMATCH/);
  });

  it("rejects a wrong pinned tree_sha, even though every path-level proof is individually correct", () => {
    const { certificate, baseSha } = modifyScenario();
    const wrongTree = { ...certificate, commit: envelope(baseSha, "f".repeat(40)) };
    expect(verifyAgentReferralsCandidateCertificate(wrongTree, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_TREE_SHA_MISMATCH");
  });

  it("rejects a parent_sha that disagrees with base_sha", () => {
    const { certificate, treeSha } = modifyScenario();
    const wrongParent = { ...certificate, commit: envelope("f".repeat(40), treeSha) };
    expect(verifyAgentReferralsCandidateCertificate(wrongParent, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_ENVELOPE_PARENT_SHA_MISMATCH");
  });

  it.each([
    ["encoding", { encoding: "gbk" }, "AGENT_REFERRALS_CANDIDATE_ENVELOPE_ENCODING_INVALID"],
    ["extra_headers", { extra_headers: "gpgsig ..." }, "AGENT_REFERRALS_CANDIDATE_ENVELOPE_EXTRA_HEADERS_INVALID"],
    ["signed", { signed: true }, "AGENT_REFERRALS_CANDIDATE_ENVELOPE_SIGNED_INVALID"],
  ])("rejects a certificate that asks for a non-frozen %s", (_label, override, code) => {
    const { certificate, baseSha, treeSha } = modifyScenario();
    const cert = { ...certificate, commit: envelope(baseSha, treeSha, override as Partial<AgentReferralsCandidateCertificate["commit"]>) };
    expect(verifyAgentReferralsCandidateCertificate(cert, "1".repeat(40))).toBe(code);
  });

  it("a changed canonical commit-envelope field changes the reconstructed SHA and fails verification", () => {
    const { certificate, baseSha, treeSha } = modifyScenario();
    const original = buildAgentReferralsCandidateCommit(certificate);
    const mutated = { ...certificate, commit: envelope(baseSha, treeSha, { message: "a different message" }) };
    const withMutatedEnvelope = buildAgentReferralsCandidateCommit(mutated);
    expect(withMutatedEnvelope).not.toBe(original);
    expect(verifyAgentReferralsCandidateCertificate(certificate, withMutatedEnvelope)).toBe("AGENT_REFERRALS_CANDIDATE_SHA_MISMATCH");
    expect(verifyAgentReferralsCandidateCertificate(mutated, original)).toBe("AGENT_REFERRALS_CANDIDATE_SHA_MISMATCH");
  });

  it.each([
    ["author_timestamp", { author_timestamp: 1_700_000_001 }],
    ["author_timezone", { author_timezone: "+0100" }],
    ["committer_name", { committer_name: "Someone Else" }],
    ["committer_email", { committer_email: "someone@else.test" }],
  ])("changing envelope field %s changes the reconstructed SHA", (_label, override) => {
    const { certificate, baseSha, treeSha } = modifyScenario();
    const original = buildAgentReferralsCandidateCommit(certificate);
    const mutated = buildAgentReferralsCandidateCommit({ ...certificate, commit: envelope(baseSha, treeSha, override) });
    expect(mutated).not.toBe(original);
  });

  it("whole-file overlay cannot satisfy the reconstruction contract", () => {
    // Not a diff at all - just the raw target bytes, as if someone tried to
    // skip the patch machinery and overlay a whole file straight from main.
    const overlayContent = "a\nCHANGED\nc\n";
    const overlayBlob = writeBlob(overlayContent);
    const { certificate, entry } = modifyScenario();
    const bogus = { ...certificate, paths: [{ ...entry, patch_git_blob_sha: overlayBlob, patch_sha256: sha256(overlayContent), result_blob_sha: writeBlob(overlayContent) }] };
    // Rebuild main so the bogus blob is genuinely present at patch_path in main's tree.
    const mainSha = commitTree(mktree([{ mode: "100644", sha: overlayBlob, path: "patches/0001.patch" }]), undefined, "main-overlay");
    const withOverlayMain = { ...bogus, source_main_sha: mainSha };
    expect(() => reconstructAgentReferralsCandidateSha(withOverlayMain)).toThrow(AgentReferralsCandidateError);
    expect(verifyAgentReferralsCandidateCertificate(withOverlayMain, "1".repeat(40))).toMatch(/^AGENT_REFERRALS_CANDIDATE_PATCH_APPLY_FAILED/);
  });
});

describe("reconstruction: legal paths can never be certified", () => {
  const minimal = (path: string): AgentReferralsCandidateCertificate => ({
    base_sha: "a".repeat(40),
    source_main_sha: "b".repeat(40),
    paths: [{ path, kind: "DELETE", base_blob_sha: "c".repeat(40) }],
    commit: envelope("a".repeat(40), "d".repeat(40)),
  });

  it.each([
    "public/legal/public-offer.md",
    "commerce/legal/production-manifest.json",
  ])("refuses %s before ever touching git", (path) => {
    expect(() => reconstructAgentReferralsCandidateSha(minimal(path))).toThrow(AgentReferralsCandidateError);
    try { reconstructAgentReferralsCandidateSha(minimal(path)); }
    catch (error) { expect((error as AgentReferralsCandidateError).code).toBe("AGENT_REFERRALS_CANDIDATE_LEGAL_PATH_FORBIDDEN"); }
  });
});

describe("reconstruction: CREATE and DELETE entries", () => {
  it("CREATE adds a new path with the patched content, absent from BASE", () => {
    const { baseSha, baseBlob } = modifyScenario();
    const newFileContent = "brand new file\n";
    const patchContent = createPatch("notes.md", "@@ -0,0 +1,1 @@\n+brand new file\n");
    const patchBlob = writeBlob(patchContent);
    const mainSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0002.patch" }]), undefined, "main-create");
    const resultBlob = writeBlob(newFileContent);
    const entry: CertifiedPathEntry = {
      path: "notes.md", kind: "CREATE", mode: "100644",
      patch_path: "patches/0002.patch", patch_git_blob_sha: patchBlob,
      patch_sha256: sha256(patchContent), result_blob_sha: resultBlob,
    };
    const treeSha = mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }, { mode: "100644", sha: resultBlob, path: "notes.md" }]);
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths: [entry], commit: envelope(baseSha, treeSha) };
    const sha = buildAgentReferralsCandidateCommit(certificate);
    expect(gitRun(["cat-file", "-p", `${sha}:notes.md`])).toBe(newFileContent.trim());
    expect(spawnSync("git", ["cat-file", "-e", `${baseSha}:notes.md`]).status).not.toBe(0);
  });

  it("refuses a CREATE whose path already exists in BASE", () => {
    const { baseSha } = modifyScenario(); // BASE already has readme.md
    const patchContent = createPatch("readme.md", "@@ -0,0 +1,1 @@\n+won't apply anyway\n");
    const patchBlob = writeBlob(patchContent);
    const mainSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0003.patch" }]), undefined, "main-create-collision");
    const entry: CertifiedPathEntry = {
      path: "readme.md", kind: "CREATE", mode: "100644",
      patch_path: "patches/0003.patch", patch_git_blob_sha: patchBlob,
      patch_sha256: sha256(patchContent), result_blob_sha: "0".repeat(40),
    };
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths: [entry], commit: envelope(baseSha, "1".repeat(40)) };
    expect(verifyAgentReferralsCandidateCertificate(certificate, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_CREATE_PATH_ALREADY_EXISTS_IN_BASE:readme.md");
  });

  it("DELETE removes the path from the reconstructed tree", () => {
    const { baseSha, baseBlob } = modifyScenario();
    const entry: CertifiedPathEntry = { path: "readme.md", kind: "DELETE", base_blob_sha: baseBlob };
    const treeSha = mktree([]);
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: baseSha, paths: [entry], commit: envelope(baseSha, treeSha) };
    const sha = buildAgentReferralsCandidateCommit(certificate);
    expect(spawnSync("git", ["cat-file", "-e", `${sha}:readme.md`]).status).not.toBe(0);
  });

  it("a nested subdirectory path is created correctly", () => {
    const oldTree = mktree([]);
    const baseSha = commitTree(oldTree, undefined, "empty base");
    const patchContent = createPatch("commerce/src/agent-referrals-foo.ts", "@@ -0,0 +1,1 @@\n+export const x = 1;\n");
    const patchBlob = writeBlob(patchContent);
    const mainSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0004.patch" }]), undefined, "main-nested");
    const resultBlob = writeBlob("export const x = 1;\n");
    const entry: CertifiedPathEntry = {
      path: "commerce/src/agent-referrals-foo.ts", kind: "CREATE", mode: "100644",
      patch_path: "patches/0004.patch", patch_git_blob_sha: patchBlob,
      patch_sha256: sha256(patchContent), result_blob_sha: resultBlob,
    };
    const treeSha = mktree([{ mode: "100644", sha: resultBlob, path: "commerce/src/agent-referrals-foo.ts" }]);
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths: [entry], commit: envelope(baseSha, treeSha) };
    const sha = buildAgentReferralsCandidateCommit(certificate);
    expect(gitRun(["cat-file", "-p", `${sha}:commerce/src/agent-referrals-foo.ts`])).toBe("export const x = 1;");
  });

  it("combines MODIFY and CREATE in one certificate and produces exactly those two changed paths", () => {
    const { baseSha, baseBlob } = modifyScenario();
    const modifyPatchContent = modifyPatch("readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+CHANGED\n c\n");
    const modifyPatchBlob = writeBlob(modifyPatchContent);
    const createPatchContent = createPatch("notes.md", "@@ -0,0 +1,1 @@\n+hello\n");
    const createPatchBlob = writeBlob(createPatchContent);
    const mainSha = commitTree(mktree([
      { mode: "100644", sha: modifyPatchBlob, path: "patches/modify.patch" },
      { mode: "100644", sha: createPatchBlob, path: "patches/create.patch" },
    ]), undefined, "main-combined");
    const modifiedBlob = writeBlob("a\nCHANGED\nc\n");
    const createdBlob = writeBlob("hello\n");
    const paths: CertifiedPathEntry[] = [
      { path: "readme.md", kind: "MODIFY", mode: "100644", base_blob_sha: baseBlob, patch_path: "patches/modify.patch", patch_git_blob_sha: modifyPatchBlob, patch_sha256: sha256(modifyPatchContent), result_blob_sha: modifiedBlob },
      { path: "notes.md", kind: "CREATE", mode: "100644", patch_path: "patches/create.patch", patch_git_blob_sha: createPatchBlob, patch_sha256: sha256(createPatchContent), result_blob_sha: createdBlob },
    ];
    const treeSha = mktree([{ mode: "100644", sha: modifiedBlob, path: "readme.md" }, { mode: "100644", sha: createdBlob, path: "notes.md" }]);
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths, commit: envelope(baseSha, treeSha) };
    const sha = buildAgentReferralsCandidateCommit(certificate);
    const changed = gitRun(["diff", "--name-only", baseSha, sha]).split("\n").filter(Boolean).sort();
    expect(changed).toEqual(["notes.md", "readme.md"]);
  });
});

describe("reconstruction: no unexpected paths enter the candidate", () => {
  it("rejects a declared path whose reconstructed content is identical to BASE (nothing actually changed)", () => {
    const oldContent = "a\nb\nc\n";
    const baseBlob = writeBlob(oldContent);
    const baseSha = commitTree(mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]), undefined, "base");
    // A syntactically valid remove+add hunk whose text is identical - the
    // certified path is declared as changed, but reconstruction produces the
    // exact same bytes as BASE, so it must never appear in BASE..Q's diff.
    const patchContent = modifyPatch("readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+b\n c\n");
    const patchBlob = writeBlob(patchContent);
    const mainSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/noop.patch" }]), undefined, "main-noop");
    const entry: CertifiedPathEntry = {
      path: "readme.md", kind: "MODIFY", mode: "100644",
      base_blob_sha: baseBlob, patch_path: "patches/noop.patch",
      patch_git_blob_sha: patchBlob, patch_sha256: sha256(patchContent),
      result_blob_sha: writeBlob(oldContent),
    };
    // The reconstructed tree is byte-identical to BASE's own tree (nothing
    // really changed), so the pinned tree_sha here is correct and the
    // failure under test is specifically the changed-paths check below it,
    // not a tree_sha mismatch.
    const treeSha = mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]);
    const certificate: AgentReferralsCandidateCertificate = { base_sha: baseSha, source_main_sha: mainSha, paths: [entry], commit: envelope(baseSha, treeSha) };
    expect(verifyAgentReferralsCandidateCertificate(certificate, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_UNEXPECTED_CHANGED_PATHS");
  });
});

describe("certificate validation", () => {
  const base: AgentReferralsCandidateCertificate = { base_sha: "a".repeat(40), source_main_sha: "b".repeat(40), paths: [], commit: envelope("a".repeat(40), "d".repeat(40)) };

  it("rejects an empty manifest", () => {
    expect(() => reconstructAgentReferralsCandidateSha(base)).toThrow(AgentReferralsCandidateError);
  });

  it("rejects a malformed base_sha or source_main_sha", () => {
    const withPaths = { ...base, paths: [{ path: "x", kind: "DELETE", base_blob_sha: "c".repeat(40) }] as CertifiedPathEntry[] };
    expect(verifyAgentReferralsCandidateCertificate({ ...withPaths, base_sha: "not-a-sha" }, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_BASE_SHA_INVALID");
    expect(verifyAgentReferralsCandidateCertificate({ ...withPaths, source_main_sha: "not-a-sha" }, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_SOURCE_MAIN_SHA_INVALID");
  });

  it("rejects a duplicate path", () => {
    const entry: CertifiedPathEntry = { path: "x", kind: "DELETE", base_blob_sha: "c".repeat(40) };
    expect(verifyAgentReferralsCandidateCertificate({ ...base, paths: [entry, entry] }, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_DUPLICATE_PATH");
  });

  it("rejects path traversal and absolute paths", () => {
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config"]) {
      const entry: CertifiedPathEntry = { path, kind: "DELETE", base_blob_sha: "c".repeat(40) };
      expect(verifyAgentReferralsCandidateCertificate({ ...base, paths: [entry] }, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_PATH_INVALID");
    }
  });

  it("rejects an invalid file mode", () => {
    const entry = { path: "x", kind: "CREATE", mode: "100777", patch_path: "p", patch_git_blob_sha: "c".repeat(40), patch_sha256: "d".repeat(64), result_blob_sha: "e".repeat(40) } as unknown as CertifiedPathEntry;
    expect(verifyAgentReferralsCandidateCertificate({ ...base, paths: [entry] }, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_MODE_INVALID");
  });

  it("rejects a malformed envelope timezone", () => {
    const entry: CertifiedPathEntry = { path: "x", kind: "DELETE", base_blob_sha: "c".repeat(40) };
    const cert = { ...base, paths: [entry], commit: envelope("a".repeat(40), "d".repeat(40), { author_timezone: "UTC" }) };
    expect(verifyAgentReferralsCandidateCertificate(cert, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_ENVELOPE_TIMEZONE_INVALID");
  });

  it("rejects a malformed envelope tree_sha", () => {
    const entry: CertifiedPathEntry = { path: "x", kind: "DELETE", base_blob_sha: "c".repeat(40) };
    const cert = { ...base, paths: [entry], commit: envelope("a".repeat(40), "not-a-sha") };
    expect(verifyAgentReferralsCandidateCertificate(cert, "1".repeat(40))).toBe("AGENT_REFERRALS_CANDIDATE_ENVELOPE_TREE_SHA_INVALID");
  });

  it("rejects a malformed target SHA at the verify entry point", () => {
    const entry: CertifiedPathEntry = { path: "x", kind: "DELETE", base_blob_sha: "c".repeat(40) };
    expect(verifyAgentReferralsCandidateCertificate({ ...base, paths: [entry] }, "not-a-sha")).toBe("AGENT_REFERRALS_CANDIDATE_TARGET_SHA_INVALID");
  });
});
