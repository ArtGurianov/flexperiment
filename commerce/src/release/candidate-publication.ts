import { createHash } from "node:crypto";
import type { ReleaseCandidate, ReleaseClass } from "./candidate";
import { schemaInventoryExpectation } from "./expectation";
import { canonicalLegalManifest, parseLegalManifest } from "../legal-manifest";
import { CandidateStoreError } from "./candidate-store";

/**
 * Deriving a candidate from the commit it is for.
 *
 * Nothing here is supplied by an operator except the commit and the release
 * class. The schema inventory and the legal binding are read out of that
 * commit's own tree, so a candidate cannot be published claiming an expectation
 * its tree does not have - which is the one way readiness could be made to
 * admit the wrong release.
 */

const SHA = /^[a-f0-9]{40}$/;
/** LAUNCH_BASELINE is retired: its candidates stay readable, and none is derived again. */
const RELEASE_CLASSES: readonly ReleaseClass[] = ["ROLLING_COMPATIBLE", "MAINTENANCE_REQUIRED"];

/** Reads a commit's tree. Injected so the publication can be proved against a real repository. */
export interface CommitTreeReader {
  /** File names directly under a directory at that commit. */
  list(sha: string, directory: string): Promise<readonly string[]>;
  read(sha: string, path: string): Promise<string>;
  /** Whether `ancestor` is reachable from `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  resolve(ref: string): Promise<string>;
}

export const deriveCandidate = async (
  tree: CommitTreeReader,
  input: { readonly sha: string; readonly releaseClass: ReleaseClass; readonly mainRef?: string },
): Promise<ReleaseCandidate> => {
  if (!SHA.test(input.sha)) throw new CandidateStoreError("RELEASE_CANDIDATE_SHA_INVALID", input.sha);
  if ((input.releaseClass as string) === "LAUNCH_BASELINE") throw new CandidateStoreError("LAUNCH_BASELINE_RETIRED", input.sha);
  if (!RELEASE_CLASSES.includes(input.releaseClass)) throw new CandidateStoreError("RELEASE_CANDIDATE_CLASS_INVALID", String(input.releaseClass));

  const mainRef = input.mainRef ?? "origin/main";
  const main = await tree.resolve(mainRef);
  if (!await tree.isAncestor(input.sha, main)) {
    throw new CandidateStoreError("RELEASE_CANDIDATE_NOT_ON_MAIN", `${input.sha} is not an ancestor of ${mainRef}`);
  }

  const migrations = (await tree.list(input.sha, "commerce/migrations")).filter((name) => name.endsWith(".sql"));
  if (!migrations.length) throw new CandidateStoreError("RELEASE_CANDIDATE_NO_MIGRATIONS", input.sha);

  let legal: { version: string; manifestSha256: string };
  try {
    const raw = JSON.parse(await tree.read(input.sha, "commerce/legal/production-manifest.json")) as Record<string, unknown>;
    const version = raw.version;
    if (typeof version !== "string") throw new Error("version");
    const canonical = canonicalLegalManifest(parseLegalManifest(raw));
    legal = { version, manifestSha256: createHash("sha256").update(canonical).digest("hex") };
  } catch (error) {
    throw new CandidateStoreError("RELEASE_CANDIDATE_LEGAL_MANIFEST_INVALID", error instanceof Error ? error.message : "unknown error");
  }

  return {
    id: input.sha,
    sha: input.sha,
    releaseClass: input.releaseClass,
    expectation: {
      schemaInventory: schemaInventoryExpectation(migrations),
      legalVersion: legal.version,
      legalManifestSha256: legal.manifestSha256,
    },
  };
};

/** Reads a commit's tree through git, without ever checking it out. */
export class GitCommitTreeReader implements CommitTreeReader {
  constructor(
    private readonly cwd: string,
    private readonly git: (args: readonly string[], cwd: string) => Promise<string>,
  ) {}

  async list(sha: string, directory: string): Promise<readonly string[]> {
    const output = await this.git(["ls-tree", "--name-only", `${sha}:${directory}`], this.cwd);
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  read(sha: string, path: string): Promise<string> {
    return this.git(["show", `${sha}:${path}`], this.cwd);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", ancestor, descendant], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  async resolve(ref: string): Promise<string> {
    const sha = (await this.git(["rev-parse", `${ref}^{commit}`], this.cwd)).trim();
    if (!SHA.test(sha)) throw new CandidateStoreError("RELEASE_CANDIDATE_REF_UNRESOLVED", ref);
    return sha;
  }
}
