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
  /**
   * The predecessor archive this session was handed, copied out of the envelope
   * at adoption. Without it, a retry that finds the session already committed
   * has nothing to check the leftover envelope against, and a file that merely
   * reused a cutover id would read as the same handoff.
   */
  readonly predecessorDatabaseRef?: string;
  readonly predecessorDatabaseSha256?: string;
  /** Digest of every immutable field of the adopted envelope; see canonicalEnvelopeSha256. */
  readonly adoptedEnvelopeSha256?: string;
  /**
   * Set once a bootstrap reverse handoff is reserved, and never cleared.
   *
   * Preparing one archives the successor and then loses the ability to consult
   * this database at all, so the direction of recovery has to be chosen here,
   * atomically, before that happens. Without it another runner could arm
   * external effects - and take a real payment - while a rollback already
   * committed to restoring the predecessor.
   */
  readonly bootstrapRollbackId?: string;
};

export type DeploySessionPatch = Partial<Pick<DeploySession, "ownerId" | "state" | "rollbackAuthority" | "mutationObserved" | "leaseExpiresAt" | "preDeployTopology" | "observedTopology" | "bootstrapRollbackId">>;

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
  /**
   * Creates the session. Whether the gate closes follows from the session's own
   * mode, never from a caller's flag: a maintenance cutover that did not close
   * it and a rolling release that did are both simply wrong, and an argument
   * lets a caller ask for either.
   */
  acquire(session: DeploySession): DeploySession;
  /**
   * Every mutation carries the owner and the instant, and the store checks both
   * in the same operation that writes. Reading the lease and then acting on it
   * is two steps, and two runners can both pass the read: production SQL makes
   * this one guarded UPDATE whose `changes === 1` is the only proof of
   * ownership, so the contract has to demand it here too.
   */
  recordTopology(id: string, ownerId: string, now: Date, kind: "PRE_DEPLOY" | "OBSERVED", topology: PreDeployTopology): DeploySession;
  /** Ordinary progress. Terminal states are unreachable here by construction. */
  transitionNonTerminal(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession;
  /** The only way to a terminal state, and it releases the gate in the same operation. */
  settle(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], state: TerminalState): DeploySession;
  renewOwnedLease(id: string, ownerId: string, now: Date, leaseExpiresAt: string): DeploySession;
  /** Ownership moves only when the lease has actually lapsed, decided inside the write. */
  takeOverExpiredLease(id: string, newOwnerId: string, now: Date, leaseExpiresAt: string): DeploySession;
  /** Chooses recovery direction once and for all, in the same write that checks it may be chosen. */
  reserveBootstrapRollback(id: string, ownerId: string, now: Date, rollbackId: string): DeploySession;
  /** Shaped like SalesGateState's own view, so a capability can be bound to the owning session. */
  deploymentGate(): DeploymentGateView;
}

export type DeploymentGateView = {
  readonly closed: boolean;
  readonly deploymentSessionId: string | null;
};

export type TerminalState = Extract<DeploySessionState, "SAFE_ABORTED" | "SUCCEEDED" | "ROLLED_BACK">;
const TERMINAL = new Set<DeploySessionState>(["SAFE_ABORTED", "SUCCEEDED", "ROLLED_BACK"]);
const NON_TERMINAL: readonly DeploySessionState[] = ["ACQUIRED", "FENCED", "DEPLOYING", "RECOVERY_REQUIRED"];
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
  /**
   * Production has one topology, so it has one deployment session at a time -
   * rolling or maintenance, it makes no difference. A workflow `concurrency`
   * group is an operational guard that a takeover, a recovery or a hand-run
   * script can step around; this is the authority, and it must stay right when
   * they do.
   */
  #activeSessionId: string | null = null;
  /**
   * A closed gate belongs to the session that closed it, and only that session
   * can open it. Tracking identity rather than a boolean is what stops one
   * session from reopening sales that another is still holding shut.
   */
  #gateOwnerSessionId: string | null = null;

  acquire(session: DeploySession): DeploySession {
    if (this.#sessions.has(session.id)) throw new Error("DEPLOY_SESSION_ALREADY_EXISTS");
    if (this.#activeSessionId) throw new Error("DEPLOY_SESSION_ALREADY_ACTIVE");
    if (session.adoptedCutoverId && this.findByAdoptedCutover(session.adoptedCutoverId)) {
      throw new Error("CUTOVER_ALREADY_ADOPTED");
    }
    if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    const expected = session.mode === "MAINTENANCE_CUTOVER" ? "FENCED" : "DEPLOYING";
    if (session.state !== expected) throw new Error("DEPLOY_SESSION_INITIAL_STATE_INVALID");
    this.#sessions.set(session.id, session);
    this.#activeSessionId = session.id;
    if (session.mode === "MAINTENANCE_CUTOVER") this.#gateOwnerSessionId = session.id;
    return session;
  }

  get(id: string): DeploySession | undefined { return this.#sessions.get(id); }

  findByAdoptedCutover(cutoverId: string): DeploySession | undefined {
    for (const session of this.#sessions.values()) if (session.adoptedCutoverId === cutoverId) return session;
    return undefined;
  }

  settle(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], state: TerminalState): DeploySession {
    if (this.#activeSessionId !== id) throw new Error("DEPLOY_SESSION_NOT_ACTIVE");
    const session = this.required(id);
    const ownsGate = session.mode === "MAINTENANCE_CUTOVER";
    if (ownsGate && this.#gateOwnerSessionId !== id) throw new Error("DEPLOYMENT_GATE_NOT_OWNED");
    if (!ownsGate && this.#gateOwnerSessionId === id) throw new Error("ROLLING_SESSION_OWNS_NO_GATE");
    const settled = this.write(id, ownerId, now, from, { state });
    if (ownsGate) this.#gateOwnerSessionId = null;
    this.#activeSessionId = null;
    return settled;
  }

  deploymentGate(): DeploymentGateView {
    return { closed: this.#gateOwnerSessionId !== null, deploymentSessionId: this.#gateOwnerSessionId };
  }

  recordTopology(id: string, ownerId: string, now: Date, kind: "PRE_DEPLOY" | "OBSERVED", topology: PreDeployTopology): DeploySession {
    const session = this.write(id, ownerId, now, NON_TERMINAL, {});
    if (kind === "PRE_DEPLOY" && session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_ALREADY_RECORDED");
    const next = kind === "PRE_DEPLOY" ? { ...session, preDeployTopology: topology } : { ...session, observedTopology: topology };
    this.#sessions.set(id, next);
    return next;
  }

  transitionNonTerminal(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession {
    if (patch.state && TERMINAL.has(patch.state)) throw new Error("TERMINAL_STATE_REQUIRES_SETTLE");
    return this.write(id, ownerId, now, from, patch);
  }

  renewOwnedLease(id: string, ownerId: string, now: Date, leaseExpiresAt: string): DeploySession {
    return this.write(id, ownerId, now, NON_TERMINAL, { leaseExpiresAt });
  }

  reserveBootstrapRollback(id: string, ownerId: string, now: Date, rollbackId: string): DeploySession {
    const session = this.required(id);
    // Idempotent for the same rollback, refused for a different one: a second
    // reverse handoff over the first would archive the successor twice and
    // leave two receipts each believing it owns the restore.
    if (session.bootstrapRollbackId) {
      if (session.bootstrapRollbackId !== rollbackId) throw new Error("BOOTSTRAP_ROLLBACK_ALREADY_RESERVED");
      return session;
    }
    if (!session.adoptedCutoverId) throw new Error("BOOTSTRAP_ROLLBACK_NOT_A_CUTOVER_SESSION");
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (this.#gateOwnerSessionId !== id) throw new Error("DEPLOYMENT_GATE_NOT_OWNED");
    return this.write(id, ownerId, now, NON_TERMINAL, { bootstrapRollbackId: rollbackId });
  }

  takeOverExpiredLease(id: string, newOwnerId: string, now: Date, leaseExpiresAt: string): DeploySession {
    const session = this.required(id);
    if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
    // The lapse is decided here, not by a caller that read the row earlier.
    if (Date.parse(session.leaseExpiresAt) > now.getTime()) throw new Error("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
    const next = { ...session, ownerId: newOwnerId, leaseExpiresAt };
    this.#sessions.set(id, next);
    return next;
  }

  private write(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession {
    const session = this.required(id);
    if (session.ownerId !== ownerId) throw new Error("DEPLOY_SESSION_NOT_OWNER");
    if (Date.parse(session.leaseExpiresAt) <= now.getTime()) throw new Error("DEPLOY_SESSION_LEASE_EXPIRED");
    if (!from.includes(session.state)) throw new Error(`DEPLOY_SESSION_TRANSITION_INVALID:${session.state}`);
    const next = { ...session, ...patch };
    this.#sessions.set(id, next);
    return next;
  }

  private required(id: string): DeploySession {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    return session;
  }
}


/**
 * What a new owner may do with a session it just took over.
 *
 * An expired lease means one thing only: the previous runner is gone and
 * ownership may move. It never means sales may reopen, the deploy may be
 * abandoned, or the old lineage may be restored - those are conclusions about
 * production, and a clock says nothing about production. So the next action is
 * decided by the session's own state and a fresh reading of the topology, never
 * by the fact that time passed.
 */
export type ResumePlan =
  /** Nothing was ever switched: the deploy can simply be attempted again. */
  | { readonly kind: "RETRY_DEPLOY" }
  /** Every surface already serves the target; pick up at readiness. */
  | { readonly kind: "PROVE_READINESS" }
  /** Some surfaces moved and some did not. A human decides the direction. */
  | { readonly kind: "FIX_FORWARD_OR_ROLLBACK" }
  /** External effects are committed, so the old lineage is no longer a destination. */
  | { readonly kind: "FIX_FORWARD_ONLY" };

export const planResume = (session: DeploySession, freshTopology: PreDeployTopology): ResumePlan => {
  if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
  if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
  if (session.rollbackAuthority === "NEW_LINEAGE_ONLY") return { kind: "FIX_FORWARD_ONLY" };
  if (session.state === "RECOVERY_REQUIRED") return { kind: "FIX_FORWARD_OR_ROLLBACK" };
  if (topologyIsTarget(freshTopology, session.targetSha)) return { kind: "PROVE_READINESS" };
  // Unchanged means unchanged everywhere: one moved surface is a partial
  // deployment, whatever the others say, and re-firing the deploy over it would
  // be acting on an assumption nobody checked.
  if (topologyEquals(freshTopology, session.preDeployTopology) && !session.mutationObserved) return { kind: "RETRY_DEPLOY" };
  return { kind: "FIX_FORWARD_OR_ROLLBACK" };
};

export type AcquireInput = {
  readonly id?: string;
  readonly ownerId: string;
  readonly mode: DeployMode;
  readonly targetSha: string;
  readonly adoptedCutoverId?: string;
  /**
   * The predecessor archive this session was handed, copied out of the envelope
   * at adoption. Without it, a retry that finds the session already committed
   * has nothing to check the leftover envelope against, and a file that merely
   * reused a cutover id would read as the same handoff.
   */
  readonly predecessorDatabaseRef?: string;
  readonly predecessorDatabaseSha256?: string;
  readonly adoptedEnvelopeSha256?: string;
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
    return this.store.acquire({ ...this.blank(input), state: "FENCED", preDeployTopology });
  }

  /** A rolling release never touches the gate, so its creation says so explicitly. */
  acquireRolling(input: AcquireInput, preDeployTopology: PreDeployTopology): DeploySession {
    if (input.mode !== "ROLLING_SAFE") throw new Error("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    assertTopology(preDeployTopology);
    return this.store.acquire({ ...this.blank(input), state: "DEPLOYING", preDeployTopology });
  }

  beginDeploying(id: string, ownerId: string): DeploySession {
    this.owned(id, ownerId);
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["FENCED"], { state: "DEPLOYING" });
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
      predecessorDatabaseRef: input.predecessorDatabaseRef,
      predecessorDatabaseSha256: input.predecessorDatabaseSha256,
      adoptedEnvelopeSha256: input.adoptedEnvelopeSha256,
    };
  }

  observeTopology(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    assertTopology(topology);
    this.store.recordTopology(id, ownerId, this.clock(), "OBSERVED", topology);
    const mutationObserved = session.mutationObserved || !topologyEquals(topology, session.preDeployTopology);
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], { mutationObserved });
  }

  classifyFailure(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const observed = this.observeTopology(id, ownerId, topology);
    if (!observed.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    if (!observed.mutationObserved) {
      return this.store.settle(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], "SAFE_ABORTED");
    }
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
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
    // The reverse handoff may already have archived the successor and be about
    // to replace this database. Letting a payment through now would make the
    // predecessor archive an untrue account of what happened.
    if (session.bootstrapRollbackId) throw new Error("BOOTSTRAP_ROLLBACK_RESERVED");
    // Readiness stays the orchestrator's job, but arming certification on a
    // knowingly partial deployment is the one misuse worth making impossible
    // here rather than trusting a call order.
    if (!session.observedTopology || !topologyIsTarget(session.observedTopology, session.targetSha)) {
      throw new Error("TARGET_TOPOLOGY_NOT_OBSERVED");
    }
    if (session.rollbackAuthority === "NEW_LINEAGE_ONLY") return session;
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], { rollbackAuthority: "NEW_LINEAGE_ONLY" });
  }

  /**
   * Recovery entry for a failure that no topology reading can classify - a
   * certification step that failed past the irreversible boundary, say. It
   * records the state durably instead of leaving the session mid-flight.
   */
  enterRecoveryRequired(id: string, ownerId: string): DeploySession {
    this.owned(id, ownerId);
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], { state: "RECOVERY_REQUIRED" });
  }

  renewLease(id: string, ownerId: string): DeploySession {
    return this.store.renewOwnedLease(id, ownerId, this.clock(), new Date(this.clock().getTime() + this.leaseMs).toISOString());
  }

  reserveBootstrapRollback(id: string, ownerId: string, rollbackId: string): DeploySession {
    return this.store.reserveBootstrapRollback(id, ownerId, this.clock(), rollbackId);
  }

  takeOverExpiredLease(id: string, ownerId: string): DeploySession {
    return this.store.takeOverExpiredLease(id, ownerId, this.clock(), new Date(this.clock().getTime() + this.leaseMs).toISOString());
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
    if (observed.bootstrapRollbackId) throw new Error("BOOTSTRAP_ROLLBACK_RESERVED");
    if (!topologyIsTarget(topology, observed.targetSha)) throw new Error("TARGET_TOPOLOGY_NOT_CONVERGED");
    if (observed.mode === "MAINTENANCE_CUTOVER" && observed.rollbackAuthority !== "NEW_LINEAGE_ONLY") {
      throw new Error("MAINTENANCE_CUTOVER_EXTERNAL_EFFECTS_NOT_ARMED");
    }
    return this.store.settle(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], "SUCCEEDED");
  }

  /** Production was put back on the pre-deploy topology. Only legal while the old lineage is still a truthful destination. */
  completeRollback(id: string, ownerId: string, topology: PreDeployTopology): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology || !topologyEquals(topology, session.preDeployTopology)) throw new Error("ROLLBACK_TOPOLOGY_NOT_CONVERGED");
    assertTopology(topology);
    this.store.recordTopology(id, ownerId, this.clock(), "OBSERVED", topology);
    return this.store.settle(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], "ROLLED_BACK");
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
