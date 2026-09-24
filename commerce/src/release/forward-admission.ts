import { readFileSync } from "node:fs";
import type { ReleaseCandidate } from "./candidate";
import { deriveCandidate, type CommitTreeReader } from "./candidate-publication";
import { assertCandidate, candidateDigest, CandidateStoreError } from "./candidate-store";
import type { ReleaseBinding } from "./forward-target";

/**
 * Admission of a NEW forward revision: whether this candidate may become the
 * release an armed session is carried forward to.
 *
 * It is checked afresh, after the runner lock is taken, and only when a
 * revision is being created. Once a revision is recorded its binding - and the
 * CI evidence read here - is the authority, and resuming it never asks again
 * whether it is still main's tip: if main moves while revision N deploys,
 * revision N must still be finishable. See docs/release/FORWARD_SUPERSESSION.md.
 */

export type MainTipRefresh = () => Promise<string>;

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

export class ForwardAdmissionError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const refusal = (detail: string) => new ForwardAdmissionError("FORWARD_DEPLOY_ADMISSION_REFUSED", detail);

/** The runner process's own checkout, which must be the candidate it deploys. */
export type InstalledRunner = (candidateSha: string) => Promise<{
  readonly sha: string;
  readonly tree: string;
  readonly candidateTree: string;
  readonly clean: boolean;
}>;

/** Reads, for one exact commit, whether its required CI succeeded. Returns the evidence it read. */
export interface CiAttestation {
  attest(sha: string): Promise<string>;
}

export class ForwardSupersessionAdmissionGuard {
  constructor(
    private readonly tree: CommitTreeReader,
    private readonly refreshMainTip: MainTipRefresh,
    private readonly installedRunner: InstalledRunner,
    private readonly ci: CiAttestation,
  ) {}

  /** Returns the CI evidence to record with the revision. Refuses with FORWARD_DEPLOY_ADMISSION_REFUSED. */
  async admit(candidate: ReleaseCandidate, current: ReleaseBinding): Promise<{ readonly ciEvidence: string }> {
    try {
      assertCandidate(candidate);
      if (candidate.releaseClass !== "MAINTENANCE_REQUIRED") throw refusal(`candidate ${candidate.id} is ${candidate.releaseClass}`);

      // Today's main, fetched after the lock, and the candidate re-derived from
      // that exact commit rather than trusted as published.
      const main = await this.refreshMainTip();
      const expected = await deriveCandidate(this.tree, { sha: main, releaseClass: "MAINTENANCE_REQUIRED", mainRef: main });
      const confirmed = await this.refreshMainTip();
      if (confirmed !== main) throw refusal(`origin/main changed from ${main} to ${confirmed}`);
      if (candidate.sha !== main || candidate.id !== main) throw refusal(`${candidate.sha} is not main's tip ${main}`);
      if (candidateDigest(candidate) !== candidateDigest(expected)) throw refusal(`${candidate.sha} does not re-derive from its commit`);

      // Forward only: a successor of what the session deploys now.
      if (candidate.sha === current.targetSha) throw refusal(`${candidate.sha} is the current target`);
      if (!await this.tree.isAncestor(current.targetSha, candidate.sha)) {
        throw refusal(`${current.targetSha} is not an ancestor of ${candidate.sha}`);
      }

      // The runner deploying it is it: same commit, same tree, nothing edited.
      const runner = await this.installedRunner(candidate.sha);
      if (runner.sha !== candidate.sha) throw refusal(`installed runner is ${runner.sha}`);
      if (runner.tree !== runner.candidateTree) throw refusal(`installed runner tree ${runner.tree} != ${runner.candidateTree}`);
      if (!runner.clean) throw refusal("installed runner worktree is not clean");

      // The real-router certification E2E is part of `test`, so this is what
      // makes it a gate rather than a convention.
      return { ciEvidence: await this.ci.attest(candidate.sha) };
    } catch (error) {
      if (error instanceof ForwardAdmissionError) throw error;
      // Git and transport errors can carry credentialed URLs; only stable codes leave.
      throw refusal(error instanceof CandidateStoreError ? error.code : "admission evidence unreadable");
    }
  }
}

/** The checks a candidate's own commit must have passed. */
export const REQUIRED_CHECKS = ["test", "docker-build"] as const;

type CheckRun = { name?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown; id?: unknown; completed_at?: unknown };

/**
 * GitHub's check runs for exactly this commit, not for anything it descends
 * from: a green ancestor is a different claim about a different tree.
 *
 * Every run of each required check must have completed with `success`, and
 * there must be at least one. Unreadable, pending, missing, failed or
 * mismatched all refuse - an attestation that cannot be read is not one.
 */
export class GitHubCheckRunsAttestation implements CiAttestation {
  constructor(private readonly options: {
    readonly repository: string;
    /** Optional: the repository is public. Read per call, never held or logged. */
    readonly tokenFile?: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
    /** Bounded: the read happens while the runner lock and the session lease are held. */
    readonly timeoutMs?: number;
  }) {}

  async attest(sha: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.options.repository)) throw refusal("CI repository is not owner/name");
    if (!/^[a-f0-9]{40}$/.test(sha)) throw refusal("CI attestation needs an exact commit");
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.options.tokenFile) {
      const token = readFileSync(this.options.tokenFile, "utf8").trim();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let body: { total_count?: unknown; check_runs?: unknown };
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(
        `https://api.github.com/repos/${this.options.repository}/commits/${sha}/check-runs?per_page=100`,
        { headers, signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json() as typeof body;
    } catch (error) {
      throw refusal(`CI attestation unreadable (${error instanceof Error ? error.message.slice(0, 40) : "unknown"})`);
    }
    const runs = Array.isArray(body.check_runs) ? body.check_runs as CheckRun[] : [];
    // "Every run of a required check succeeded" is a claim about all of them.
    // A second page this read did not fetch could hold a failed one.
    if (typeof body.total_count !== "number" || body.total_count > runs.length) {
      throw refusal(`CI_ATTESTATION_INCOMPLETE: ${String(body.total_count)} check runs, ${runs.length} read`);
    }
    const evidence: { name: string; id: unknown; conclusion: unknown; completed_at: unknown }[] = [];
    for (const name of REQUIRED_CHECKS) {
      const named = runs.filter((run) => run.name === name);
      if (!named.length) throw refusal(`CI check ${name} missing for ${sha}`);
      for (const run of named) {
        if (run.head_sha !== sha) throw refusal(`CI check ${name} is for ${String(run.head_sha)}`);
        if (run.status !== "completed" || run.conclusion !== "success") {
          throw refusal(`CI check ${name} is ${String(run.status)}/${String(run.conclusion)}`);
        }
        evidence.push({ name, id: run.id, conclusion: run.conclusion, completed_at: run.completed_at });
      }
    }
    return JSON.stringify({ sha, repository: this.options.repository, observed_at: (this.options.now?.() ?? new Date()).toISOString(), checks: evidence });
  }
}
