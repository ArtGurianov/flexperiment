import type { ReleaseReadinessExpectation } from "./readiness";

/**
 * A candidate is the release's identity, and everything else about a deploy is
 * a projection of it.
 *
 * Holding the commit, the release class and the readiness expectation as three
 * independently supplied arguments meant they could disagree - a maintenance
 * revision deployed as rolling, an expectation belonging to a different commit -
 * and nothing in the type system had an opinion. They travel together now
 * because they are one fact.
 */
/**
 * Every release closes sales, deploys, and is certified by a person before it
 * reopens them. A rolling class - "proved readable by the running revision,
 * so sales need not close" - existed until 2026-09-25 with nothing able to
 * produce that proof, and was removed rather than left as a choice an
 * operator could make.
 */
export type ReleaseClass = "MAINTENANCE_REQUIRED";

/**
 * The launch cutover's class. It replaced the database once, on 2026-09-24,
 * and was retired with the machinery that did it: its candidate files are
 * history, read through `FileReleaseCandidateStore.readHistorical`, and are
 * never a `ReleaseCandidate`.
 */
export type RetiredReleaseClass = "LAUNCH_BASELINE";

export type CandidateExpectation = Omit<ReleaseReadinessExpectation, "sourceCommit">;

export type ReleaseCandidate = {
  readonly id: string;
  readonly sha: string;
  readonly releaseClass: ReleaseClass;
  /** The candidate is the sole owner of the source commit identity. */
  readonly expectation: CandidateExpectation;
};

/** A published candidate file as history: releasable, or from a retired class. */
export type HistoricalCandidate = Omit<ReleaseCandidate, "releaseClass"> & {
  readonly releaseClass: ReleaseClass | RetiredReleaseClass;
};

/**
 * Materializes readiness input at its consumer. There is deliberately no
 * second source-commit field to compare: a candidate cannot be constructed
 * with one SHA to deploy and another SHA to admit.
 */
export const readinessExpectation = (candidate: ReleaseCandidate): ReleaseReadinessExpectation => ({
  ...candidate.expectation,
  sourceCommit: candidate.sha,
});

export interface ReleaseCandidateReader {
  get(candidateId: string): ReleaseCandidate | undefined;
}
