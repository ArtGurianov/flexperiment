import { deployMode, readinessExpectation, type ReleaseCandidate, type ReleaseCandidateReader } from "./candidate";
import { evaluateReadiness, type ReleaseReadinessEvidence } from "./readiness";
import {
  DeploySessions, planResume, runtimeIsTarget,
  type DeployMode, type DeploySession, type DeploymentObservation, type PreDeploySnapshot, type ResumePlan,
} from "./deploy-session";
import type { CertificationCapability } from "../certification/capability";

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
  /**
   * Proves the frozen predecessor can survive this deployment before it starts.
   *
   * The phase says which evidence is available. A prepared launch has already
   * stopped its predecessor on purpose, so demanding running containers there
   * is demanding the absence of the thing preparation just did.
   */
  assertRecoverable(predecessorSha: string, phase?: "RUNNING" | "PREPARED_STOPPED"): Promise<void>;
  /** Re-proves predecessor images after target convergence and before arming. */
  assertPredecessorRetained(predecessorSha: string): Promise<void>;
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
 * the same commit. No database is involved - that only happens across a lineage
 * boundary, and that case belongs to BootstrapRollback, which can prove the
 * archive it restored. Keeping the two apart is what stops this driver from
 * being both the actor and the only witness.
 */
export interface RecoveryDriver {
  restorePreDeployTopology(snapshot: PreDeploySnapshot): Promise<void>;
}

/**
 * The successor half of the launch handoff.
 *
 * `prepare-bootstrap` leaves two durable facts behind: an envelope on the
 * filesystem, and a fresh launch database standing where the predecessor used
 * to be. From that moment the predecessor reader has nothing left to read, so
 * a launch deploy cannot re-derive its own pre-deploy snapshot - it adopts the
 * one the envelope froze before the database was replaced.
 *
 * Reading the envelope and adopting it are separate members for the same
 * reason the handoff itself is ordered: recoverability is proved against the
 * frozen snapshot BEFORE a session and a closed gate exist to be cleaned up.
 */
export interface CutoverAdoptionPort {
  /** The frozen snapshot, read without mutating anything. */
  preDeployTopology(cutoverId: string): PreDeploySnapshot;
  /**
   * Session, closed gate and adoption identity, committed together.
   *
   * `reconciled` means the database had already committed this handoff. That is
   * not a second deploy's licence to start: the session is the authority from
   * then on, and finishing it is `resume`'s job.
   */
  adopt(cutoverId: string, ownerId: string, candidate: ReleaseCandidate): { session: DeploySession; reconciled: boolean };
}

export type ReleasePorts = {
  readonly sessions: DeploySessions;
  /**
   * What production is, on the lineage this release is converging onto.
   *
   * It cannot answer for the predecessor: the launch schema's evidence table
   * arrives with the baseline, so on the database a cutover starts from this
   * reader throws. See `predecessor` below.
   */
  readonly topology: TopologyReader;
  /**
   * The predecessor, for the two phases that have to read the old lineage: the
   * snapshot a cutover freezes, and the proof a bootstrap rollback restored
   * exactly that.
   *
   * Chosen by phase and never by trying one reader and catching the other's
   * failure. A reader picked by whether a table happens to exist is a
   * compatibility branch that outlives the thing it was for; this one is named
   * at its two call sites and is deleted with the predecessor runbook.
   *
   * Absent for a rolling release, which never crosses a lineage boundary.
   */
  readonly predecessor?: TopologyReader;
  readonly evidence: RuntimeEvidenceReader;
  readonly deployment: DeploymentDriver;
  readonly certification?: CertificationDriver;
  readonly recovery?: RecoveryDriver;
  readonly candidates?: ReleaseCandidateReader;
  /** Present only where a prepared launch envelope can be adopted. */
  readonly cutoverAdoption?: CutoverAdoptionPort;
  readonly clock?: () => Date;
};

export type ReleaseRequest = {
  readonly ownerId: string;
  /** Carries the commit, the release class and the expectation as one fact. */
  readonly candidate: ReleaseCandidate;
  readonly sessionId?: string;
  readonly adoptedCutoverId?: string;
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

  constructor(private readonly ports: ReleasePorts) {
    this.clock = ports.clock ?? (() => new Date());
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
    // session, that snapshot and the closed gate are created together.
    //
    // Read through the predecessor bridge when one is configured: a launch
    // cutover starts on the old lineage, where the canonical reader has no
    // evidence table to read. An ordinary maintenance release on the launch
    // lineage has no predecessor reader and uses the canonical one.
    // A prepared launch cutover has already replaced the database this would
    // otherwise read, so its snapshot comes from the envelope rather than from
    // a predecessor that no longer exists. Both paths prove recoverability
    // against the same frozen vector before any session or gate exists.
    const adoption = request.adoptedCutoverId ? this.adoptionPort() : undefined;
    const before = adoption
      ? adoption.preDeployTopology(request.adoptedCutoverId!)
      : await this.capturePredecessor(request.candidate.releaseClass);
    await this.ports.deployment.assertRecoverable(uniformSha(before));
    const session = adoption
      ? this.adoptOnce(adoption, request)
      : sessions.acquireFenced({
        id: request.sessionId, ownerId: request.ownerId, mode: "MAINTENANCE_CUTOVER",
        targetSha: request.candidate.sha, candidateId: request.candidate.id, adoptedCutoverId: request.adoptedCutoverId,
      }, before);
    sessions.beginDeploying(session.id, request.ownerId);

    try {
      await this.ports.deployment.deploy(request.candidate.sha);
    } catch (error) {
      return this.classify(session.id, request.ownerId, failureCode(error));
    }

    return this.finishCutover(session.id, request);
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
      await this.ports.deployment.assertPredecessorRetained(uniformSha(session.preDeployTopology));
    } catch (error) {
      return this.recovery(sessionId, request.ownerId, `PREDECESSOR_IMAGE_RECHECK_FAILED:${failureCode(error)}`);
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
   * The snapshot a cutover freezes, from the reader that can see the lineage it
   * is leaving.
   *
   * A launch baseline requires the bridge rather than falling back to it: the
   * canonical reader would throw on the predecessor database, and a cutover
   * that began without a snapshot would have no way to prove a safe abort.
   */
  private async capturePredecessor(releaseClass: ReleaseCandidate["releaseClass"]): Promise<DeploymentObservation> {
    if (releaseClass !== "LAUNCH_BASELINE") return this.ports.topology.observe();
    if (!this.ports.predecessor) throw new ReleaseOrchestrationError("LAUNCH_CUTOVER_REQUIRES_PREDECESSOR_READER");
    return this.ports.predecessor.observe();
  }

  /**
   * Refused rather than silently fallen back to a fresh read: a deploy told to
   * adopt a cutover must adopt that cutover. Re-deriving the snapshot instead
   * would judge the release against the successor it just installed.
   */
  private adoptionPort(): CutoverAdoptionPort {
    if (!this.ports.cutoverAdoption) throw new ReleaseOrchestrationError("CUTOVER_ADOPTION_REQUIRES_ADOPTION_PORT");
    return this.ports.cutoverAdoption;
  }

  /**
   * A handoff is adopted once. Finding one already committed means a previous
   * deploy owns this cutover, and restarting it here would hand a second runner
   * the same closed gate. The existing session is the authority; `resume` is
   * what reads its state and decides what is still owed.
   */
  private adoptOnce(adoption: CutoverAdoptionPort, request: ReleaseRequest): DeploySession {
    const { session, reconciled } = adoption.adopt(request.adoptedCutoverId!, request.ownerId, request.candidate);
    if (reconciled) throw new ReleaseOrchestrationError("CUTOVER_ALREADY_ADOPTED", `${request.adoptedCutoverId} is owned by session ${session.id}; resume it`);
    return session;
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
    this.ports.sessions.armExternalEffects(sessionId, request.ownerId);
    // ----------------------------------------------------------------------

    try {
      await this.ports.certification.certify(capability);
    } catch (error) {
      // Past the boundary there is no safe abort and no rollback: the archived
      // database can no longer account for what may already have happened.
      return this.recovery(sessionId, request.ownerId, `CERTIFICATION_FAILED:${failureCode(error)}`);
    }

    // Certification takes as long as a real payment and refund take, and a
    // surface can drift underneath it. The observation that closes the release
    // has to be the one taken after that, never the pre-arming snapshot.
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
    const observed = await this.ports.topology.observe();
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
   * it is valid precisely while that database survives the operation. A session
   * that adopted a cutover is refused outright: reversing it replaces
   * `commerce.sqlite`, and a rollback cannot keep its only receipt inside the
   * thing it is destroying. That case belongs to BootstrapRollback, which
   * records its terminal fact outside the database.
   *
   * Legal only while the old lineage is still a truthful account of what
   * happened. The driver's return is not taken as proof: the restored topology
   * is read back and must match the recorded vector exactly, and only then do
   * the terminal state and the gate move together.
   */
  async rollback(sessionId: string, ownerId: string): Promise<ReleaseOutcome> {
    if (!this.ports.recovery) throw new ReleaseOrchestrationError("ROLLBACK_REQUIRES_RECOVERY_DRIVER");
    const session = this.ports.sessions.observeTopology(sessionId, ownerId, await this.ports.topology.observe());
    if (session.adoptedCutoverId) throw new ReleaseOrchestrationError("CROSS_LINEAGE_ROLLBACK_REQUIRES_REVERSE_HANDOFF");
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new ReleaseOrchestrationError("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_REQUIRED");

    try {
      await this.ports.recovery.restorePreDeployTopology(session.preDeployTopology);
    } catch (error) {
      return this.recovery(sessionId, ownerId, `ROLLBACK_FAILED:${failureCode(error)}`);
    }

    const restored = await this.ports.topology.observe();
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
    if (!known.candidateId) throw new ReleaseOrchestrationError("SESSION_HAS_NO_CANDIDATE", sessionId);
    const candidate = this.ports.candidates.get(known.candidateId);
    if (!candidate) throw new ReleaseOrchestrationError("CANDIDATE_NOT_FOUND", known.candidateId);
    if (candidate.sha !== known.targetSha) throw new ReleaseOrchestrationError("CANDIDATE_SESSION_MISMATCH", known.candidateId);

    const observed = await this.ports.topology.observe();
    const session = this.ports.sessions.observeTopology(sessionId, ownerId, observed);
    const plan = planResume(session, observed);
    if (plan.kind !== expected) throw new ReleaseOrchestrationError(`RESUME_PLAN_STALE:${plan.kind}`);

    const full: ReleaseRequest = { ownerId, candidate, sessionId };
    if (plan.kind === "RETRY_DEPLOY") {
      try {
        if (session.mode === "MAINTENANCE_CUTOVER") {
          if (!session.preDeployTopology) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_REQUIRED");
          await this.ports.deployment.assertRecoverable(uniformSha(session.preDeployTopology));
        }
        await this.ports.deployment.deploy(session.targetSha);
      } catch (error) {
        return this.classify(sessionId, ownerId, failureCode(error));
      }
    }
    if (plan.kind === "FIX_FORWARD_OR_ROLLBACK") throw new ReleaseOrchestrationError("FIX_FORWARD_DIRECTION_REQUIRED");
    return session.mode === "MAINTENANCE_CUTOVER" ? this.finishCutover(sessionId, full) : this.finishRolling(sessionId, full);
  }

  /** Convergence is proved by a fresh observation, never by the snapshot taken earlier. */
  private async requireTargetTopology(
    sessionId: string,
    request: ReleaseRequest,
  ): Promise<{ topology: DeploymentObservation } | ReleaseOutcome> {
    const topology = await this.ports.topology.observe();
    this.ports.sessions.observeTopology(sessionId, request.ownerId, topology);
    if (runtimeIsTarget(topology.runtime, request.candidate.sha)) return { topology };
    return this.classify(sessionId, request.ownerId, "TARGET_TOPOLOGY_NOT_CONVERGED");
  }

  /** ADMITTED is the only answer that may precede arming. PENDING is not "close enough". */
  private async requireReadiness(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome | undefined> {
    const evidence = await this.ports.evidence.read();
    const readiness = evaluateReadiness(readinessExpectation(request.candidate), evidence, this.clock());
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
    return { kind: "RECOVERY_REQUIRED", session, code };
  }

  private recovery(sessionId: string, ownerId: string, code: string): ReleaseOutcome {
    const session = this.ports.sessions.enterRecoveryRequired(sessionId, ownerId);
    return { kind: "RECOVERY_REQUIRED", session, code };
  }
}

/** A shared deploy pointer can restore only one predecessor revision. */
const uniformSha = (topology: DeploymentObservation | PreDeploySnapshot): string => {
  const values = Object.values(topology.runtime);
  if (!values.length || new Set(values).size !== 1) throw new ReleaseOrchestrationError("PRE_DEPLOY_TOPOLOGY_NOT_UNIFORM");
  return values[0]!;
};
