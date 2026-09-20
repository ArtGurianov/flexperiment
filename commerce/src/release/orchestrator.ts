import { evaluateReadiness, type ReleaseReadinessEvidence, type ReleaseReadinessExpectation } from "./readiness";
import {
  DeploySessions, topologyIsTarget,
  type DeployMode, type DeploySession, type PreDeployTopology,
} from "./deploy-session";
import type { CertificationCapability } from "./sales-gate";

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
  observe(): Promise<PreDeployTopology>;
}

/** Reads the evidence readiness judges: both runtimes, the schema, the legal release. */
export interface RuntimeEvidenceReader {
  read(): Promise<ReleaseReadinessEvidence>;
}

/** The deployment-owned sales fence. Never the emergency gate, which belongs to an operator. */
export interface SalesFence {
  close(sessionId: string): Promise<void>;
  open(sessionId: string): Promise<void>;
}

/** Hands the target revision to whatever actually deploys it. */
export interface DeploymentDriver {
  deploy(targetSha: string): Promise<void>;
}

/** Issues the one-shot capability and performs the real-money certification with it. */
export interface CertificationDriver {
  issueCapability(sessionId: string): Promise<CertificationCapability>;
  certify(capability: CertificationCapability): Promise<void>;
}

export type ReleasePorts = {
  readonly sessions: DeploySessions;
  readonly topology: TopologyReader;
  readonly evidence: RuntimeEvidenceReader;
  readonly fence: SalesFence;
  readonly deployment: DeploymentDriver;
  readonly certification?: CertificationDriver;
  readonly clock?: () => Date;
};

export type ReleaseRequest = {
  readonly ownerId: string;
  readonly mode: DeployMode;
  readonly targetSha: string;
  readonly expectation: ReleaseReadinessExpectation;
  readonly sessionId?: string;
};

export type ReleaseOutcome =
  | { readonly kind: "SUCCEEDED"; readonly session: DeploySession }
  | { readonly kind: "SAFE_ABORTED"; readonly session: DeploySession; readonly code: string }
  | { readonly kind: "ROLLED_BACK"; readonly session: DeploySession; readonly code: string }
  | { readonly kind: "RECOVERY_REQUIRED"; readonly session: DeploySession; readonly code: string };

export class ReleaseOrchestrationError extends Error {
  constructor(readonly code: string) { super(code); }
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
    if (request.mode !== "ROLLING_SAFE") throw new ReleaseOrchestrationError("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    const { sessions } = this.ports;
    const session = sessions.acquire({ id: request.sessionId, ownerId: request.ownerId, mode: "ROLLING_SAFE", targetSha: request.targetSha });
    const before = await this.ports.topology.observe();
    sessions.beginDeploying(session.id, request.ownerId, before);

    try {
      await this.ports.deployment.deploy(request.targetSha);
    } catch (error) {
      return this.classify(session.id, request.ownerId, failureCode(error));
    }

    const converged = await this.requireTargetTopology(session.id, request);
    if ("kind" in converged) return converged;
    const admitted = await this.requireReadiness(session.id, request);
    if (admitted) return admitted;
    return { kind: "SUCCEEDED", session: sessions.completeTarget(session.id, request.ownerId, converged.topology) };
  }

  /**
   * The destructive path. The ordering below is the contract: the fence closes
   * before anything is deployed, the irreversible boundary is armed only once
   * the exact target topology is proved and readiness has admitted it, and the
   * certification capability does not exist until after that arming.
   */
  async runMaintenanceCutover(request: ReleaseRequest): Promise<ReleaseOutcome> {
    if (request.mode !== "MAINTENANCE_CUTOVER") throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_MAINTENANCE_CUTOVER");
    if (!this.ports.certification) throw new ReleaseOrchestrationError("CUTOVER_REQUIRES_CERTIFICATION_DRIVER");
    const { sessions } = this.ports;
    const session = sessions.acquire({ id: request.sessionId, ownerId: request.ownerId, mode: "MAINTENANCE_CUTOVER", targetSha: request.targetSha });

    // Captured before the fence and before anything is deployed, so a failure
    // can be judged against what production was actually serving.
    const before = await this.ports.topology.observe();
    sessions.fence(session.id, request.ownerId, before);
    await this.ports.fence.close(session.id);
    sessions.beginDeploying(session.id, request.ownerId);

    try {
      await this.ports.deployment.deploy(request.targetSha);
    } catch (error) {
      return this.classify(session.id, request.ownerId, failureCode(error));
    }

    const converged = await this.requireTargetTopology(session.id, request);
    if ("kind" in converged) return converged;
    const admitted = await this.requireReadiness(session.id, request);
    if (admitted) return admitted;

    // ---- last reversible point -------------------------------------------
    sessions.armExternalEffects(session.id, request.ownerId);
    // ----------------------------------------------------------------------

    try {
      const capability = await this.ports.certification.issueCapability(session.id);
      await this.ports.certification.certify(capability);
    } catch (error) {
      // Past the boundary there is no safe abort and no rollback: the archived
      // database can no longer account for what may already have happened.
      return this.recovery(session.id, request.ownerId, `CERTIFICATION_FAILED:${failureCode(error)}`);
    }

    // Certification takes as long as a real payment and refund take, and a
    // surface can drift underneath it. The observation that closes the release
    // has to be the one taken after that, never the pre-arming snapshot.
    const final = await this.requireTargetTopology(session.id, request);
    if ("kind" in final) return final;

    const succeeded = sessions.completeTarget(session.id, request.ownerId, final.topology);
    await this.ports.fence.open(session.id);
    return { kind: "SUCCEEDED", session: succeeded };
  }

  /** Convergence is proved by a fresh observation, never by the snapshot taken earlier. */
  private async requireTargetTopology(
    sessionId: string,
    request: ReleaseRequest,
  ): Promise<{ topology: PreDeployTopology } | ReleaseOutcome> {
    const topology = await this.ports.topology.observe();
    this.ports.sessions.observeTopology(sessionId, request.ownerId, topology);
    if (topologyIsTarget(topology, request.targetSha)) return { topology };
    return this.classify(sessionId, request.ownerId, "TARGET_TOPOLOGY_NOT_CONVERGED");
  }

  /** ADMITTED is the only answer that may precede arming. PENDING is not "close enough". */
  private async requireReadiness(sessionId: string, request: ReleaseRequest): Promise<ReleaseOutcome | undefined> {
    const evidence = await this.ports.evidence.read();
    const readiness = evaluateReadiness(request.expectation, evidence, this.clock());
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
    if (session.state === "SAFE_ABORTED") {
      // Only a cutover ever closed the fence, so only a cutover reopens it. A
      // rolling release that fails must leave the gate exactly as it found it.
      if (session.mode === "MAINTENANCE_CUTOVER") await this.ports.fence.open(sessionId);
      return { kind: "SAFE_ABORTED", session, code };
    }
    return { kind: "RECOVERY_REQUIRED", session, code };
  }

  private recovery(sessionId: string, ownerId: string, code: string): ReleaseOutcome {
    const session = this.ports.sessions.enterRecoveryRequired(sessionId, ownerId);
    return { kind: "RECOVERY_REQUIRED", session, code };
  }
}
