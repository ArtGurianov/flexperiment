import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorAgentReferralsCandidate, proveAuthoredCandidate, writeAuthoredCandidate, type AuthoredPath } from "../src/agent-referrals-candidate-author";

/**
 * The authoring half of the controlled-candidate contract, proven on a
 * synthetic repository rather than on the real one: what is under test is
 * the machinery, and a fixture that is a few files long makes every
 * assertion legible.
 *
 * The property that matters throughout: the author is NOT trusted. Every
 * case ends by handing the certificate to the untouched verifier, which
 * re-derives everything from the certificate alone. A certificate that only
 * agrees with its own author is worth nothing.
 */

const ENVELOPE = {
  author_name: "Flexperiment Release Control",
  author_email: "release-control@flexperiment.ru",
  author_timestamp: 1788739200,
  author_timezone: "+0000",
  committer_name: "Flexperiment Release Control",
  committer_email: "release-control@flexperiment.ru",
  committer_timestamp: 1788739200,
  committer_timezone: "+0000",
  message: "Agent Referrals candidate",
  encoding: "none" as const,
  extra_headers: "none" as const,
  signed: false as const,
};

let repo: string;
let originalCwd: string;

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }).trimEnd();

const write = (path: string, content: string) => {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
};

const commitAll = (message: string): string => {
  git("add", "-A");
  // --allow-empty: authoring the same manifest twice writes byte-identical
  // patches, so the second commit has nothing new - which is the determinism
  // being tested, not a failure.
  git("-c", "user.email=t@invalid", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
};

beforeEach(() => {
  originalCwd = process.cwd();
  repo = mkdtempSync(join(tmpdir(), "candidate-author-fixture-"));
  git("init", "--quiet", "-b", "main", repo);
  // The author and the verifier both shell out to git in the CURRENT working
  // directory, so the fixture repository has to be it.
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repo, { recursive: true, force: true });
});

/**
 * BASE and MAIN diverge, exactly as production's detached candidate and main
 * do - never a linear "main is ahead of base".
 */
const divergedFixture = () => {
  write("shared.ts", "shared v0\nline b\nline c\n");
  write("keep.ts", "untouched\n");
  const root = commitAll("root");

  // BASE: a detached production commit with its own change.
  git("checkout", "--quiet", "-b", "base", root);
  write("shared.ts", "shared v0\nline b BASE\nline c\n");
  const baseSha = commitAll("base-only change");

  // MAIN: unrelated work on the other side of the divergence.
  git("checkout", "--quiet", "main");
  write("feature.ts", "feature file\n");
  write("shared.ts", "shared v0\nline b MAIN\nline c\nmain-only tail\n");
  write("unrelated.ts", "unrelated main-only work\n");
  const mainSha = commitAll("main-only work");

  return { baseSha, mainSha };
};

const CERTIFICATE_DIRECTORY = ".release/controlled-candidates/fixture";
const CERTIFICATE_PATH = `${CERTIFICATE_DIRECTORY}/certificate.json`;

/**
 * The real sequence, which the proof depends on being real:
 *
 *   author -> write certificate AND patches -> commit -> prove that commit
 *
 * An earlier version of this helper committed only the patches and proved
 * the author's in-memory certificate, so it could not have caught a
 * certificate altered between authoring and commit - exactly what the
 * production controller reads with `git show <sha>:<path>`.
 */
const authorOne = (baseSha: string, mainSha: string, manifest: readonly AuthoredPath[]) => {
  const authored = authorAgentReferralsCandidate({
    baseSha, sourceMainSha: mainSha, manifest,
    patchDirectory: `${CERTIFICATE_DIRECTORY}/patches`,
    envelope: ENVELOPE,
  });
  writeAuthoredCandidate(repo, CERTIFICATE_DIRECTORY, authored);
  const patchSourceSha = commitAll("controller tree: certificate and patches");
  return { ...authored, patchSourceSha };
};

type Authored = ReturnType<typeof authorOne>;

const verify = (authored: Authored, overrides: { patchSourceSha?: string } = {}) =>
  proveAuthoredCandidate({
    trustedPatchSourceSha: overrides.patchSourceSha ?? authored.patchSourceSha,
    certificatePath: CERTIFICATE_PATH,
    claimedCandidateSha: authored.claimedCandidateSha,
  });

/**
 * Rewrites the COMMITTED certificate and returns the new controller SHA.
 * Mutating the author's in-memory object would prove nothing: the production
 * controller reads `git show <sha>:<path>`, so that is what a tamper case has
 * to attack.
 */
const recommitCertificate = (mutate: (certificate: Record<string, unknown>) => Record<string, unknown>): string => {
  const current = JSON.parse(readFileSync(join(repo, CERTIFICATE_PATH), "utf8")) as Record<string, unknown>;
  write(CERTIFICATE_PATH, `${JSON.stringify(mutate(current), null, 2)}\n`);
  return commitAll("controller tree: tampered certificate");
};

describe("authoring a controlled candidate", () => {
  it("produces a certificate the untouched verifier accepts, and a candidate whose parent is BASE", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);


    expect(verify(authored)).toBeUndefined();
    expect(git("rev-parse", `${authored.claimedCandidateSha}^`)).toBe(baseSha);
    expect(authored.certificate.patch_source).toBe("controller_tree");
    expect(authored.certificate.commit.parent_sha).toBe(baseSha);
  });

  it("a CREATE takes the whole blob from source main; the result blob is main's, bit for bit", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);

    const entry = authored.certificate.paths[0];
    expect(entry.kind).toBe("CREATE");
    expect(entry.kind !== "DELETE" ? entry.result_blob_sha : "").toBe(git("rev-parse", `${mainSha}:feature.ts`));
    expect(git("cat-file", "-p", `${authored.claimedCandidateSha}:feature.ts`)).toBe("feature file");
  });

  /**
   * The rule the review fixed for shared paths: a shared file's result is
   * supplied deliberately, never lifted from main - because main's version
   * carries unrelated work that would be imported silently.
   */
  it("a shared path takes ONLY the supplied content - main's unrelated tail does not come along", () => {
    const { baseSha, mainSha } = divergedFixture();
    // BASE's own line is kept; only the intended delta is added. main's
    // "main-only tail" and its "line b MAIN" are deliberately absent.
    const intended = "shared v0\nline b BASE\nline c\nintended feature delta\n";
    const authored = authorOne(baseSha, mainSha, [
      { path: "shared.ts", ownership: "SHARED", source: { from: "explicit", content: Buffer.from(intended) } },
    ]);

    expect(verify(authored)).toBeUndefined();
    const resulting = git("cat-file", "-p", `${authored.claimedCandidateSha}:shared.ts`);
    expect(resulting).toBe(intended.trimEnd());
    expect(resulting).not.toContain("main-only tail");
    expect(resulting).toContain("line b BASE");
  });

  /**
   * Review round 1, P1. This was a test asserting that the mechanism ALLOWED
   * the hazard - "manifest discipline is what keeps it out" - which made the
   * claim of a structural fence false. Ownership is now part of the manifest
   * and the dangerous transport is unavailable for a SHARED path.
   */
  it("a SHARED path may not be taken from source main at all", () => {
    const { baseSha, mainSha } = divergedFixture();
    expect(() => authorOne(baseSha, mainSha, [
      // The type already makes this unrepresentable; the cast is how a plain
      // JS caller or a JSON-deserialized manifest would arrive here.
      { path: "shared.ts", ownership: "SHARED", source: { from: "source_main" } } as unknown as AuthoredPath,
    ])).toThrow(/SHARED_PATH_REQUIRES_EXPLICIT_CONTENT/);
  });

  it("and the hazard it prevents is real: the same path as WHOLE_FILE does import main's unrelated work", () => {
    const { baseSha, mainSha } = divergedFixture();
    // Classifying shared.ts as WHOLE_FILE is a product-judgement error, which
    // machinery cannot detect - what it can do is make that judgement the
    // only place the mistake is possible, rather than a transport choice
    // buried in a manifest entry.
    const authored = authorOne(baseSha, mainSha, [{ path: "shared.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
    expect(git("cat-file", "-p", `${authored.claimedCandidateSha}:shared.ts`)).toContain("main-only tail");
  });

  it("MODIFY pins the BASE blob it was authored against, so a moved BASE is refused rather than reinterpreted", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [
      { path: "shared.ts", ownership: "SHARED", source: { from: "explicit", content: Buffer.from("shared v0\nline b BASE\nline c\ndelta\n") } },
    ]);

    const entry = authored.certificate.paths[0];
    expect(entry.kind).toBe("MODIFY");
    expect(entry.kind === "MODIFY" ? entry.base_blob_sha : "").toBe(git("rev-parse", `${baseSha}:shared.ts`));

    // A certificate whose base blob no longer matches is refused by the
    // verifier - this is the property that makes the f540b997 certificate
    // unusable now that production's BASE has moved.
    const tamperedSource = recommitCertificate((certificate) => ({
      ...certificate,
      paths: [{ ...entry, base_blob_sha: git("rev-parse", `${mainSha}:shared.ts`) }],
    }));
    expect(verify(authored, { patchSourceSha: tamperedSource })).toMatch(/BASE_BLOB_MISMATCH/);
  });

  it("DELETE carries no patch and removes the path from the candidate tree", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [{ path: "keep.ts", ownership: "WHOLE_FILE", source: { from: "delete" } }]);

    expect(authored.patches.size).toBe(0);
    expect(authored.certificate.paths[0].kind).toBe("DELETE");
    expect(verify(authored)).toBeUndefined();
    expect(() => git("cat-file", "-p", `${authored.claimedCandidateSha}:keep.ts`)).toThrow();
  });

  it("the certified manifest is the complete change set - nothing outside it enters the tree", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);

    const changed = git("diff", "--name-only", baseSha, authored.claimedCandidateSha).split("\n").filter(Boolean);
    expect(changed).toEqual(["feature.ts"]);
    // main's other work is NOT in the candidate, even though it is in main.
    expect(() => git("cat-file", "-p", `${authored.claimedCandidateSha}:unrelated.ts`)).toThrow();
  });

  it("is deterministic: the same inputs author the same candidate SHA", () => {
    const { baseSha, mainSha } = divergedFixture();
    const first = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
    const second = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
    expect(second.claimedCandidateSha).toBe(first.claimedCandidateSha);
    expect(second.certificate.commit.tree_sha).toBe(first.certificate.commit.tree_sha);
  });

  it("the patch blob SHA is the one the file will really have once committed", () => {
    const { baseSha, mainSha } = divergedFixture();
    const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
    const [patchPath] = [...authored.patches][0];
    const entry = authored.certificate.paths[0];
    // authorOne already committed them; the SHA the certificate predicted
    // must be the one the committed file really has.
    expect(entry.kind !== "DELETE" ? entry.patch_git_blob_sha : "").toBe(git("rev-parse", `${authored.patchSourceSha}:${patchPath}`));
  });

  describe("refusals", () => {
    it("refuses a path whose content does not actually change", () => {
      const { baseSha, mainSha } = divergedFixture();
      const unchanged = git("cat-file", "-p", `${baseSha}:shared.ts`);
      expect(() => authorOne(baseSha, mainSha, [
        { path: "shared.ts", ownership: "SHARED", source: { from: "explicit", content: Buffer.from(`${unchanged}\n`) } },
      ])).toThrow(/NO_CHANGE/);
    });

    it("refuses a duplicate path", () => {
      const { baseSha, mainSha } = divergedFixture();
      expect(() => authorOne(baseSha, mainSha, [
        { path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } },
        { path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } },
      ])).toThrow(/DUPLICATE_PATH/);
    });

    it("refuses an empty manifest", () => {
      const { baseSha, mainSha } = divergedFixture();
      expect(() => authorOne(baseSha, mainSha, [])).toThrow(/EMPTY_MANIFEST/);
    });

    it("refuses a source_main path that does not exist there", () => {
      const { baseSha, mainSha } = divergedFixture();
      expect(() => authorOne(baseSha, mainSha, [{ path: "absent.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]))
        .toThrow(/PATH_ABSENT_IN_SOURCE_MAIN/);
    });

    it("refuses deleting a path BASE does not have", () => {
      const { baseSha, mainSha } = divergedFixture();
      expect(() => authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "delete" } }]))
        .toThrow(/DELETE_PATH_ABSENT_IN_BASE/);
    });

    it("refuses a legal path, which the verifier forbids by construction", () => {
      const { baseSha } = divergedFixture();
      git("checkout", "--quiet", "main");
      write("public/legal/offer.html", "legal text\n");
      const mainSha = commitAll("legal");
      expect(() => authorOne(baseSha, mainSha, [{ path: "public/legal/offer.html", ownership: "WHOLE_FILE", source: { from: "source_main" } }]))
        .toThrow();
    });

    it("refuses a binary path rather than emitting a patch nobody can read", () => {
      const { baseSha } = divergedFixture();
      git("checkout", "--quiet", "main");
      const absolute = join(repo, "image.bin");
      writeFileSync(absolute, Buffer.from([0, 1, 2, 0, 3, 255, 0]));
      const mainSha = commitAll("binary");
      expect(() => authorOne(baseSha, mainSha, [{ path: "image.bin", ownership: "WHOLE_FILE", source: { from: "source_main" } }]))
        .toThrow(/BINARY_PATH/);
    });
  });

  describe("the author is not trusted", () => {
    it("a tampered result blob is caught by the verifier, not by the author", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
  
      const entry = authored.certificate.paths[0];
      const tamperedSource = recommitCertificate((certificate) => ({
        ...certificate,
        paths: [{ ...entry, result_blob_sha: git("rev-parse", `${mainSha}:unrelated.ts`) }],
      }));
      expect(verify(authored, { patchSourceSha: tamperedSource })).toMatch(/RESULT_BLOB_MISMATCH/);
    });

    it("a tampered patch file is caught: the certificate pins its content digest", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
      const [patchPath, patchContent] = [...authored.patches][0];
      write(patchPath, `${patchContent.toString("utf8")}\n# tampered\n`);
      // The tampered controller tree, not the clean one authorOne committed -
      // otherwise this would verify the original patch and prove nothing.
      const tamperedSource = commitAll("commit a tampered patch");

      expect(verify(authored, { patchSourceSha: tamperedSource }))
        .toMatch(/PATCH_BLOB_MISMATCH|PATCH_SHA256_MISMATCH/);
    });

    it("a certificate altered between authoring and commit is caught - the proof reads what the controller will read", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
      // The author's in-memory certificate is untouched and still correct;
      // only the committed artifact changes. An earlier version of prove()
      // verified the in-memory object and would have passed here.
      const tamperedSource = recommitCertificate((certificate) => ({ ...certificate, base_sha: mainSha }));

      expect(verify(authored, { patchSourceSha: tamperedSource })).toBeDefined();
      // And the author's own object is provably still the good one.
      expect(authored.certificate.base_sha).toBe(baseSha);
    });

    it("a certificate that was never committed cannot be proved", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
      expect(proveAuthoredCandidate({
        trustedPatchSourceSha: authored.patchSourceSha,
        certificatePath: ".release/controlled-candidates/absent/certificate.json",
        claimedCandidateSha: authored.claimedCandidateSha,
      })).toBe("AGENT_REFERRALS_CANDIDATE_AUTHOR_CERTIFICATE_NOT_COMMITTED");
    });

    it("an unparseable committed certificate is named, not thrown", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
      write(CERTIFICATE_PATH, "{ not json\n");
      const broken = commitAll("controller tree: unparseable certificate");
      expect(verify(authored, { patchSourceSha: broken })).toBe("AGENT_REFERRALS_CANDIDATE_AUTHOR_CERTIFICATE_UNPARSEABLE");
    });

    it("a tampered tree_sha is caught", () => {
      const { baseSha, mainSha } = divergedFixture();
      const authored = authorOne(baseSha, mainSha, [{ path: "feature.ts", ownership: "WHOLE_FILE", source: { from: "source_main" } }]);
  
      const tamperedSource = recommitCertificate((certificate) => ({
        ...certificate,
        commit: { ...(certificate.commit as Record<string, unknown>), tree_sha: git("rev-parse", `${mainSha}^{tree}`) },
      }));
      expect(verify(authored, { patchSourceSha: tamperedSource })).toMatch(/TREE_SHA_MISMATCH/);
    });
  });
});
