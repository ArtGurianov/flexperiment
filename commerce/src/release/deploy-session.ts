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
};

export type DeploySessionPatch = Partial<Pick<DeploySession, "ownerId" | "state" | "rollbackAuthority" | "mutationObserved" | "leaseExpiresAt" | "preDeployTopology" | "observedTopology">>;

export interface DeploySessionStore {
  acquire(session: DeploySession): DeploySession;
  get(id: string): DeploySession | undefined;
  recordTopology(id: string, kind: "PRE_DEPLOY" | "OBSERVED", topology: PreDeployTopology): DeploySession;
  transition(id: string, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession;
  renewLease(id: string, ownerId: string, leaseExpiresAt: string): DeploySession;
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

export class InMemoryDeploySessionStore implements DeploySessionStore {
  #sessions = new Map<string, DeploySession>();

  acquire(session: DeploySession): DeploySession {
    if (this.#sessions.has(session.id)) throw new Error("DEPLOY_SESSION_ALREADY_EXISTS");
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): DeploySession | undefined { return this.#sessions.get(id); }

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

export class DeploySessions {
  constructor(
    private readonly store: DeploySessionStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 5 * 60_000,
  ) {}

  acquire(input: { id?: string; ownerId: string; mode: DeployMode; targetSha: string }): DeploySession {
    if (!input.ownerId) throw new Error("DEPLOY_SESSION_OWNER_REQUIRED");
    if (!isSourceCommit(input.targetSha)) throw new Error("DEPLOY_SESSION_TARGET_SHA_INVALID");
    const now = this.clock();
    return this.store.acquire({
      id: input.id ?? randomUUID(), ownerId: input.ownerId, mode: input.mode, targetSha: input.targetSha,
      state: "ACQUIRED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: false, createdAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
    });
  }

  fence(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.mode !== "MAINTENANCE_CUTOVER") throw new Error("ROLLING_SAFE_DOES_NOT_FENCE_SALES");
    assertTopology(topology);
    this.store.recordTopology(id, "PRE_DEPLOY", topology);
    return this.store.transition(id, ["ACQUIRED"], { state: "FENCED" });
  }

  beginDeploying(id: string, ownerId: string, rollingPreDeployTopology?: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.mode === "MAINTENANCE_CUTOVER") {
      if (rollingPreDeployTopology) throw new Error("MAINTENANCE_TOPOLOGY_RECORDED_AT_FENCE");
      return this.store.transition(id, ["FENCED"], { state: "DEPLOYING" });
    }
    if (!rollingPreDeployTopology) throw new Error("ROLLING_PRE_DEPLOY_TOPOLOGY_REQUIRED");
    assertTopology(rollingPreDeployTopology);
    this.store.recordTopology(id, "PRE_DEPLOY", rollingPreDeployTopology);
    return this.store.transition(id, ["ACQUIRED"], { state: "DEPLOYING" });
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
    if (!observed.mutationObserved) return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "SAFE_ABORTED" });
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
  }

  /**
   * The point of no return, and the only thing that spends rollback authority.
   *
   * It is called once a certification step has produced a durable effect
   * outside this system - a real payment taken, a receipt issued, a message
   * delivered. From then on the archived pre-launch database is no longer a
   * truthful account of what happened, so restoring it would lose the record
   * of a real transaction. Recovery must go forward.
   *
   * Deliberately NOT implied by a converged topology: deploying every surface
   * changes nothing outside this system, and that case must stay rollbackable.
   * Monotonic and idempotent - there is no way back to OLD_LINEAGE_ALLOWED.
   */
  commitExternalEffects(id: string, ownerId: string): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.rollbackAuthority === "NEW_LINEAGE_ONLY") return session;
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { rollbackAuthority: "NEW_LINEAGE_ONLY" });
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

  completeTarget(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const observed = this.observeTopology(id, ownerId, topology);
    if (!topologyIsTarget(topology, observed.targetSha)) throw new Error("TARGET_TOPOLOGY_NOT_CONVERGED");
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "SUCCEEDED" });
  }

  /** Production was put back on the pre-deploy topology. Only legal while the old lineage is still a truthful destination. */
  completeRollback(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology || !topologyEquals(topology, session.preDeployTopology)) throw new Error("ROLLBACK_TOPOLOGY_NOT_CONVERGED");
    assertTopology(topology);
    this.store.recordTopology(id, "OBSERVED", topology);
    return this.store.transition(id, ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "ROLLED_BACK" });
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
