import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ReleaseCandidate, ReleaseCandidateReader, ReleaseClass } from "./candidate";

/**
 * Published candidates, on disk, write-once.
 *
 * A candidate is the release's identity, so it is the one input a deploy and a
 * rehearsal must agree on exactly. Storing it as a file that is created once
 * and never rewritten is what makes "the same candidate" a checkable claim
 * rather than a convention: republishing the same content is a success, and
 * republishing different content under the same id is refused rather than
 * quietly winning.
 *
 * The id is the commit. One commit is one release, and a second candidate for
 * the same tree with a different release class is exactly the disagreement the
 * candidate type exists to make impossible.
 */

export class CandidateStoreError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_CLASSES: readonly ReleaseClass[] = ["LAUNCH_BASELINE", "ROLLING_COMPATIBLE", "MAINTENANCE_REQUIRED"];

/** Field order fixed here, so the digest of a candidate does not depend on how it was built. */
export const canonicalCandidate = (candidate: ReleaseCandidate): string => JSON.stringify([
  candidate.id, candidate.sha, candidate.releaseClass,
  candidate.expectation.schemaInventory, candidate.expectation.legalVersion, candidate.expectation.legalManifestSha256,
]);

export const candidateDigest = (candidate: ReleaseCandidate): string =>
  createHash("sha256").update(canonicalCandidate(candidate)).digest("hex");

export const assertCandidate = (candidate: ReleaseCandidate): void => {
  const problems: string[] = [];
  if (!SHA.test(candidate.sha)) problems.push("sha");
  // The id is the commit: a candidate that could be named independently of the
  // tree it deploys is a second way to say what is being released.
  if (candidate.id !== candidate.sha) problems.push("id must be the commit");
  if (!RELEASE_CLASSES.includes(candidate.releaseClass)) problems.push("releaseClass");
  if (!/^inventory-sha256:[a-f0-9]{64}$/.test(candidate.expectation.schemaInventory)) problems.push("expectation.schemaInventory");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate.expectation.legalVersion)) problems.push("expectation.legalVersion");
  if (!SHA256.test(candidate.expectation.legalManifestSha256)) problems.push("expectation.legalManifestSha256");
  if (problems.length) throw new CandidateStoreError("RELEASE_CANDIDATE_INVALID", problems.join(", "));
};

export class FileReleaseCandidateStore implements ReleaseCandidateReader {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    if (!SHA.test(id)) throw new CandidateStoreError("RELEASE_CANDIDATE_ID_INVALID", id);
    return join(this.directory, `${id}.json`);
  }

  /**
   * Publishes, or proves the existing publication is the same one.
   *
   * The exclusive create is the whole mechanism: two publishers racing on one
   * commit cannot both win, and the loser compares content rather than
   * overwriting. A republication that differs in any field is a different
   * release wearing a published commit's name.
   */
  publish(candidate: ReleaseCandidate): { readonly candidate: ReleaseCandidate; readonly republished: boolean } {
    assertCandidate(candidate);
    const path = this.path(candidate.id);
    const body = `${JSON.stringify(candidate, null, 2)}\n`;
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = this.get(candidate.id);
      if (!existing || candidateDigest(existing) !== candidateDigest(candidate)) {
        throw new CandidateStoreError("RELEASE_CANDIDATE_ALREADY_PUBLISHED_DIFFERENTLY", candidate.id);
      }
      return { candidate: existing, republished: true };
    }
    try { writeSync(fd, body); } finally { closeSync(fd); }
    return { candidate, republished: false };
  }

  get(id: string): ReleaseCandidate | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new CandidateStoreError("RELEASE_CANDIDATE_UNREADABLE", id);
    }
    const expectation = (parsed.expectation ?? {}) as Record<string, unknown>;
    const candidate: ReleaseCandidate = {
      id: String(parsed.id ?? ""),
      sha: String(parsed.sha ?? ""),
      releaseClass: parsed.releaseClass as ReleaseClass,
      expectation: {
        schemaInventory: String(expectation.schemaInventory ?? ""),
        legalVersion: String(expectation.legalVersion ?? ""),
        legalManifestSha256: String(expectation.legalManifestSha256 ?? ""),
      },
    };
    // Validated on the way out, not only on the way in. A file that was edited
    // after publication is not a candidate, and discovering that at deploy time
    // is the only moment it still costs nothing.
    assertCandidate(candidate);
    if (candidate.id !== id) throw new CandidateStoreError("RELEASE_CANDIDATE_ID_MISMATCH", id);
    return candidate;
  }
}
