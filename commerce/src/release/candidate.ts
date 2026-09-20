import type { DeployMode } from "./deploy-session";
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
export type ReleaseClass =
  /** The launch cutover itself: replaces the database, so never rolling. */
  | "LAUNCH_BASELINE"
  /** Proved readable by the previous revision, so sales need not close. */
  | "ROLLING_COMPATIBLE"
  /** Anything else. Absence of proof is not compatibility. */
  | "MAINTENANCE_REQUIRED";

export type ReleaseCandidate = {
  readonly id: string;
  readonly sha: string;
  readonly releaseClass: ReleaseClass;
  readonly expectation: ReleaseReadinessExpectation;
};

/**
 * Derived, never chosen. An operator who could pick ROLLING_SAFE for a launch
 * baseline would skip the fence and the certification along with it, so the
 * decision belongs to whoever classified the candidate - and only an explicit
 * proof of compatibility earns the rolling path.
 */
export const deployMode = (candidate: ReleaseCandidate): DeployMode =>
  candidate.releaseClass === "ROLLING_COMPATIBLE" ? "ROLLING_SAFE" : "MAINTENANCE_CUTOVER";

export interface ReleaseCandidateReader {
  get(candidateId: string): ReleaseCandidate | undefined;
}
