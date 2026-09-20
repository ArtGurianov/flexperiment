import { randomUUID } from "node:crypto";
import { isSourceCommit } from "./runtime-identity";

export type DeployMode = "MAINTENANCE_CUTOVER" | "ROLLING_SAFE";
export type DeploySurface = "frontend" | "admin" | "commerce" | "worker";
export type PreDeployTopology = Readonly<Record<DeploySurface, string>>;
export type DeploySessionState = "ACQUIRED" | "FENCED" | "DEPLOYING" | "RECOVERY_REQUIRED" | "SAFE_ABORTED" | "SUCCEEDED" | "ROLLED_BACK";
export type RollbackAuthority = "OLD_LINEAGE_ALLOWED" | "NEW_LINEAGE_ONLY";

export type DeploySession = {
  readonly id: string;
  readonly ownerId: string;
  readonly mode: DeployMode;
  readonly targetSha: string;
  readonly state: DeploySessionState;
  readonly rollbackAuthority: RollbackAuthority;
  /**
   * Whether any production surface was ever observed away from the pre-deploy
   * snapshot. It is monotonic and is NOT the same question as rollback
   * authority: a half-switched topology is recoverable, so it forbids a safe
   * abort while leaving the old lineage a legal destination.
   */
  readonly mutationObserved: boolean;
  readonly createdAt: string;
  readonly leaseExpiresAt: string;
  readonly preDeployTopology?: PreDeployTopology;
  readonly observedTopology?: PreDeployTopology;
  /**
   * The cutover envelope this session adopted, when it was created across a
   * lineage boundary. Unique per session: the filesystem envelope and the
   * database row cannot share a transaction, so a retry that finds a session
   * already carrying this id finishes consuming the envelope instead of
   * refusing as a duplicate.
   */
  readonly adoptedCutoverId?: string;
};

export type DeploySessionPatch = Partial<Pick<DeploySession, "ownerId" | "state" | "rollbackAuthority" | "mutationObserved" | "leaseExpiresAt" | "preDeployTopology" | "observedTopology">>;

/**
 * Session state and the deployment sales gate are one operational fact, so one
 * authority owns both. A separate mutating fence port allowed states that are
 * simply wrong - a SUCCEEDED session with sales still shut, because a runner
 * died between two independent writes - and no amount of caller discipline
 * makes that impossible. Every transition that changes the gate does so in the
 * same operation, and P9 gives that operation one `BEGIN IMMEDIATE`.
 *
 * `evaluateSalesGate()` stays a pure function elsewhere, and the emergency gate
 * stays an operator's own switch above all of this.
 */
export interface ReleaseAuthorityStore {
  get(id: string): DeploySession | undefined;
  /** The session that adopted this cutover, if any. Makes handoff retry idempotent. */
  findByAdoptedCutover(cutoverId: string): DeploySession | undefined;
  /** Creates the session; closes the deployment gate in the same operation when asked. */
  acquire(session: DeploySession, options: { readonly closeGate: boolean }): DeploySession;
  recordTopology(id: string, kind: "PRE_DEPLOY" | "OBSERVED", topology: PreDeployTopology): DeploySession;
  transition(id: string, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession;
  /** Terminal transition and gate release, together or not at all. */
  settle(id: string, from: readonly DeploySessionState[], patch: DeploySessionPatch, options: { readonly openGate: boolean }): DeploySession;
  renewLease(id: string, ownerId: string, leaseExpiresAt: string): DeploySession;
  deploymentGateClosed(): boolean;
}

const TERMINAL = new Set<DeploySessionState>(["SAFE_ABORTED", "SUCCEEDED", "ROLLED_BACK"]);
const surfaces: readonly DeploySurface[] = ["frontend", "admin", "commerce", "worker"];

export const topologyEquals = (left: PreDeployTopology, right: PreDeployTopology): boolean =>
  surfaces.every((surface) => left[surface] === right[surface]);

export const topologyIsTarget = (topology: PreDeployTopology, targetSha: string): boolean =>
  surfaces.every((surface) => topology[surface] === targetSha);

const assertTopology = (topology: PreDeployTopology): void => {
  for (const surface of surfaces) if (!isSourceCommit(topology[surface])) throw new Error(`DEPLOY_TOPOLOGY_${surface.toUpperCase()}_INVALID`);
};

export class InMemoryReleaseAuthorityStore implements ReleaseAuthorityStore {
  #sessions = new Map<string, DeploySession>();
  #gateClosed = false;

  acquire(session: DeploySession, options: { readonly closeGate: boolean }): DeploySession {
    if (this.#sessions.has(session.id)) throw new Error("DEPLOY_SESSION_ALREADY_EXISTS");
    if (session.adoptedCutoverId && this.findByAdoptedCutover(session.adoptedCutoverId)) {
      throw new Error("CUTOVER_ALREADY_ADOPTED");
    }
    this.#sessions.set(session.id, session);
    if (options.closeGate) this.#gateClosed = true;
    return session;
  }

  get(id: string): DeploySession | undefined { return this.#sessions.get(id); }

  findByAdoptedCutover(cutoverId: string): DeploySession | undefined {
    for (const session of this.#sessions.values()) if (session.adoptedCutoverId === cutoverId) return session;
    return undefined;
  }

  settle(id: string, from: readonly DeploySessionState[], patch: DeploySessionPatch, options: { readonly openGate: boolean }): DeploySession {
    const settled = this.transition(id, from, patch);
    if (options.openGate) this.#gateClosed = false;
    return settled;
  }

  deploymentGateClosed(): boolean { return this.#gateClosed; }

  recordTopology(id: string, kind: "PRE_DEPLOY" | "OBSERVED", topology: PreDeployTopology): DeploySession {
    const session = this.required(id);
    if (kind === "PRE_DEPLOY" && session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_ALREADY_RECORDED");
    const next = kind === "PRE_DEPLOY" ? { ...session, preDeployTopology: topology } : { ...session, observedTopology: topology };
    this.#sessions.set(id, next);
    return next;
  }

  transition(id: string, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession {
    const session = this.required(id);
    if (!from.includes(session.state)) throw new Error(`DEPLOY_SESSION_TRANSITION_INVALID:${session.state}`);
    const next = { ...session, ...patch };
    this.#sessions.set(id, next);
    return next;
  }

  renewLease(id: string, ownerId: string, leaseExpiresAt: string): DeploySession {
    const session = this.required(id);
    if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
    const next = { ...session, ownerId, leaseExpiresAt };
    this.#sessions.set(id, next);
    return next;
  }

  private required(id: string): DeploySession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    return session;
  }
}

export type AcquireInput = {
  readonly id?: string;
  readonly ownerId: string;
  readonly mode: DeployMode;
  readonly targetSha: string;
  readonly adoptedCutoverId?: string;
};

export class DeploySessions {
  constructor(
    private readonly store: ReleaseAuthorityStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 5 * 60_000,
  ) {}

  /**
   * Creating the session, recording what production was serving and closing the
   * deployment gate are one operation. Splitting them left a window where a
   * dead runner could leave a session that believes it fenced nothing, or a
   * gate closed by a session that does not exist.
   */
  acquireFenced(input: AcquireInput, preDeployTopology: PreDeployTopology): DeploySession {
    if (input.mode !== "MAINTENANCE_CUTOVER") throw new Error("ROLLING_SAFE_DOES_NOT_FENCE_SALES");
    assertTopology(preDeployTopology);
    return this.store.acquire({ ...this.blank(input), state: "FENCED", preDeployTopology }, { closeGate: true });
  }

  /** A rolling release never touches the gate, so its creation says so explicitly. */
  acquireRolling(input: AcquireInput, preDeployTopology: PreDeployTopology): DeploySession {
    if (input.mode !== "ROLLING_SAFE") throw new Error("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    assertTopology(preDeployTopology);
    return this.store.acquire({ ...this.blank(input), state: "DEPLOYING", preDeployTopology }, { closeGate: false });
  }

  beginDeploying(id: string, ownerId: string): DeploySession {
    this.owned(id, ownerId);
    return this.store.transition(id, ["FENCED"], { state: "DEPLOYING" });
  }

  private blank(input: AcquireInput): DeploySession {
    if (!input.ownerId) throw new Error("DEPLOY_SESSION_OWNER_REQUIRED");
    if (!isSourceCommit(input.targetSha)) throw new Error("DEPLOY_SESSION_TARGET_SHA_INVALID");
    const now = this.clock();
    return {
      id: input.id ?? randomUUID(), ownerId: input.ownerId, mode: input.mode, targetSha: input.targetSha,
      state: "ACQUIRED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: false,
      createdAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      adoptedCutoverId: input.adoptedCutoverId,
    };
  }

  observeTopology(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    assertTopology(topology);
    this.store.recordTopology(id, "OBSERVED", topology);
    const mutationObserved = session.mutationObserved || !topologyEquals(topology, session.preDeployTopology);
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { mutationObserved });
  }

  classifyFailure(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const observed = this.observeTopology(id, ownerId, topology);
    if (!observed.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    if (!observed.mutationObserved) {
      return this.store.settle(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "SAFE_ABORTED" }, { openGate: observed.mode === "MAINTENANCE_CUTOVER" });
    }
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
  }

  /**
   * The point of no return, and the only thing that spends rollback authority.
   *
   * It is armed BEFORE the first external effect is permitted, never recorded
   * after one has happened. Recording afterwards would repeat the mistake this
   * codebase already refuses on the payment boundary: cross an external
   * boundary first, then hope to write the local truth. A runner that dies
   * between a captured payment and that write would leave a durable session
   * still claiming the archived database is a truthful destination, and a
   * takeover would roll back over a real transaction.
   *
   * So the boundary is deliberately conservative. It is not "an external effect
   * happened" but "external effects are now allowed", which is a fact this
   * system controls and can persist before anything leaves it. The cost is that
   * a crash after arming and before the first payment forces a fix-forward that
   * a rollback could technically still have served. For a one-shot launch
   * cutover, losing that availability is the right trade against distributed
   * ambiguity about whether money moved.
   *
   * Deliberately NOT implied by a converged topology: deploying every surface
   * changes nothing outside this system, and that case must stay rollbackable.
   * Monotonic and idempotent - there is no way back to OLD_LINEAGE_ALLOWED.
   */
  armExternalEffects(id: string, ownerId: string): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.mode !== "MAINTENANCE_CUTOVER") throw new Error("ROLLING_SAFE_ARMS_NO_EXTERNAL_EFFECTS");
    // Readiness stays the orchestrator's job, but arming certification on a
    // knowingly partial deployment is the one misuse worth making impossible
    // here rather than trusting a call order.
    if (!session.observedTopology || !topologyIsTarget(session.observedTopology, session.targetSha)) {
      throw new Error("TARGET_TOPOLOGY_NOT_OBSERVED");
    }
    if (session.rollbackAuthority === "NEW_LINEAGE_ONLY") return session;
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { rollbackAuthority: "NEW_LINEAGE_ONLY" });
  }

  /**
   * Recovery entry for a failure that no topology reading can classify - a
   * certification step that failed past the irreversible boundary, say. It
   * records the state durably instead of leaving the session mid-flight.
   */
  enterRecoveryRequired(id: string, ownerId: string): DeploySession {
    this.owned(id, ownerId);
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
  }

  renewLease(id: string, ownerId: string): DeploySession {
    this.owned(id, ownerId);
    return this.store.renewLease(id, ownerId, new Date(this.clock().getTime() + this.leaseMs).toISOString());
  }

  takeOverExpiredLease(id: string, ownerId: string): DeploySession {
    const session = this.store.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
    if (Date.parse(session.leaseExpiresAt) > this.clock().getTime()) throw new Error("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
    return this.store.renewLease(id, ownerId, new Date(this.clock().getTime() + this.leaseMs).toISOString());
  }

  /**
   * SUCCEEDED is terminal, and a terminal session can no longer arm anything.
   * A maintenance cutover that closed on convergence alone would therefore be
   * a cutover whose irreversible boundary can never be recorded at all - the
   * ordering would live only in a runbook. Requiring the armed authority here
   * makes "certification ran before this release was called done" structural.
   * A rolling release crosses no external boundary and needs no such proof.
   */
  completeTarget(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const observed = this.observeTopology(id, ownerId, topology);
    if (!topologyIsTarget(topology, observed.targetSha)) throw new Error("TARGET_TOPOLOGY_NOT_CONVERGED");
    if (observed.mode === "MAINTENANCE_CUTOVER" && observed.rollbackAuthority !== "NEW_LINEAGE_ONLY") {
      throw new Error("MAINTENANCE_CUTOVER_EXTERNAL_EFFECTS_NOT_ARMED");
    }
    return this.store.settle(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "SUCCEEDED" }, { openGate: observed.mode === "MAINTENANCE_CUTOVER" });
  }

  /** Production was put back on the pre-deploy topology. Only legal while the old lineage is still a truthful destination. */
  completeRollback(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology || !topologyEquals(topology, session.preDeployTopology)) throw new Error("ROLLBACK_TOPOLOGY_NOT_CONVERGED");
    assertTopology(topology);
    this.store.recordTopology(id, "OBSERVED", topology);
    return this.store.settle(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "ROLLED_BACK" }, { openGate: session.mode === "MAINTENANCE_CUTOVER" });
  }

  private owned(id: string, ownerId: string): DeploySession {
    const session = this.store.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
    if (session.ownerId !== ownerId) throw new Error("DEPLOY_SESSION_NOT_OWNER");
    if (Date.parse(session.leaseExpiresAt) <= this.clock().getTime()) throw new Error("DEPLOY_SESSION_LEASE_EXPIRED");
    return session;
  }
}
