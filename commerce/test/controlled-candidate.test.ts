import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ControlledCandidateError,
  buildControlledCandidateCommit,
  reconstructControlledCandidateSha,
  verifyControlledCandidateCertificate,
  type ControlledCandidateCertificate,
  type CertifiedPathEntry,
} from "../src/controlled-candidate";

/**
 * Generic-core counterpart to commerce/test/agent-referrals-candidate.test.ts
 * - same synthetic-fixture technique (an isolated, per-test
 * GIT_OBJECT_DIRECTORY with no alternates, never touching the real
 * repository's object database or any ref), applied to the shared
 * `controlled-candidate.ts` reconstruction core both Agent Referrals and the
 * release-semantics bootstrap sit on top of. The one behavioral difference
 * from the frozen agent-referrals-candidate.ts fixtures: this module always
 * requires patch_source: "controller_tree" and an explicit
 * trusted_patch_source_sha, so every fixture here supplies both.
 */
let objectDirectory: string;
let previousObjectDirectory: string | undefined;

beforeEach(() => {
  objectDirectory = mkdtempSync(join(tmpdir(), "controlled-candidate-test-objects-"));
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

const envelope = (parentSha: string, treeSha: string, overrides: Partial<Omit<ControlledCandidateCertificate["commit"], "parent_sha" | "tree_sha">> = {}): ControlledCandidateCertificate["commit"] => ({
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
  message: "controlled-candidate: synthetic candidate",
  encoding: "none",
  extra_headers: "none",
  signed: false,
  ...overrides,
});

const modifyPatch = (path: string, hunk: string): string => `--- a/${path}\n+++ b/${path}\n${hunk}`;
const createPatch = (path: string, hunk: string): string => `--- /dev/null\n+++ b/${path}\n${hunk}`;

/**
 * Base: readme.md = "a\nb\nc\n". Controller tree: a patch turning it into
 * "a\nCHANGED\nc\n" at patches/0001.patch. Everything a MODIFY-only
 * certificate scenario needs; source_main_sha is a separate, unrelated
 * commit here (it need not carry the patch itself under this module's
 * controller_tree model - only the supplied trusted_patch_source_sha does).
 */
function modifyScenario() {
  const oldContent = "a\nb\nc\n";
  const newContent = "a\nCHANGED\nc\n";
  const baseBlob = writeBlob(oldContent);
  const baseSha = commitTree(mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]), undefined, "base");

  const sourceMainSha = commitTree(mktree([]), undefined, "source-main");

  const patchContent = modifyPatch("readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+CHANGED\n c\n");
  const patchBlob = writeBlob(patchContent);
  const controllerSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0001.patch" }]), sourceMainSha, "controller");

  const resultBlob = writeBlob(newContent);
  const entry: CertifiedPathEntry = {
    path: "readme.md", kind: "MODIFY", mode: "100644",
    base_blob_sha: baseBlob, patch_path: "patches/0001.patch",
    patch_git_blob_sha: patchBlob, patch_sha256: sha256(patchContent),
    result_blob_sha: resultBlob,
  };
  const treeSha = mktree([{ mode: "100644", sha: resultBlob, path: "readme.md" }]);
  const certificate: ControlledCandidateCertificate = { base_sha: baseSha, source_main_sha: sourceMainSha, patch_source: "controller_tree", paths: [entry], commit: envelope(baseSha, treeSha) };
  return { baseSha, sourceMainSha, controllerSha, baseBlob, patchBlob, patchContent, resultBlob, newContent, treeSha, entry, certificate };
}

describe("reconstruction: determinism and correctness", () => {
  it("two independent builds from one certificate produce the exact same reconstructed commit SHA", () => {
    const { certificate, controllerSha } = modifyScenario();
    const first = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha });
    const second = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{40}$/);
  });

  it("the reconstructed commit is an exact linear child of BASE carrying the patched content", () => {
    const { certificate, controllerSha, baseSha, newContent } = modifyScenario();
    const sha = buildControlledCandidateCommit(certificate, { trusted_patch_source_sha: controllerSha });
    expect(gitRun(["rev-list", "--parents", "-n", "1", sha]).split(/\s+/)).toEqual([sha, baseSha]);
    expect(gitRun(["cat-file", "-p", `${sha}:readme.md`])).toBe(newContent.trim());
  });

  it("verifyControlledCandidateCertificate accepts the certificate against its own reconstructed SHA", () => {
    const { certificate, controllerSha } = modifyScenario();
    const sha = buildControlledCandidateCommit(certificate, { trusted_patch_source_sha: controllerSha });
    expect(verifyControlledCandidateCertificate(certificate, sha, { trusted_patch_source_sha: controllerSha })).toBeUndefined();
  });

  it("never reads anything at a supplied target SHA - only compares the final reconstructed value", () => {
    const { certificate, controllerSha } = modifyScenario();
    const unresolvable = "9".repeat(40);
    expect(verifyControlledCandidateCertificate(certificate, unresolvable, { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_SHA_MISMATCH");
  });

  it("requires an explicit trusted_patch_source_sha - it is never derived from source_main_sha", () => {
    const { certificate } = modifyScenario();
    expect(() => reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: "" })).toThrow("CONTROLLED_CANDIDATE_TRUSTED_PATCH_SOURCE_REQUIRED");
  });

  it("rejects a certificate whose patch_source is not controller_tree", () => {
    const { certificate, controllerSha } = modifyScenario();
    const bogus = { ...certificate, patch_source: "source_main_tree" } as unknown as ControlledCandidateCertificate;
    expect(() => reconstructControlledCandidateSha(bogus, { trusted_patch_source_sha: controllerSha })).toThrow("CONTROLLED_CANDIDATE_PATCH_SOURCE_INVALID");
  });
});

describe("reconstruction: mutation detection", () => {
  it("rejects changed patch bytes (patch_sha256 no longer matches)", () => {
    const { certificate, entry, controllerSha } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, patch_sha256: "0".repeat(64) }] };
    expect(() => reconstructControlledCandidateSha(corrupted, { trusted_patch_source_sha: controllerSha })).toThrow(ControlledCandidateError);
    expect(verifyControlledCandidateCertificate(corrupted, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toMatch(/^CONTROLLED_CANDIDATE_PATCH_SHA256_MISMATCH/);
  });

  it("rejects a wrong patch_git_blob_sha", () => {
    const { certificate, entry, baseBlob, controllerSha } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, patch_git_blob_sha: baseBlob }] };
    expect(verifyControlledCandidateCertificate(corrupted, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toMatch(/^CONTROLLED_CANDIDATE_PATCH_BLOB_MISMATCH/);
  });

  it("rejects a wrong base blob", () => {
    const { certificate, entry, patchBlob, controllerSha } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, base_blob_sha: patchBlob }] };
    expect(verifyControlledCandidateCertificate(corrupted, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toMatch(/^CONTROLLED_CANDIDATE_BASE_BLOB_MISMATCH/);
  });

  it("rejects a wrong result_blob_sha", () => {
    const { certificate, entry, baseBlob, controllerSha } = modifyScenario();
    const corrupted = { ...certificate, paths: [{ ...entry, result_blob_sha: baseBlob }] };
    expect(verifyControlledCandidateCertificate(corrupted, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toMatch(/^CONTROLLED_CANDIDATE_RESULT_BLOB_MISMATCH/);
  });

  it("rejects a wrong pinned tree_sha, even though every path-level proof is individually correct", () => {
    const { certificate, baseSha, controllerSha } = modifyScenario();
    const wrongTree = { ...certificate, commit: envelope(baseSha, "f".repeat(40)) };
    expect(verifyControlledCandidateCertificate(wrongTree, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_TREE_SHA_MISMATCH");
  });

  it("rejects a parent_sha that disagrees with base_sha", () => {
    const { certificate, treeSha, controllerSha } = modifyScenario();
    const wrongParent = { ...certificate, commit: envelope("f".repeat(40), treeSha) };
    expect(verifyControlledCandidateCertificate(wrongParent, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_ENVELOPE_PARENT_SHA_MISMATCH");
  });

  it.each([
    ["encoding", { encoding: "gbk" }, "CONTROLLED_CANDIDATE_ENVELOPE_ENCODING_INVALID"],
    ["extra_headers", { extra_headers: "gpgsig ..." }, "CONTROLLED_CANDIDATE_ENVELOPE_EXTRA_HEADERS_INVALID"],
    ["signed", { signed: true }, "CONTROLLED_CANDIDATE_ENVELOPE_SIGNED_INVALID"],
  ])("rejects a certificate that asks for a non-frozen %s", (_label, override, code) => {
    const { certificate, baseSha, treeSha, controllerSha } = modifyScenario();
    const cert = { ...certificate, commit: envelope(baseSha, treeSha, override as Partial<ControlledCandidateCertificate["commit"]>) };
    expect(verifyControlledCandidateCertificate(cert, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toBe(code);
  });

  it("a changed canonical commit-envelope field changes the reconstructed SHA and fails verification", () => {
    const { certificate, baseSha, treeSha, controllerSha } = modifyScenario();
    const original = buildControlledCandidateCommit(certificate, { trusted_patch_source_sha: controllerSha });
    const mutated = { ...certificate, commit: envelope(baseSha, treeSha, { message: "a different message" }) };
    const withMutatedEnvelope = buildControlledCandidateCommit(mutated, { trusted_patch_source_sha: controllerSha });
    expect(withMutatedEnvelope).not.toBe(original);
    expect(verifyControlledCandidateCertificate(certificate, withMutatedEnvelope, { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_SHA_MISMATCH");
    expect(verifyControlledCandidateCertificate(mutated, original, { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_SHA_MISMATCH");
  });

  it("whole-file overlay cannot satisfy the reconstruction contract", () => {
    const overlayContent = "a\nCHANGED\nc\n";
    const overlayBlob = writeBlob(overlayContent);
    const { certificate, entry, sourceMainSha } = modifyScenario();
    const bogus = { ...certificate, paths: [{ ...entry, patch_git_blob_sha: overlayBlob, patch_sha256: sha256(overlayContent), result_blob_sha: writeBlob(overlayContent) }] };
    const bogusControllerSha = commitTree(mktree([{ mode: "100644", sha: overlayBlob, path: "patches/0001.patch" }]), sourceMainSha, "controller-overlay");
    expect(() => reconstructControlledCandidateSha(bogus, { trusted_patch_source_sha: bogusControllerSha })).toThrow(ControlledCandidateError);
    expect(verifyControlledCandidateCertificate(bogus, "1".repeat(40), { trusted_patch_source_sha: bogusControllerSha })).toMatch(/^CONTROLLED_CANDIDATE_PATCH_APPLY_FAILED/);
  });
});

describe("reconstruction: legal paths can never be certified", () => {
  const minimal = (path: string): ControlledCandidateCertificate => ({
    base_sha: "a".repeat(40),
    source_main_sha: "b".repeat(40),
    patch_source: "controller_tree",
    paths: [{ path, kind: "DELETE", base_blob_sha: "c".repeat(40) }],
    commit: envelope("a".repeat(40), "d".repeat(40)),
  });

  it.each([
    "public/legal/public-offer.md",
    "commerce/legal/production-manifest.json",
  ])("refuses %s before ever touching git", (path) => {
    expect(() => reconstructControlledCandidateSha(minimal(path), { trusted_patch_source_sha: "e".repeat(40) })).toThrow(ControlledCandidateError);
    try { reconstructControlledCandidateSha(minimal(path), { trusted_patch_source_sha: "e".repeat(40) }); }
    catch (error) { expect((error as ControlledCandidateError).code).toBe("CONTROLLED_CANDIDATE_LEGAL_PATH_FORBIDDEN"); }
  });
});

describe("reconstruction: CREATE entries", () => {
  it("CREATE adds a new path with the patched content, absent from BASE", () => {
    const { baseSha, baseBlob, sourceMainSha } = modifyScenario();
    const newFileContent = "brand new file\n";
    const patchContent = createPatch("notes.md", "@@ -0,0 +1,1 @@\n+brand new file\n");
    const patchBlob = writeBlob(patchContent);
    const controllerSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0002.patch" }]), sourceMainSha, "controller-create");
    const resultBlob = writeBlob(newFileContent);
    const entry: CertifiedPathEntry = {
      path: "notes.md", kind: "CREATE", mode: "100644",
      patch_path: "patches/0002.patch", patch_git_blob_sha: patchBlob,
      patch_sha256: sha256(patchContent), result_blob_sha: resultBlob,
    };
    const treeSha = mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }, { mode: "100644", sha: resultBlob, path: "notes.md" }]);
    const certificate: ControlledCandidateCertificate = { base_sha: baseSha, source_main_sha: sourceMainSha, patch_source: "controller_tree", paths: [entry], commit: envelope(baseSha, treeSha) };
    const sha = buildControlledCandidateCommit(certificate, { trusted_patch_source_sha: controllerSha });
    expect(gitRun(["cat-file", "-p", `${sha}:notes.md`])).toBe(newFileContent.trim());
    expect(spawnSync("git", ["cat-file", "-e", `${baseSha}:notes.md`]).status).not.toBe(0);
  });

  it("refuses a CREATE whose path already exists in BASE", () => {
    const { baseSha, sourceMainSha } = modifyScenario();
    const patchContent = createPatch("readme.md", "@@ -0,0 +1,1 @@\n+won't apply anyway\n");
    const patchBlob = writeBlob(patchContent);
    const controllerSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/0003.patch" }]), sourceMainSha, "controller-create-conflict");
    const entry: CertifiedPathEntry = {
      path: "readme.md", kind: "CREATE", mode: "100644",
      patch_path: "patches/0003.patch", patch_git_blob_sha: patchBlob,
      patch_sha256: sha256(patchContent), result_blob_sha: "f".repeat(40),
    };
    const certificate: ControlledCandidateCertificate = { base_sha: baseSha, source_main_sha: sourceMainSha, patch_source: "controller_tree", paths: [entry], commit: envelope(baseSha, "f".repeat(40)) };
    expect(() => reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha })).toThrow("CONTROLLED_CANDIDATE_CREATE_PATH_ALREADY_EXISTS_IN_BASE");
  });
});

describe("reconstruction: no unexpected paths enter the candidate", () => {
  it("rejects a declared path whose reconstructed content is identical to BASE (nothing actually changed)", () => {
    const oldContent = "a\nb\nc\n";
    const baseBlob = writeBlob(oldContent);
    const baseSha = commitTree(mktree([{ mode: "100644", sha: baseBlob, path: "readme.md" }]), undefined, "base");
    const sourceMainSha = commitTree(mktree([]), undefined, "source-main");
    // A syntactically valid remove+add hunk whose text is identical - the
    // certified path is declared as changed, but reconstruction produces the
    // exact same bytes as BASE, so it must never appear in BASE..TARGET's diff.
    const patchContent = modifyPatch("readme.md", "@@ -1,3 +1,3 @@\n a\n-b\n+b\n c\n");
    const patchBlob = writeBlob(patchContent);
    const controllerSha = commitTree(mktree([{ mode: "100644", sha: patchBlob, path: "patches/noop.patch" }]), sourceMainSha, "controller-noop");
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
    const certificate: ControlledCandidateCertificate = { base_sha: baseSha, source_main_sha: sourceMainSha, patch_source: "controller_tree", paths: [entry], commit: envelope(baseSha, treeSha) };
    expect(verifyControlledCandidateCertificate(certificate, "1".repeat(40), { trusted_patch_source_sha: controllerSha })).toBe("CONTROLLED_CANDIDATE_UNEXPECTED_CHANGED_PATHS");
  });
});
