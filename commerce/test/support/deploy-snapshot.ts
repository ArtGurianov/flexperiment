import type { DeploySurface, PreDeploySnapshot } from "../../src/release/deploy-session";

/**
 * A pre-deploy snapshot with every surface and the deploy pointer on one
 * commit, which is what a converged production looks like.
 *
 * The pointer is a value of the snapshot, not a detail the fixture hides: a
 * test about the two layers disagreeing passes `refSha` explicitly, so the
 * disagreement is visible at the call site rather than buried here.
 */
export const snapshot = (sha: string, refSha = sha): PreDeploySnapshot => ({
  runtime: { frontend: sha, admin: sha, commerce: sha, worker: sha },
  controlPlane: { productionDeployRefSha: refSha },
});

/**
 * The same snapshot with one surface moved.
 *
 * Written as a helper because the obvious spread - `{ ...before, worker: sha }`
 * - silently puts the surface beside `runtime` instead of inside it once the
 * snapshot has two layers. Every drift test in this suite was written that way,
 * and every one of them went on passing while no longer moving anything.
 */
export const withSurface = (base: PreDeploySnapshot, surface: DeploySurface, sha: string): PreDeploySnapshot =>
  ({ ...base, runtime: { ...base.runtime, [surface]: sha } });

/** The same runtime with the deploy pointer somewhere else. */
export const withDeployRef = (base: PreDeploySnapshot, sha: string): PreDeploySnapshot =>
  ({ ...base, controlPlane: { productionDeployRefSha: sha } });
