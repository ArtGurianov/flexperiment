import { deployMode, readinessExpectation, type ReleaseCandidate, type ReleaseCandidateReader } from "./candidate";
import { evaluateReadiness, type ReleaseReadinessEvidence } from "./readiness";
import {
  DeploySessions, planResume, runtimeIsTarget, snapshotEquals,
  type DeploySession, type DeploymentObservation, type PreDeploySnapshot, type ResumePlan,
} from "./deploy-session";
import type { CertificationCapability } from "../certification/capability";
import { converge, SINGLE_OBSERVATION, type ConvergencePolicy } from "./convergence";
import { isTransientTopologyRead, TopologyReadError } from "./topology-reader";

/**
 * The production release contract, expressed once and proved against test
 * adapters. It owns ordering only: what must be true before the next step is
 * allowed, and what a failure at each step means. Everything that touches the
 * outside world - the database, Coolify, the provider - is a port.
 *
 * P9 supplies the durable implementations. Until then the CLI refuses to run
 * against production rather than substituting a mock, so this ordering cannot
 * be mistaken for a working deploy path.
 */

/** Reads the SHA each production surface is actually serving. */
export interface TopologyReader {
  observe(): Promise<DeploymentObservation>;
}

/** Reads the evidence readiness judges: both runtimes, the schema, the legal release. */
export interface RuntimeEvidenceReader {
  read(): Promise<ReleaseReadinessEvidence>;
}

/** Hands the target revision to whatever actually deploys it. */
export interface DeploymentDriver {
  /** Proves the predecessor can be restored before this deployment starts. */
  assertRecoverable(predecessorSha: string): Promise<void>;
  /**
   * Re-proves, after target convergence and before arming, that what a
   * rollback would restore is still there: the predecessor commit.
   */
  assertRecoverySourceAvailable(predecessorSha: string): Promise<void>;
  deploy(targetSha: string): Promise<void>;
}

/**
 * The two halves of certification, and they are deliberately not one call.
 *
 * Issuing a capability and creating a run are internal durable facts: nothing
 * has left the system, and the old lineage is still a truthful destination. The
 * external effect begins at the payment page, which is why arming sits between
 * them and not before both.
 */
export interface CertificationDriver {
  issueCapability(sessionId: string): Promise<CertificationCapability>;
  /**
   * Everything checkable without changing anything outside the system: the
   * capability is recoverable, the operator is present, the run agrees with the
   * release, the target runtime answers. It must not mutate, because it runs
   * while a rollback is still legal.
   */
  preflight(capability: CertificationCapability): Promise<void>;
  certify(capability: CertificationCapability): Promise<void>;
}


/**
 * Undoing a same-lineage deploy is not deploying one SHA: it restores a vector,
 * each surface to whatever it was actually serving, which need not have been
 * the same commit. No database is involved: a release never replaces it.
 */
export interface RecoveryDriver {
  restorePreDeployTopology(snapshot: PreDeploySnapshot): Promise<void>;
}

export type ReleasePorts = {
  readonly sessions: DeploySessions;
  /** What production is serving now. */
  readonly topology: TopologyReader;
  readonly evidence: RuntimeEvidenceReader;
  readonly deployment: DeploymentDriver;
  readonly certification?: CertificationDriver;
  readonly recovery?: RecoveryDriver;
  readonly candidates?: ReleaseCandidateReader;
  readonly clock?: () => Date;
  /**
   * How long target topology and readiness may take to become observable after
   * the deployment driver returns. Absent means one look, which is right for a
   * port double whose answers are already final; the production root supplies
   * a real deadline. See `convergence.ts`.
   */
  readonly convergence?: ConvergencePolicy;
};

export type ReleaseRequest = {
  readonly ownerId: string;
  /** Carries the commit, the release class and the expectation as one fact. */
  readonly candidate: ReleaseCandidate;
  readonly sessionId?: string;
};

export type ReleaseOutcome =
  | { readonly kind: "SUCCEEDED"; readonly session: DeploySession }
  /**
   * Converged, admitted, and holding a capability nobody has spent. The fence
   * is still shut, the old lineage is still a legal destination, and the next
   * step needs a person. It is not a success and not a failure - it is a
   * handoff, and a caller that read it as either would be wrong in a way that
   * costs either an open shop or an unnecessary rollback.
   */
  | { readonly kind: "AWAITING_OPERATOR"; readonly session: DeploySession; readonly capability: CertificationCapability }
  | { readonly kind: "SAFE_ABORTED"; readonly session: DeploySession; readonly code: string }
  | { readonly kind: "ROLLED_BACK"; readonly session: DeploySession; readonly code: string }
  | { readonly kind: "RECOVERY_REQUIRED"; readonly session: DeploySession; readonly code: string };

export class ReleaseOrchestrationError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const failureCode = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "UNKNOWN_DEPLOY_FAILURE";

export class ReleaseOrchestrator {
  private readonly clock: () => Date;
  private readonly convergence: ConvergencePolicy;

  constructor(private readonly ports: ReleasePorts) {
    this.clock = ports.clock ?? (() => new Date());
    this.convergence = ports.convergence ?? SINGLE_OBSERVATION;
  }

  /**
   * A rolling release crosses no external boundary: sales stay open, nothing is
   * armed, and convergence plus readiness is the whole contract. It is only
   * legal for a revision whose schema the previous one can still read.
   */
  async runRolling(request: ReleaseRequest): Promise<ReleaseOutcome> {
    if (deployMode(request.candidate) !== "ROLLING_SAFE") throw new ReleaseOrchestrationError("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    const { sessions } = this.ports;
    const before = await this.ports.topology.observe();
    const session = sessions.acquireRolling({
      id: request.sessionId, ownerId: request.ownerId, mode: "ROLLING_SAFE",
      targetSha: request.candidate.sha, candidateId: request.candidate.id,
    }, before);

    try {
      await this.ports.deployment.deploy(request.candidate.sha);
    } catch (error) {
      return this.classify(session.id, request.ownerId, failureCode(error));
    }

    return this.finishRolling(session.id, request);
  }

  /** Everything a rolling release does once its deployment has been handed over. */
  private async finishRolling(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome> {
    const converged = await this.requireTargetTopology(sessionId, request);
    if ("kind" in converged) return converged;
    const admitted = await this.requireReadiness(sessionId, request);
    if (admitted) return admitted;
    return { kind: "SUCCEEDED", session: this.ports.sessions.completeTarget(sessionId, request.ownerId, converged.topology) };
  }

  /**
   * The destructive path. The ordering below is the contract: the fence closes
   * before anything is deployed, the irreversible boundary is armed only once
   * the exact target topology is proved and readiness has admitted it, and the
   * certification capability does not exist until after that arming.
   */
  async runMaintenanceCutover(request: ReleaseRequest): Promise<ReleaseOutcome> {
    if (deployMode(request.candidate) !== "MAINTENANCE_CUTOVER") throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_MAINTENANCE_CUTOVER");
    if (!this.ports.certification) throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_CERTIFICATION_DRIVER");
    const { sessions } = this.ports;
    // Captured before the gate closes and before anything is deployed, so a
    // failure can be judged against what production was actually serving. The
    // session, that snapshot and the closed gate are created together, and
    // recoverability is proved against the snapshot before any of them exist.
    const before = await this.ports.topology.observe();
    await this.ports.deployment.assertRecoverable(uniformSha(before));
    const session = sessions.acquireFenced({
      id: request.sessionId, ownerId: request.ownerId, mode: "MAINTENANCE_CUTOVER",
      targetSha: request.candidate.sha, candidateId: request.candidate.id,
    }, before);
    // From here a session exists, so every exit below is a decision about that
    // session. An exception escaping to the CLI would be reported as exit 20 -
    // "refused before mutation" - which after this point is a lie: the pointer
    // may have moved and the applications may be deployed. Anything unexpected
    // is RECOVERY_REQUIRED instead.
    try {
      sessions.beginDeploying(session.id, request.ownerId);
      try {
        await this.ports.deployment.deploy(request.candidate.sha);
      } catch (error) {
        return this.classify(session.id, request.ownerId, failureCode(error));
      }
      return await this.finishCutover(session.id, request);
    } catch (error) {
      return this.recovery(session.id, request.ownerId, failureCode(error));
    }
  }

  /**
   * Everything a cutover does once its deployment has been handed over, from
   * proving convergence through certification to settling. Shared so a resumed
   * session finishes through the same ordering rather than a copy of it.
   */
  private async finishCutover(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome> {
    if (!this.ports.certification) throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_CERTIFICATION_DRIVER");
    const converged = await this.requireTargetTopology(sessionId, request);
    if ("kind" in converged) return converged;
    const session = this.ports.sessions.read(sessionId);
    if (!session?.preDeployTopology) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    try {
      await this.ports.deployment.assertRecoverySourceAvailable(uniformSha(session.preDeployTopology));
    } catch (error) {
      return this.recovery(sessionId, request.ownerId, `RECOVERY_SOURCE_RECHECK_FAILED:${failureCode(error)}`);
    }
    const admitted = await this.requireReadiness(sessionId, request);
    if (admitted) return admitted;

    // Issued, not spent. A capability and a run are records this system keeps
    // about itself; nothing has left it, so the archived database is still a
    // truthful account of what happened and a rollback is still legal. Arming
    // here would burn that for a step the operator may never start.
    let capability: CertificationCapability;
    try {
      capability = await this.ports.certification.issueCapability(sessionId);
    } catch (error) {
      // Still before any external effect, so this is an ordinary failure and
      // the session keeps every exit it had.
      return this.recovery(sessionId, request.ownerId, `CERTIFICATION_NOT_ISSUED:${failureCode(error)}`);
    }
    return { kind: "AWAITING_OPERATOR", session: this.ports.sessions.read(sessionId)!, capability };
  }

  /**
   * Finishes a forward revision once its release has been deployed.
   *
   * The same ordering as any cutover, because it is one: convergence to the
   * revision's release, readiness for its candidate, and a capability issued
   * for its own certification run. The session stays RECOVERY_REQUIRED and
   * fenced throughout; only `certify` settles it. A failure anywhere here is
   * recovery, never a pre-mutation refusal - the pointer has moved.
   */
  async finishForward(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome> {
    const binding = this.ports.sessions.binding(sessionId);
    if (binding.revision === 0 || binding.targetSha !== request.candidate.sha || binding.candidateId !== request.candidate.id) {
      throw new ReleaseOrchestrationError("FORWARD_CANDIDATE_NOT_CURRENT_BINDING", `${request.candidate.id} != ${binding.candidateId ?? binding.targetSha}`);
    }
    try {
      this.ports.sessions.holdLease(sessionId, request.ownerId);
      return await this.finishCutover(sessionId, request);
    } catch (error) {
      return this.recovery(sessionId, request.ownerId, failureCode(error));
    }
  }

  /**
   * The attended half: arm, certify, prove convergence again, settle.
   *
   * Arming is the first thing, immediately before the capability can be spent
   * on a real payment - that is the point of no return, and it is reached only
   * because a person decided to start. Everything after it is forward-only.
   */
  async certifyAndComplete(sessionId: string, request: ReleaseRequest, capability: CertificationCapability): Promise<ReleaseOutcome> {
    if (!this.ports.certification) throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_CERTIFICATION_DRIVER");
    // Certified only as the release the session is deploying now. A caller
    // naming another candidate would certify one release under another's
    // expectation. Refused before preflight, so nothing has been touched.
    const binding = this.ports.sessions.binding(sessionId);
    if (binding.targetSha !== request.candidate.sha || binding.candidateId !== request.candidate.id) {
      throw new ReleaseOrchestrationError("CERTIFY_CANDIDATE_NOT_CURRENT_BINDING", `${request.candidate.id} != ${binding.candidateId ?? binding.targetSha}`);
    }

    // Read-only, and deliberately before the arming below. An unreachable
    // runtime, a lost capability, a catalogue that is not ready or an
    // unattended terminal are ordinary refusals, and they stay ordinary: arming
    // first would spend the release's last reversible step on a precondition
    // and leave a cutover that can neither be rolled back nor certified.
    try {
      await this.ports.certification.preflight(capability);
    } catch (error) {
      return this.recovery(sessionId, request.ownerId, `CERTIFICATION_PREFLIGHT_FAILED:${failureCode(error)}`);
    }

    // ---- last reversible point -------------------------------------------
    // Immediately before the first request that can create a real payment.
    try {
      // Preflight includes a terminal the operator may take their time over, so
      // the lease that arming needs may already have lapsed by now.
      this.ports.sessions.holdLease(sessionId, request.ownerId);
      this.ports.sessions.armExternalEffects(sessionId, request.ownerId);
    } catch (error) {
      // A session, a deployed successor, a capability and a closed gate all
      // already exist, so this cannot be reported as a pre-mutation refusal -
      // the same semantics the deploy side already carries. Recovery itself
      // needs the session, so if that is what failed, say so without pretending
      // to have transitioned anything.
      const code = `CERTIFICATION_NOT_ARMED:${failureCode(error)}`;
      try {
        return this.recovery(sessionId, request.ownerId, code);
      } catch {
        const session = this.ports.sessions.read(sessionId);
        if (!session) throw error;
        return { kind: "RECOVERY_REQUIRED", session, code };
      }
    }
    // ----------------------------------------------------------------------

    try {
      await this.ports.certification.certify(capability);
    } catch (error) {
      // Past the boundary there is no safe abort and no rollback: the archived
      // database can no longer account for what may already have happened.
      // Recovery needs the lease too, and certification has just spent longer
      // than one - so reclaim it before trying to record anything.
      this.ports.sessions.holdLease(sessionId, request.ownerId);
      return this.recovery(sessionId, request.ownerId, `CERTIFICATION_FAILED:${failureCode(error)}`);
    }

    // Certification takes as long as a real payment and refund take, and a
    // surface can drift underneath it. The observation that closes the release
    // has to be the one taken after that, never the pre-arming snapshot - and
    // the lease it is recorded under has to be one that survived the wait.
    this.ports.sessions.holdLease(sessionId, request.ownerId);
    const final = await this.requireTargetTopology(sessionId, request);
    if ("kind" in final) return final;

    // completeTarget settles the session and reopens the gate in one operation.
    return { kind: "SUCCEEDED", session: this.ports.sessions.completeTarget(sessionId, request.ownerId, final.topology) };
  }

  /**
   * Picks up a session whose runner died.
   *
   * Taking over is allowed only once the lease has actually expired - a live
   * owner is a live deploy, and stealing it would put two runners on one
   * production topology. The takeover itself moves ownership and nothing else:
   * the gate stays exactly as the dead runner left it, and no state is settled
   * on the strength of a clock.
   *
   * What may happen next comes from a fresh reading of production. A partial
   * topology is recorded durably as RECOVERY_REQUIRED before the caller is told
   * anything, so the next crash finds the conclusion already written down.
   */
  async resume(sessionId: string, ownerId: string): Promise<{ session: DeploySession; plan: ResumePlan }> {
    const taken = this.ports.sessions.takeOverExpiredLease(sessionId, ownerId);
    // A runner can die between closing the gate and starting the deploy, which
    // leaves FENCED - a perfectly ordinary crash point that the observation path
    // does not accept. Advancing it first matches the live flow, where DEPLOYING
    // is set before the deployment driver is ever called.
    if (taken.state === "FENCED") this.ports.sessions.beginDeploying(sessionId, ownerId);
    // A runtime that cannot be observed is frequently the reason a session
    // needs resuming, so requiring a successful observation to produce a
    // recovery plan is circular. It is reported as RECOVERY_REQUIRED, never as
    // a safe abort: absence of observation is not evidence of anything.
    let observed: DeploymentObservation;
    try {
      observed = await this.ports.topology.observe();
    } catch (error) {
      return {
        session: this.ports.sessions.enterRecoveryRequired(sessionId, ownerId),
        plan: { kind: "FIX_FORWARD_OR_ROLLBACK", reason: `TOPOLOGY_UNOBSERVABLE:${failureCode(error)}` } as ResumePlan,
      };
    }
    const session = this.ports.sessions.observeTopology(sessionId, ownerId, observed);
    const plan = planResume(session, observed);
    if (plan.kind === "FIX_FORWARD_OR_ROLLBACK" && session.state !== "RECOVERY_REQUIRED") {
      return { session: this.ports.sessions.enterRecoveryRequired(sessionId, ownerId), plan };
    }
    return { session, plan };
  }

  /**
   * Puts production back where it was and reopens sales - for a same-lineage
   * deploy only.
   *
   * It settles the session in the very database it is rolling back within, so
   * it is valid precisely while that database survives the operation. The
   * launch session, which adopted a prepared cutover, is refused outright and
   * before anything is observed: reversing it would mean restoring the
   * pre-launch database, and the machinery that could do that was retired.
   *
   * Legal only while the old lineage is still a truthful account of what
   * happened. The driver's return is not taken as proof: the restored topology
   * is read back and must match the recorded vector exactly, and only then do
   * the terminal state and the gate move together.
   */
  async rollback(sessionId: string, ownerId: string): Promise<ReleaseOutcome> {
    if (!this.ports.recovery) throw new ReleaseOrchestrationError("ROLLBACK_REQUIRES_RECOVERY_DRIVER");
    if (this.ports.sessions.read(sessionId)?.launch) throw new ReleaseOrchestrationError("LAUNCH_SESSION_NOT_ROLLBACKABLE");
    // Recorded when it can be read. A target that does not come up is the
    // usual reason to roll back, so an unobservable runtime must not be what
    // stops the rollback: ownership is then proved through the lease alone.
    let observed: DeploymentObservation | undefined;
    try {
      observed = await this.ports.topology.observe();
    } catch (error) {
      if (!(error instanceof TopologyReadError)) throw error;
    }
    const session = observed
      ? this.ports.sessions.observeTopology(sessionId, ownerId, observed)
      : this.ports.sessions.holdLease(sessionId, ownerId);
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new ReleaseOrchestrationError("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    const before = session.preDeployTopology;

    // Three sequential Coolify redeploys and a convergence wait can each take
    // minutes; the lease is five. No write after one of them may depend on the
    // lease granted before it, so the lease is re-held after the restore,
    // before every poll, and before every settling write. This process holds
    // the runner lock throughout, which is what makes reclaiming its own lapsed
    // lease safe (`holdLease`), exactly as the target wait does.
    const hold = () => this.ports.sessions.holdLease(sessionId, ownerId);
    try {
      await this.ports.recovery.restorePreDeployTopology(before);
    } catch (error) {
      hold();
      return this.recovery(sessionId, ownerId, `ROLLBACK_FAILED:${failureCode(error)}`);
    }

    // The predecessor comes back asynchronously, like any deploy: waited on,
    // boundedly. From here the pointer has moved, so anything short of the
    // exact recorded vector is recovery - never an exception a caller would
    // read as "refused before mutation".
    let restored: DeploymentObservation;
    try {
      restored = await converge(this.convergence, async () => {
        hold();
        return this.ports.topology.observe();
      }, (observation) => snapshotEquals(observation, before), isTransientTopologyRead);
    } catch (error) {
      hold();
      return this.recovery(sessionId, ownerId, `ROLLBACK_NOT_CONVERGED:${failureCode(error)}`);
    }
    hold();
    if (!snapshotEquals(restored, before)) return this.recovery(sessionId, ownerId, "ROLLBACK_NOT_CONVERGED");
    // completeRollback insists on the exact vector itself and settles the
    // session and the gate in one operation.
    return { kind: "ROLLED_BACK", session: this.ports.sessions.completeRollback(sessionId, ownerId, restored), code: "ROLLED_BACK" };
  }

  /**
   * Carries a taken-over session forward without acquiring anything.
   *
   * The caller says which plan it believes it is continuing, and this re-derives
   * that plan from a fresh reading before acting on it. A plan is a statement
   * about production at the moment it was made, and minutes pass between a
   * recovery workflow reading one and acting on it; treating it as still true
   * is how a deploy gets re-fired over a topology that moved. A caller that is
   * out of date is told so rather than obeyed.
   *
   * Without this, a recovery workflow has no way to finish a session except to
   * reproduce the orchestrator's private ordering by hand - which is the thing
   * this whole contract exists to stop.
   */
  async continueSession(sessionId: string, ownerId: string, expected: ResumePlan["kind"]): Promise<ReleaseOutcome> {
    if (!this.ports.candidates) throw new ReleaseOrchestrationError("CONTINUATION_REQUIRES_CANDIDATE_READER");

    // The release's identity is read back from the session, never restated, and
    // it is settled before anything is observed or recorded. A caller that could
    // name the commit and the expectation again could continue one release as
    // another; a session whose candidate no longer agrees with its target is not
    // a session worth taking one more step of.
    const known = this.ports.sessions.read(sessionId);
    if (!known) throw new ReleaseOrchestrationError("DEPLOY_SESSION_NOT_FOUND", sessionId);
    // The current binding, never the frozen original: a session carried
    // forward continues the release it was carried to.
    const binding = this.ports.sessions.binding(sessionId);
    if (!binding.candidateId) throw new ReleaseOrchestrationError("SESSION_HAS_NO_CANDIDATE", sessionId);
    const candidate = this.ports.candidates.get(binding.candidateId);
    if (!candidate) throw new ReleaseOrchestrationError("CANDIDATE_NOT_FOUND", binding.candidateId);
    if (candidate.sha !== binding.targetSha) throw new ReleaseOrchestrationError("CANDIDATE_SESSION_MISMATCH", binding.candidateId);

    const observed = await this.ports.topology.observe();
    const session = this.ports.sessions.observeTopology(sessionId, ownerId, observed);
    const plan = planResume(session, observed);
    if (plan.kind !== expected) throw new ReleaseOrchestrationError(`RESUME_PLAN_STALE:${plan.kind}`);
    // Only the two plans with one obvious next step are continued. Choosing
    // between rollback and fix-forward is a person's; and an armed session goes
    // forward only by `forward-deploy` - finishing it again here would issue a
    // second capability for a run that already started.
    if (plan.kind === "FIX_FORWARD_OR_ROLLBACK" || plan.kind === "FIX_FORWARD_ONLY") {
      throw new ReleaseOrchestrationError("FIX_FORWARD_DIRECTION_REQUIRED");
    }

    const full: ReleaseRequest = { ownerId, candidate, sessionId };
    if (plan.kind === "RETRY_DEPLOY") {
      try {
        if (session.mode === "MAINTENANCE_CUTOVER") {
          if (!session.preDeployTopology) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_REQUIRED");
          await this.ports.deployment.assertRecoverable(uniformSha(session.preDeployTopology));
        }
        await this.ports.deployment.deploy(binding.targetSha);
      } catch (error) {
        // Coolify can take longer than the lease; the classification after it
        // must not depend on the lease granted before it.
        this.ports.sessions.holdLease(sessionId, ownerId);
        return this.classify(sessionId, ownerId, failureCode(error));
      }
      this.ports.sessions.holdLease(sessionId, ownerId);
    }
    return session.mode === "MAINTENANCE_CUTOVER" ? this.finishCutover(sessionId, full) : this.finishRolling(sessionId, full);
  }

  /** Convergence is proved by a fresh observation, never by the snapshot taken earlier. */
  private async requireTargetTopology(
    sessionId: string,
    request: ReleaseRequest,
  ): Promise<{ topology: DeploymentObservation } | ReleaseOutcome> {
    // Every look is recorded, so the session's monotonic mutation bit latches on
    // the first surface that moved rather than on whichever look happened last.
    // The lease is held across the wait: the deploy before it can already have
    // consumed most of one, and this process owns the runner lock throughout,
    // which is what makes reclaiming its own lapsed lease safe (`holdLease`).
    const topology = await converge(this.convergence, async () => {
      this.ports.sessions.holdLease(sessionId, request.ownerId);
      const observed = await this.ports.topology.observe();
      this.ports.sessions.observeTopology(sessionId, request.ownerId, observed);
      return observed;
    }, (observed) => runtimeIsTarget(observed.runtime, request.candidate.sha), isTransientTopologyRead);
    if (runtimeIsTarget(topology.runtime, request.candidate.sha)) return { topology };
    return this.classify(sessionId, request.ownerId, "TARGET_TOPOLOGY_NOT_CONVERGED");
  }

  /**
   * ADMITTED is the only answer that may precede arming. PENDING is not "close enough".
   *
   * But PENDING is waited on: it is readiness's own word for "not there yet" -
   * a worker whose first sweep is still running, a heartbeat about to land -
   * and it resolves as the deploy proceeds. REJECTED never does and ends the
   * wait at once.
   */
  private async requireReadiness(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome | undefined> {
    const readiness = await converge(this.convergence, async () => {
      this.ports.sessions.holdLease(sessionId, request.ownerId);
      return evaluateReadiness(readinessExpectation(request.candidate), await this.ports.evidence.read(), this.clock());
    }, (result) => result.state !== "PENDING");
    if (readiness.state === "ADMITTED") return undefined;
    return this.classify(sessionId, request.ownerId, `READINESS_${readiness.state}:${readiness.code}`);
  }

  /**
   * One classifier for every failure. It asks the session, not the caller,
   * whether production was ever touched - so a deploy that never moved a
   * surface ends open, and one that did keeps sales closed until a human
   * finishes or reverses it.
   */
  private async classify(sessionId: string, ownerId: string, code: string): Promise<ReleaseOutcome> {
    const observed = await this.ports.topology.observe();
    const session = this.ports.sessions.classifyFailure(sessionId, ownerId, observed);
    // classifyFailure settles and releases the gate together when it aborts,
    // and a rolling session never had the gate to release.
    if (session.state === "SAFE_ABORTED") return { kind: "SAFE_ABORTED", session, code };
    return this.handBack(session, ownerId, code);
  }

  private recovery(sessionId: string, ownerId: string, code: string): ReleaseOutcome {
    return this.handBack(this.ports.sessions.enterRecoveryRequired(sessionId, ownerId), ownerId, code);
  }

  /**
   * Handing a session back to an operator, from wherever that decision is made.
   *
   * Standing down belongs to the act of handing back, not to one code path.
   * It lived only in `recovery()`, so a convergence or readiness failure - both
   * of which arrive through `classify()` - left a live lease behind and the
   * next rollback had to wait out a term its holder had already finished with,
   * production fenced throughout. A crash still falls back to expiry, and a
   * live holder is still never displaced.
   */
  private handBack(session: DeploySession, ownerId: string, code: string): ReleaseOutcome {
    this.ports.sessions.yieldLease(session.id, ownerId);
    return { kind: "RECOVERY_REQUIRED", session, code };
  }
}

/** A shared deploy pointer can restore only one predecessor revision. */
const uniformSha = (topology: DeploymentObservation | PreDeploySnapshot): string => {
  const values = Object.values(topology.runtime);
  if (!values.length || new Set(values).size !== 1) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_NOT_UNIFORM");
  return values[0]!;
};
