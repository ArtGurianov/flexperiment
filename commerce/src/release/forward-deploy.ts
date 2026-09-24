import type { ReleaseCandidate, ReleaseCandidateReader } from "./candidate";
import type { DeploySessions, DeploymentGateView } from "./deploy-session";
import { runtimeIsTarget, type DeploymentObservation } from "./deploy-session";
import type { ForwardTarget } from "./forward-target";
import type { ReleaseBinding } from "./forward-target";
import type { ReleaseOutcome, ReleaseRequest } from "./orchestrator";

/**
 * `forward-deploy <session> <candidate>`: carrying an armed, stuck cutover
 * session forward to a newer release. See docs/release/FORWARD_SUPERSESSION.md.
 *
 * Two modes, decided from durable state and never from arguments:
 *
 *   NEW revision - the candidate is not the session's latest revision.
 *     admission (session, main tip, re-derivation, ancestry, installed runner,
 *     exact-SHA CI) → prior target safe to supersede → no blocking live
 *     capability → the candidate's migrations → the owner/lease-guarded
 *     append, which is the target commitment → then as RESUME.
 *
 *   RESUME revision N - the candidate IS the latest revision.
 *     No admission: the recorded binding and its CI evidence are the authority,
 *     and main moving on must not strand a revision already committed.
 *     pointer at from → CAS from→target, deploy; at target → deploy unless the
 *     runtime already serves it; anywhere else → FORWARD_DEPLOY_REF_DIVERGED.
 *     Then convergence, readiness and the revision's own capability, or - if
 *     its certification run already exists - nothing to do but hand over.
 *
 * Refusals before the first durable write are thrown (exit 20). Anything after
 * it is reported as RECOVERY_REQUIRED: the migrations have run or the pointer
 * has moved, and calling that "refused before mutation" would be a lie.
 */

export type ForwardDeployPorts = {
  readonly sessions: DeploySessions;
  readonly gate: () => DeploymentGateView;
  readonly candidates: ReleaseCandidateReader;
  readonly admission: { admit(candidate: ReleaseCandidate, current: ReleaseBinding): Promise<{ readonly ciEvidence: string }> };
  /** Why the current target's certification may not be left behind, or undefined. */
  readonly supersessionDefect: (sessionId: string, releaseSha: string) => string | undefined;
  /** A live unspent capability that would block the new revision's own, or undefined. */
  readonly liveCapability: (sessionId: string) => string | undefined;
  /** Applies the candidate's own predeploy-compatible migrations. Idempotent. */
  readonly migrate: () => void;
  /**
   * Migrations applied to the live database that the candidate does not ship.
   * After a crash between migration and revision, a later candidate may be
   * chosen only if it carries every migration already applied.
   */
  readonly unknownMigrations: () => readonly string[];
  readonly refs: { read(): Promise<string> };
  readonly deployment: {
    deployFrom(expectedSha: string, targetSha: string): Promise<void>;
    redeployAt(sha: string): Promise<void>;
  };
  readonly topology: { observe(): Promise<DeploymentObservation> };
  /** Whether the revision's certification run already exists: certify owns it from then on. */
  readonly revisionRunExists: (sessionId: string, revision: number) => boolean;
  readonly finishForward: (sessionId: string, request: ReleaseRequest) => Promise<ReleaseOutcome>;
  readonly journal: { record(event: string, details: Record<string, unknown>): void };
};

export class ForwardDeployError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type ForwardDeployOutcome =
  | ReleaseOutcome
  /** Revision N's certification run already exists; `certify` owns the session. */
  | { readonly kind: "ALREADY_AWAITING_OPERATOR"; readonly session: NonNullable<ReturnType<DeploySessions["read"]>>; readonly revision: number };

export class ForwardDeploy {
  constructor(private readonly ports: ForwardDeployPorts) {}

  async run(sessionId: string, candidateId: string, ownerId: string): Promise<ForwardDeployOutcome> {
    const { sessions } = this.ports;
    const session = sessions.read(sessionId);
    if (!session) throw new ForwardDeployError("DEPLOY_SESSION_NOT_FOUND", sessionId);
    if (session.mode !== "MAINTENANCE_CUTOVER" || session.state !== "RECOVERY_REQUIRED" || session.rollbackAuthority !== "NEW_LINEAGE_ONLY") {
      throw new ForwardDeployError("FORWARD_DEPLOY_SESSION_NOT_SUPERSEDABLE", `${session.mode}/${session.state}/${session.rollbackAuthority}`);
    }
    if (this.ports.gate().deploymentSessionId !== sessionId) throw new ForwardDeployError("FORWARD_DEPLOY_SESSION_NOT_SUPERSEDABLE", "gate not owned");
    if (session.bootstrapRollbackId) throw new ForwardDeployError("FORWARD_DEPLOY_SESSION_NOT_SUPERSEDABLE", "rollback reserved");

    // Claimed before anything is decided: a live holder is refused, never taken.
    if (session.ownerId !== ownerId) {
      try {
        sessions.takeOverExpiredLease(sessionId, ownerId);
      } catch (error) {
        throw new ForwardDeployError("DEPLOY_SESSION_HELD_BY_ANOTHER_RUNNER", `${session.ownerId} (${error instanceof Error ? error.message : "unknown"})`);
      }
    } else {
      sessions.holdLease(sessionId, ownerId);
    }

    const latest = sessions.forwardTargets(sessionId).at(-1);
    if (latest && latest.candidateId === candidateId) return this.resume(sessionId, latest, ownerId);

    // An ordinary refusal here is exit 20: nothing changed. It must not leave a
    // five-minute lease behind a process that is about to exit, with sales
    // fenced and the next command made to wait it out. Only this region: after
    // the first durable write, failures are RECOVERY_REQUIRED, whose outcome
    // path already stands down.
    let admitted: { candidate: ReleaseCandidate; ciEvidence: string };
    try {
      admitted = await this.admitRevision(sessionId, candidateId);
    } catch (error) {
      sessions.yieldLease(sessionId, ownerId);
      throw error;
    }
    let revision: ForwardTarget;
    try {
      revision = this.commitRevision(sessionId, admitted, ownerId);
    } catch (error) {
      // Migrations may already have run: not a pre-mutation refusal any more.
      return this.recovery(sessionId, ownerId, `FORWARD_DEPLOY_REVISION_NOT_COMMITTED:${error instanceof Error ? error.message : "unknown"}`);
    }
    return this.resume(sessionId, revision, ownerId);
  }

  /** Everything before the first durable write. Refusals here are thrown. */
  private async admitRevision(sessionId: string, candidateId: string): Promise<{ candidate: ReleaseCandidate; ciEvidence: string }> {
    const { sessions } = this.ports;
    const current = sessions.binding(sessionId);
    const candidate = this.ports.candidates.get(candidateId);
    if (!candidate) throw new ForwardDeployError("RELEASE_CANDIDATE_NOT_PUBLISHED", candidateId);

    const { ciEvidence } = await this.ports.admission.admit(candidate, current);
    const unsafe = this.ports.supersessionDefect(sessionId, current.targetSha);
    if (unsafe) throw new ForwardDeployError("FORWARD_DEPLOY_PRIOR_TARGET_NOT_SAFE", unsafe);
    const blocking = this.ports.liveCapability(sessionId);
    if (blocking) throw new ForwardDeployError("FORWARD_DEPLOY_CAPABILITY_STILL_LIVE", blocking);
    const unknown = this.ports.unknownMigrations();
    if (unknown.length) throw new ForwardDeployError("FORWARD_DEPLOY_MIGRATIONS_NOT_CARRIED", unknown.join(","));
    return { candidate, ciEvidence };
  }

  private commitRevision(sessionId: string, admitted: { candidate: ReleaseCandidate; ciEvidence: string }, ownerId: string): ForwardTarget {
    const { sessions } = this.ports;
    const { candidate, ciEvidence } = admitted;
    // ---- first durable write ----------------------------------------------
    // Migrations before the revision. A crash between them leaves migrations
    // applied and no target committed; the next run re-admits from scratch and
    // re-applies them idempotently. They are predeploy-compatible, so the
    // previous target keeps serving under them.
    this.ports.migrate();
    const recorded = sessions.appendForwardTarget(sessionId, ownerId, { targetSha: candidate.sha, candidateId: candidate.id, ciEvidence });
    this.ports.journal.record("forward-deploy.revision", {
      session: sessionId, revision: recorded.revision, from: recorded.fromSha, target: recorded.targetSha,
    });
    return recorded;
  }

  private async resume(sessionId: string, revision: ForwardTarget, ownerId: string): Promise<ForwardDeployOutcome> {
    const { sessions } = this.ports;
    const candidate = this.ports.candidates.get(revision.candidateId);
    if (!candidate || candidate.sha !== revision.targetSha) {
      return this.recovery(sessionId, ownerId, `FORWARD_DEPLOY_CANDIDATE_UNREADABLE:${revision.candidateId}`);
    }
    if (this.ports.revisionRunExists(sessionId, revision.revision)) {
      const session = sessions.read(sessionId)!;
      return { kind: "ALREADY_AWAITING_OPERATOR", session, revision: revision.revision };
    }

    try {
      const pointer = await this.ports.refs.read();
      if (pointer === revision.fromSha) {
        await this.ports.deployment.deployFrom(revision.fromSha, revision.targetSha);
      } else if (pointer === revision.targetSha) {
        if (!await this.serving(revision.targetSha)) await this.ports.deployment.redeployAt(revision.targetSha);
      } else {
        // Never a CAS from whatever happens to be there.
        return this.recovery(sessionId, ownerId, `FORWARD_DEPLOY_REF_DIVERGED:${pointer}`);
      }
    } catch (error) {
      return this.recovery(sessionId, ownerId, error instanceof Error ? error.message : "FORWARD_DEPLOY_FAILED");
    }

    return this.ports.finishForward(sessionId, { ownerId, candidate, sessionId });
  }

  /** Whether the runtime already serves the revision; an unreadable topology is "not yet". */
  private async serving(sha: string): Promise<boolean> {
    try {
      return runtimeIsTarget((await this.ports.topology.observe()).runtime, sha);
    } catch {
      return false;
    }
  }

  private recovery(sessionId: string, ownerId: string, code: string): ReleaseOutcome {
    this.ports.journal.record("forward-deploy.recovery-required", { session: sessionId, code });
    let session = this.ports.sessions.read(sessionId)!;
    try { session = this.ports.sessions.enterRecoveryRequired(sessionId, ownerId); } catch { /* already RECOVERY_REQUIRED; reported as is */ }
    return { kind: "RECOVERY_REQUIRED", session, code };
  }
}
