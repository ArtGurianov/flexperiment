import { randomUUID } from "node:crypto";
import { isSourceCommit } from "./runtime-identity";
import { releaseBinding, type ForwardTarget, type ReleaseBinding } from "./forward-target";

export type DeployMode = "MAINTENANCE_CUTOVER" | "ROLLING_SAFE";
export type DeploySurface = "frontend" | "admin" | "commerce" | "worker";
export type RuntimeTopology = Readonly<Record<DeploySurface, string>>;

/**
 * What production was, in both the layers a cutover can move.
 *
 * The four surfaces are what production serves. The deploy pointer is what it
 * will serve next: the deployment applications track that ref, so a runtime
 * restored to the old commits while the ref names the new one is not a
 * production that was left alone - it is one waiting to move again. A snapshot
 * of only the first layer cannot tell those apart.
 */
export type PreDeploySnapshot = {
  readonly runtime: RuntimeTopology;
  readonly controlPlane: { readonly productionDeployRefSha: string };
};

/** A fresh reading of the same two layers. */
export type DeploymentObservation = PreDeploySnapshot;
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
  readonly preDeployTopology?: PreDeploySnapshot;
  readonly observedTopology?: DeploymentObservation;
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
  /**
   * The candidate this session deploys. Recorded at acquisition so a later call
   * cannot restate the release's identity: a resumed session continues the
   * release it started, not one a caller names afterwards.
   */
  readonly candidateId?: string;
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
  recordTopology(id: string, ownerId: string, now: Date, kind: "PRE_DEPLOY" | "OBSERVED", observation: DeploymentObservation): DeploySession;
  /** Ordinary progress. Terminal states are unreachable here by construction. */
  transitionNonTerminal(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], patch: DeploySessionPatch): DeploySession;
  /** The only way to a terminal state, and it releases the gate in the same operation. */
  settle(id: string, ownerId: string, now: Date, from: readonly DeploySessionState[], state: TerminalState): DeploySession;
  renewOwnedLease(id: string, ownerId: string, now: Date, leaseExpiresAt: string): DeploySession;
  /** Ownership moves only when the lease has actually lapsed, decided inside the write. */
  takeOverExpiredLease(id: string, newOwnerId: string, now: Date, leaseExpiresAt: string): DeploySession;
  /** The holder standing down, so the next command need not wait out the lease. */
  yieldLease(id: string, ownerId: string, now: Date): void;
  /** Shaped like SalesGateState's own view, so a capability can be bound to the owning session. */
  deploymentGate(): DeploymentGateView;
  /** Every forward revision of a session, in order. */
  forwardTargets(id: string): readonly ForwardTarget[];
  /**
   * Carries an armed, stuck session forward to a new release, as one guarded
   * write: the caller owns the session and its lease is live; the session is
   * RECOVERY_REQUIRED, NEW_LINEAGE_ONLY, fenced by itself and has no rollback
   * reserved; and the revision is the next one, starting where the current
   * binding ends. A row in the right state is not authorisation on its own.
   */
  appendForwardTarget(id: string, ownerId: string, now: Date, input: ForwardTargetInput, within?: () => void): ForwardTarget;
}

export type ForwardTargetInput = {
  readonly targetSha: string;
  readonly candidateId: string;
  readonly ciEvidence: string;
};

export type DeploymentGateView = {
  readonly closed: boolean;
  readonly deploymentSessionId: string | null;
};

export type TerminalState = Extract<DeploySessionState, "SAFE_ABORTED" | "SUCCEEDED" | "ROLLED_BACK">;
export const TERMINAL = new Set<DeploySessionState>(["SAFE_ABORTED", "SUCCEEDED", "ROLLED_BACK"]);
export const NON_TERMINAL: readonly DeploySessionState[] = ["ACQUIRED", "FENCED", "DEPLOYING", "RECOVERY_REQUIRED"];
const surfaces: readonly DeploySurface[] = ["frontend", "admin", "commerce", "worker"];

/**
 * What both stores prove before a forward revision, besides ownership and the
 * lease, which their own guarded write already proves.
 */
export const assertSupersedable = (session: DeploySession, gateOwnerSessionId: string | null): void => {
  if (session.mode !== "MAINTENANCE_CUTOVER") throw new Error("FORWARD_TARGET_REQUIRES_MAINTENANCE_CUTOVER");
  if (session.state !== "RECOVERY_REQUIRED") throw new Error(`FORWARD_TARGET_SESSION_STATE:${session.state}`);
  if (session.rollbackAuthority !== "NEW_LINEAGE_ONLY") throw new Error("FORWARD_TARGET_SESSION_NOT_ARMED");
  if (gateOwnerSessionId !== session.id) throw new Error("DEPLOYMENT_GATE_NOT_OWNED");
  if (session.bootstrapRollbackId) throw new Error("BOOTSTRAP_ROLLBACK_RESERVED");
};

/** The next revision after `current`, validated the way the schema will. */
export const forwardTargetFor = (session: DeploySession, current: ReleaseBinding, input: ForwardTargetInput, now: Date): ForwardTarget => {
  if (!isSourceCommit(input.targetSha)) throw new Error("FORWARD_TARGET_SHA_INVALID");
  if (input.targetSha === current.targetSha) throw new Error("FORWARD_TARGET_IS_CURRENT");
  if (!input.candidateId) throw new Error("FORWARD_TARGET_CANDIDATE_REQUIRED");
  if (!input.ciEvidence) throw new Error("FORWARD_TARGET_CI_EVIDENCE_REQUIRED");
  return {
    sessionId: session.id, revision: current.revision + 1, fromSha: current.targetSha,
    targetSha: input.targetSha, candidateId: input.candidateId, ciEvidence: input.ciEvidence,
    createdAt: now.toISOString(),
  };
};

export const runtimeEquals = (left: RuntimeTopology, right: RuntimeTopology): boolean =>
  surfaces.every((surface) => left[surface] === right[surface]);

export const runtimeIsTarget = (runtime: RuntimeTopology, targetSha: string): boolean =>
  surfaces.every((surface) => runtime[surface] === targetSha);

/** Both layers, so that a snapshot missing one cannot be compared as though it had it. */
export const snapshotEquals = (left: PreDeploySnapshot, right: PreDeploySnapshot): boolean =>
  runtimeEquals(left.runtime, right.runtime)
  && left.controlPlane.productionDeployRefSha === right.controlPlane.productionDeployRefSha;

/**
 * The snapshot's fields in a fixed order, for the digests that identify an
 * envelope. `Object.values` would follow insertion order, which differs between
 * a literal built here and the same snapshot parsed back out of its own JSON -
 * so a replay could recompute a different digest for an identical envelope and
 * refuse the handoff it was written to prove.
 */
export const snapshotDigestParts = (snapshot: PreDeploySnapshot): readonly string[] => [
  ...surfaces.map((surface) => snapshot.runtime[surface]),
  snapshot.controlPlane.productionDeployRefSha,
];

export const assertSnapshot = (snapshot: PreDeploySnapshot): void => {
  // A snapshot carrying only four surfaces is the shape this predates. It is
  // refused rather than completed with an assumed pointer: guessing where the
  // control plane was is exactly the reading that makes a safe abort unsafe.
  if (!snapshot?.runtime || !snapshot.controlPlane) throw new Error("DEPLOY_SNAPSHOT_MALFORMED");
  for (const surface of surfaces) {
    if (!isSourceCommit(snapshot.runtime[surface])) throw new Error(`DEPLOY_TOPOLOGY_${surface.toUpperCase()}_INVALID`);
  }
  if (!isSourceCommit(snapshot.controlPlane.productionDeployRefSha)) throw new Error("DEPLOY_CONTROL_PLANE_REF_INVALID");
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
    // Existence first: an id nobody ever acquired is not an inactive session,
    // and saying so sends a caller looking for a row that is not there.
    const session = this.required(id);
    if (this.#activeSessionId !== id) throw new Error("DEPLOY_SESSION_NOT_ACTIVE");
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

  #forwardTargets = new Map<string, ForwardTarget[]>();

  forwardTargets(id: string): readonly ForwardTarget[] { return [...(this.#forwardTargets.get(id) ?? [])]; }

  appendForwardTarget(id: string, ownerId: string, now: Date, input: ForwardTargetInput, within?: () => void): ForwardTarget {
    const session = this.write(id, ownerId, now, ["RECOVERY_REQUIRED"], {});
    assertSupersedable(session, this.#gateOwnerSessionId);
    const targets = this.#forwardTargets.get(id) ?? [];
    const current = releaseBinding(session, targets);
    const target = forwardTargetFor(session, current, input, now);
    within?.();
    this.#forwardTargets.set(id, [...targets, target]);
    return target;
  }

  recordTopology(id: string, ownerId: string, now: Date, kind: "PRE_DEPLOY" | "OBSERVED", observation: DeploymentObservation): DeploySession {
    const session = this.write(id, ownerId, now, NON_TERMINAL, {});
    if (kind === "PRE_DEPLOY" && session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_ALREADY_RECORDED");
    const next = kind === "PRE_DEPLOY" ? { ...session, preDeployTopology: observation } : { ...session, observedTopology: observation };
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

  yieldLease(id: string, ownerId: string, now: Date): void {
    const session = this.#sessions.get(id);
    if (!session || session.ownerId !== ownerId || TERMINAL.has(session.state)) return;
    this.#sessions.set(id, { ...session, leaseExpiresAt: now.toISOString() });
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

export const planResume = (session: DeploySession, freshObservation: DeploymentObservation): ResumePlan => {
  if (TERMINAL.has(session.state)) throw new Error("DEPLOY_SESSION_TERMINAL");
  if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
  if (session.rollbackAuthority === "NEW_LINEAGE_ONLY") return { kind: "FIX_FORWARD_ONLY" };
  if (session.state === "RECOVERY_REQUIRED") return { kind: "FIX_FORWARD_OR_ROLLBACK" };
  if (runtimeIsTarget(freshObservation.runtime, session.targetSha)) return { kind: "PROVE_READINESS" };
  // Unchanged means unchanged everywhere: one moved surface is a partial
  // deployment, whatever the others say, and re-firing the deploy over it would
  // be acting on an assumption nobody checked.
  if (snapshotEquals(freshObservation, session.preDeployTopology) && !session.mutationObserved) return { kind: "RETRY_DEPLOY" };
  return { kind: "FIX_FORWARD_OR_ROLLBACK" };
};

export type AcquireInput = {
  readonly id?: string;
  readonly ownerId: string;
  readonly mode: DeployMode;
  readonly targetSha: string;
  readonly candidateId?: string;
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
  acquireFenced(input: AcquireInput, preDeployTopology: PreDeploySnapshot): DeploySession {
    if (input.mode !== "MAINTENANCE_CUTOVER") throw new Error("ROLLING_SAFE_DOES_NOT_FENCE_SALES");
    assertSnapshot(preDeployTopology);
    return this.store.acquire({ ...this.blank(input), state: "FENCED", preDeployTopology });
  }

  /** A rolling release never touches the gate, so its creation says so explicitly. */
  acquireRolling(input: AcquireInput, preDeployTopology: PreDeploySnapshot): DeploySession {
    if (input.mode !== "ROLLING_SAFE") throw new Error("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    assertSnapshot(preDeployTopology);
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
      candidateId: input.candidateId,
    };
  }

  /**
   * `mutationObserved` latches on the RUNTIME layer only.
   *
   * It is monotonic and permanent - production having been touched is not a
   * thing that stops being true - and the control plane deliberately does not
   * feed it. Moving the deploy pointer is how a deploy begins; if that latched
   * the bit, returning the pointer afterwards could never restore a safe abort,
   * and the recovery path this exists for would be unreachable.
   */
  observeTopology(id: string, ownerId: string, observation: DeploymentObservation): DeploySession {
    const session = this.owned(id, ownerId);
    if (!session.preDeployTopology) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    assertSnapshot(observation);
    this.store.recordTopology(id, ownerId, this.clock(), "OBSERVED", observation);
    const mutationObserved = session.mutationObserved
      || !runtimeEquals(observation.runtime, session.preDeployTopology.runtime);
    return this.store.transitionNonTerminal(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], { mutationObserved });
  }

  /**
   * A safe abort claims production was never touched, in either layer.
   *
   * The runtime half is the monotonic bit; the control-plane half is checked
   * against this reading, now, because a pointer can be put back and a deployed
   * surface cannot. A caller that has moved the ref and wants a safe abort must
   * return the ref first and observe again - which is the whole point.
   */
  classifyFailure(id: string, ownerId: string, observation: DeploymentObservation): DeploySession {
    const observed = this.observeTopology(id, ownerId, observation);
    const snapshot = observed.preDeployTopology;
    if (!snapshot) throw new Error("PRE_DEPLOY_TOPOLOGY_REQUIRED");
    const controlPlaneRestored = observation.controlPlane.productionDeployRefSha === snapshot.controlPlane.productionDeployRefSha;
    if (!observed.mutationObserved && controlPlaneRestored) {
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
    // here rather than trusting a call order. The target is the current
    // binding's: a session carried forward is certified at the release it was
    // carried to, and comparing against the frozen original would refuse the
    // very certification that forward step exists to make possible.
    const target = this.binding(id).targetSha;
    if (!session.observedTopology || !runtimeIsTarget(session.observedTopology.runtime, target)) {
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

  /**
   * What the session is deploying now: revision, SHA and candidate together.
   * Every decision about a target reads this, never `session.targetSha`, which
   * stays the historical fact of what the cutover first set out to deploy.
   */
  binding(id: string): ReleaseBinding {
    const session = this.store.get(id);
    if (!session) throw new Error("DEPLOY_SESSION_NOT_FOUND");
    return releaseBinding(session, this.store.forwardTargets(id));
  }

  forwardTargets(id: string): readonly ForwardTarget[] {
    return this.store.forwardTargets(id);
  }

  /**
   * See ReleaseAuthorityStore.appendForwardTarget. `within` runs inside the
   * same transaction, before the revision is written and while the current
   * binding is still the one being left - so whatever it does commits with the
   * revision or not at all.
   */
  appendForwardTarget(id: string, ownerId: string, input: ForwardTargetInput, within?: () => void): ForwardTarget {
    return this.store.appendForwardTarget(id, ownerId, this.clock(), input, within);
  }

  renewLease(id: string, ownerId: string): DeploySession {
    return this.store.renewOwnedLease(id, ownerId, this.clock(), new Date(this.clock().getTime() + this.leaseMs).toISOString());
  }

  /**
   * Keeps a session this process already owns, across an operation longer than
   * a lease term.
   *
   * The attended certification legitimately outlasts five minutes: a real
   * payment, an email and a refund each have timeouts measured in tens of
   * minutes, with a synchronous `/dev/tty` read in the middle. Nothing can
   * renew a lease during that - the terminal read blocks the event loop, so a
   * timer is not an option - and the write that follows would then be refused
   * for a lease that lapsed while the operator was doing exactly what they were
   * asked to.
   *
   * Reclaiming one's own lapsed lease is safe here and nowhere else: the caller
   * still holds the exclusive runner lock for the life of the command, so no
   * other runner could have legitimately taken the session. If the process
   * actually died the lock is gone with it, and ordinary cross-process takeover
   * applies unchanged. A session whose owner has changed is refused outright.
   */
  holdLease(id: string, ownerId: string): DeploySession {
    const session = this.store.get(id);
    if (!session) throw new Error(`DEPLOY_SESSION_NOT_FOUND: ${id}`);
    if (session.ownerId !== ownerId) throw new Error("DEPLOY_SESSION_NOT_OWNER");
    return Date.parse(session.leaseExpiresAt) > this.clock().getTime()
      ? this.renewLease(id, ownerId)
      : this.takeOverExpiredLease(id, ownerId);
  }

  yieldLease(id: string, ownerId: string): void {
    this.store.yieldLease(id, ownerId, this.clock());
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
  completeTarget(id: string, ownerId: string, observation: DeploymentObservation): DeploySession {
    const observed = this.observeTopology(id, ownerId, observation);
    if (observed.bootstrapRollbackId) throw new Error("BOOTSTRAP_ROLLBACK_RESERVED");
    // Settled only against what the session is deploying now.
    if (!runtimeIsTarget(observation.runtime, this.binding(id).targetSha)) throw new Error("TARGET_TOPOLOGY_NOT_CONVERGED");
    if (observed.mode === "MAINTENANCE_CUTOVER" && observed.rollbackAuthority !== "NEW_LINEAGE_ONLY") {
      throw new Error("MAINTENANCE_CUTOVER_EXTERNAL_EFFECTS_NOT_ARMED");
    }
    return this.store.settle(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], "SUCCEEDED");
  }

  /**
   * Production was put back, in both layers. Only legal while the old lineage
   * is still a truthful destination.
   *
   * The pointer is compared too: a runtime on the old commits with the ref
   * still naming the new one is a rollback that the next ordinary deploy would
   * undo, and calling that ROLLED_BACK would open sales on it.
   */
  completeRollback(id: string, ownerId: string, observation: DeploymentObservation): DeploySession {
    const session = this.owned(id, ownerId);
    if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new Error("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    if (!session.preDeployTopology || !snapshotEquals(observation, session.preDeployTopology)) throw new Error("ROLLBACK_TOPOLOGY_NOT_CONVERGED");
    assertSnapshot(observation);
    this.store.recordTopology(id, ownerId, this.clock(), "OBSERVED", observation);
    return this.store.settle(id, ownerId, this.clock(), ["DEPLOYING", "RECOVERY_REQUIRED"], "ROLLED_BACK");
  }

  /**
   * Reads a session without claiming it. Deciding whether a caller is even
   * continuing the right release is not an act of ownership, and demanding a
   * live lease to answer that question would mean recording an observation
   * against a session we are about to refuse.
   */
  read(id: string): DeploySession | undefined {
    return this.store.get(id);
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
