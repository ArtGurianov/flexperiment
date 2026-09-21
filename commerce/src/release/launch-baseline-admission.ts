import type { ReleaseCandidate } from "./candidate";
import { deriveCandidate, type CommitTreeReader } from "./candidate-publication";
import { assertCandidate, candidateDigest, CandidateStoreError } from "./candidate-store";

const SHA = /^[a-f0-9]{40}$/;

/**
 * The launch candidate is checked again where it is consumed.
 *
 * Publication proves that a candidate was main when it was written. This
 * guard proves that the same immutable artifact is still the launch baseline
 * immediately before the first mutation-capable entrypoint runs. Recovery is
 * deliberately outside this port: a durable session recovers its own target,
 * never whichever commit happens to be main later.
 */
export interface LaunchBaselineAdmission {
  admit(candidate: ReleaseCandidate): Promise<void>;
}

export type MainTipRefresh = () => Promise<string>;

const refusal = (detail?: string): CandidateStoreError =>
  new CandidateStoreError("LAUNCH_BASELINE_MUST_BE_MAIN_TIP", detail);

export class LaunchBaselineAdmissionGuard implements LaunchBaselineAdmission {
  constructor(
    private readonly tree: CommitTreeReader,
    private readonly refreshMainTip: MainTipRefresh,
  ) {}

  async admit(candidate: ReleaseCandidate): Promise<void> {
    try {
      assertCandidate(candidate);
      if (candidate.releaseClass !== "LAUNCH_BASELINE") {
        throw refusal(`candidate ${candidate.id} is ${candidate.releaseClass}`);
      }

      // Refresh at consumption time, after the runner lock has been acquired.
      // Derive from that exact commit rather than trusting the expectation that
      // was written when the candidate was published.
      const main = await this.refreshMainTip();
      if (!SHA.test(main)) throw refusal("origin/main is unreadable");
      const expected = await deriveCandidate(this.tree, {
        sha: main,
        releaseClass: "LAUNCH_BASELINE",
        mainRef: main,
      });

      // A second fresh read closes the lookup/derivation window. If main moved
      // while its tree was being inspected, no old target is allowed to start.
      const confirmedMain = await this.refreshMainTip();
      if (confirmedMain !== main) throw refusal(`origin/main changed from ${main} to ${confirmedMain}`);

      if (candidate.sha !== main || candidate.id !== main || candidateDigest(candidate) !== candidateDigest(expected)) {
        throw refusal(`${candidate.sha} != ${main}`);
      }
    } catch (error) {
      if (error instanceof CandidateStoreError && error.code === "LAUNCH_BASELINE_MUST_BE_MAIN_TIP") throw error;
      // Git errors can echo a credentialed remote in their command line. Only
      // stable candidate error codes may leave this boundary; transport and
      // process detail is deliberately collapsed.
      throw refusal(error instanceof CandidateStoreError ? error.code : "origin/main unreadable");
    }
  }
}

/**
 * Builds a fresh origin/main reader. Updating the tracking ref is intentional:
 * the admission decision must not be made from the checkout's earlier fetch.
 */
export const remoteMainTipRefresh = (
  options: {
    readonly remote: string;
    readonly cwd: string;
    readonly tree: CommitTreeReader;
    readonly git: (args: readonly string[], cwd: string) => Promise<string>;
  },
): MainTipRefresh => async () => {
  await options.git(["fetch", "--no-tags", options.remote, "main:refs/remotes/origin/main"], options.cwd);
  return options.tree.resolve("origin/main");
};
