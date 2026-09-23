import { createHash } from "node:crypto";
import { canonicalEnvelopeSha256, type CutoverEnvelopeStore } from "./cutover-envelope";
import type { DeploySession, DeploymentObservation, PreDeploySnapshot, ReleaseAuthorityStore } from "./deploy-session";
import { snapshotEquals } from "./deploy-session";
import type { RuntimeLeaseGrant } from "./runtime-quiescer";

/**
 * Cross-lineage rollback cannot keep its recovery cursor in commerce.sqlite:
 * the operation deliberately replaces that database with the predecessor.
 * This receipt is therefore the durable authority once recovery begins. The
 * successor session remains RECOVERY_REQUIRED in the immutable failure
 * archive; pretending to settle that non-canonical row would create two truths.
 */

export type DatabaseArchive = { readonly ref: string; readonly sha256: string };

/**
 * Which durable fact authorises this restore.
 *
 * `prepare-bootstrap` crosses the destructive boundary before a successor
 * session exists, so the state it produces - envelope durable, predecessor
 * archived, launch database installed, nothing adopted - has no session to
 * name. Recording the authority instead of always naming a session is what
 * lets that state be recovered without inventing a session that never existed.
 * A synthetic one would assert an adoption that did not happen, and adoption is
 * precisely the thing being denied.
 */
export type BootstrapRollbackAuthority =
  | { readonly kind: "SUCCESSOR_SESSION"; readonly sessionId: string }
  | { readonly kind: "PREPARED_CUTOVER"; readonly cutoverId: string };

export type BootstrapRollbackIntent = {
  readonly rollbackId: string;
  readonly cutoverId: string;
  readonly authority: BootstrapRollbackAuthority;
  readonly targetSha: string;
  readonly forwardEnvelopeSha256: string;
  readonly predecessorDatabase: DatabaseArchive;
  readonly preDeployTopology: PreDeploySnapshot;
  readonly createdAt: string;
};

export type BootstrapRollbackStage =
  | "RESERVED"
  | "DATABASE_RESTORED"
  | "REF_RESTORED"
  | "FRONTEND_RESTORED"
  | "ADMIN_RESTORED"
  | "COMMERCE_RESTORED"
  | "VERIFIED"
  | "COMPLETED";

export type BootstrapRollbackReceipt = {
  readonly intent: BootstrapRollbackIntent;
  readonly stage: BootstrapRollbackStage;
  readonly successorDatabase?: DatabaseArchive;
  readonly observation?: DeploymentObservation;
};

export const BOOTSTRAP_ROLLBACK_STAGES: readonly BootstrapRollbackStage[] = [
  "RESERVED", "DATABASE_RESTORED", "REF_RESTORED", "FRONTEND_RESTORED",
  "ADMIN_RESTORED", "COMMERCE_RESTORED", "VERIFIED", "COMPLETED",
];

export const bootstrapRollbackId = (sessionId: string): string =>
  `rollback-${createHash("sha256").update(sessionId).digest("hex")}`;

/**
 * Distinct namespace, deliberately. A prepared restore and a session restore
 * must never be able to address the same receipt: they answer to different
 * authorities, and one silently resuming the other's durable intent is exactly
 * the confusion this split exists to prevent.
 */
export const preparedRollbackId = (cutoverId: string): string =>
  `rollback-prepared-${createHash("sha256").update(cutoverId).digest("hex")}`;

export const canonicalRollbackReceiptSha256 = (receipt: BootstrapRollbackReceipt): string =>
  createHash("sha256").update(JSON.stringify(receipt)).digest("hex");

export class BootstrapRollbackError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface BootstrapRollbackReceiptStore {
  read(rollbackId: string): BootstrapRollbackReceipt | undefined;
  write(receipt: BootstrapRollbackReceipt): void;
  advance(
    rollbackId: string,
    stage: BootstrapRollbackStage,
    evidence?: Pick<BootstrapRollbackReceipt, "successorDatabase" | "observation">,
  ): BootstrapRollbackReceipt;
}

export class InMemoryBootstrapRollbackReceiptStore implements BootstrapRollbackReceiptStore {
  #receipts = new Map<string, BootstrapRollbackReceipt>();

  read(rollbackId: string): BootstrapRollbackReceipt | undefined { return this.#receipts.get(rollbackId); }

  write(receipt: BootstrapRollbackReceipt): void {
    if (this.#receipts.has(receipt.intent.rollbackId)) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_EXISTS");
    this.#receipts.set(receipt.intent.rollbackId, receipt);
  }

  advance(
    rollbackId: string,
    stage: BootstrapRollbackStage,
    evidence: Pick<BootstrapRollbackReceipt, "successorDatabase" | "observation"> = {},
  ): BootstrapRollbackReceipt {
    const receipt = this.#receipts.get(rollbackId);
    if (!receipt) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_NOT_FOUND", rollbackId);
    const from = BOOTSTRAP_ROLLBACK_STAGES.indexOf(receipt.stage);
    const to = BOOTSTRAP_ROLLBACK_STAGES.indexOf(stage);
    if (to < from) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_REGRESSION", `${receipt.stage} -> ${stage}`);
    if (to > from + 1) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_SKIP", `${receipt.stage} -> ${stage}`);
    if (to === from) return receipt;
    const next = { ...receipt, ...evidence, stage };
    this.#receipts.set(rollbackId, next);
    return next;
  }
}

export const assertReversible = (session: DeploySession, gate: { closed: boolean; deploymentSessionId: string | null }): void => {
  if (!session.adoptedCutoverId) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_NOT_A_CUTOVER_SESSION", session.id);
  if (session.mode !== "MAINTENANCE_CUTOVER") throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_REQUIRES_MAINTENANCE_CUTOVER");
  if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new BootstrapRollbackError("OLD_LINEAGE_ROLLBACK_FORBIDDEN", session.id);
  if (!session.preDeployTopology) throw new BootstrapRollbackError("PRE_DEPLOY_TOPOLOGY_REQUIRED", session.id);
  if (!session.predecessorDatabaseRef || !session.predecessorDatabaseSha256 || !session.adoptedEnvelopeSha256) {
    throw new BootstrapRollbackError("PREDECESSOR_ARCHIVE_IDENTITY_INCOMPLETE", session.id);
  }
  if (!gate.closed || gate.deploymentSessionId !== session.id) throw new BootstrapRollbackError("DEPLOYMENT_GATE_NOT_OWNED", session.id);
};

export interface BootstrapRollbackStorage {
  inspectPredecessorArchive(archive: DatabaseArchive): DatabaseArchive;
  restore(rollbackId: string, archive: DatabaseArchive, grant: RuntimeLeaseGrant): Promise<{
    readonly successorDatabase: DatabaseArchive;
    readonly predecessorDatabase: DatabaseArchive;
  }>;
}

export interface BootstrapRollbackRuntime {
  /**
   * Quiesces the Compose runtime this restore is about to replace under.
   *
   * `quiesceSha` is what the units are expected to be carrying, and the two
   * authorities disagree about it. A session rollback stops the deployed
   * target. A prepared rollback has no target: preparation already stopped the
   * predecessor, and binding to the target made the restore impossible -
   * TRUSTED_COMPOSE_IMAGE_SHA_MISMATCH against containers that were never at
   * that commit. `expectStopped` says which of those two worlds this is, so a
   * runtime found running where it should be stopped is drift, not something
   * to quietly stop.
   */
  acquire(rollbackId: string, quiesceSha: string, expectStopped: boolean): Promise<RuntimeLeaseGrant>;
  applicationIsAt(name: "frontend" | "admin" | "commerce", sha: string): Promise<boolean>;
  restoreApplication(name: "frontend" | "admin" | "commerce", sha: string): Promise<void>;
}

export type BootstrapRollbackPorts = {
  readonly authority: ReleaseAuthorityStore;
  readonly envelopes: CutoverEnvelopeStore;
  readonly receipts: BootstrapRollbackReceiptStore;
  readonly storage: BootstrapRollbackStorage;
  readonly runtime: BootstrapRollbackRuntime;
  readonly refs: { read(): Promise<string>; compareAndSet(expected: string, target: string): Promise<string> };
  readonly verification: { observe(): Promise<{ readonly topology: DeploymentObservation; readonly lineage: string }> };
  readonly predecessorGate: { isClosed(): Promise<boolean>; open(): Promise<void> };
  /**
   * The lineage of the database that is live right now.
   *
   * Separate from `verification.observe()`, which reads the predecessor once it
   * is back and needs a running runtime to do it. A prepared rollback has to
   * establish what it is starting from while the runtime is still quiesced, and
   * the only question it can answer then is which schema is installed.
   */
  readonly lineage: () => string;
  readonly clock?: () => Date;
};

const exactEnvelope = (session: DeploySession, envelope: NonNullable<ReturnType<CutoverEnvelopeStore["read"]>>): void => {
  if (envelope.cutoverId !== session.adoptedCutoverId) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_IDENTITY_MISMATCH");
  if (canonicalEnvelopeSha256(envelope) !== session.adoptedEnvelopeSha256) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_DIGEST_MISMATCH");
  if (envelope.targetSha !== session.targetSha) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_TARGET_MISMATCH");
  if (envelope.mode !== session.mode) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_MODE_MISMATCH");
  if (!session.preDeployTopology || !snapshotEquals(envelope.preDeployTopology, session.preDeployTopology)) {
    throw new BootstrapRollbackError("CUTOVER_ENVELOPE_TOPOLOGY_MISMATCH");
  }
  if (envelope.predecessorDatabase.ref !== session.predecessorDatabaseRef
    || envelope.predecessorDatabase.sha256 !== session.predecessorDatabaseSha256) {
    throw new BootstrapRollbackError("CUTOVER_ENVELOPE_PREDECESSOR_MISMATCH");
  }
};

const predecessorSha = (intent: BootstrapRollbackIntent): string => {
  const values = new Set([
    ...Object.values(intent.preDeployTopology.runtime),
    intent.preDeployTopology.controlPlane.productionDeployRefSha,
  ]);
  if (values.size !== 1) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_PREDECESSOR_TOPOLOGY_NOT_UNIFORM");
  return [...values][0]!;
};

/** One operator invocation performs no retries; another invocation resumes the same durable receipt. */
export class BootstrapRollback {
  constructor(private readonly ports: BootstrapRollbackPorts) {}

  isStarted(sessionId: string): boolean {
    try {
      if (this.ports.receipts.read(bootstrapRollbackId(sessionId))) return true;
    } catch {
      // An unreadable external receipt is not evidence that recovery never
      // started. Treat it as started so the CLI leaves the gate closed and
      // reports RECOVERY_REQUIRED rather than a pre-mutation refusal.
      return true;
    }
    return Boolean(this.ports.authority.get(sessionId)?.bootstrapRollbackId);
  }

  /** True once a prepared restore has durable intent, however it then failed. */
  isPreparedStarted(cutoverId: string): boolean {
    try {
      return Boolean(this.ports.receipts.read(preparedRollbackId(cutoverId)));
    } catch {
      // As above: unreadable is not evidence that nothing started.
      return true;
    }
  }

  /**
   * Restores the predecessor from a prepared cutover that was never adopted.
   *
   * This is the owner of the state `prepare-bootstrap` leaves behind when the
   * deploy that should have followed never created a session: envelope
   * durable, predecessor archived, launch database installed, sales fenced.
   * `rollback` cannot serve it - that command's authority is a successor
   * session, and here there is deliberately none.
   */
  async rollbackPrepared(cutoverId: string): Promise<BootstrapRollbackReceipt> {
    let receipt = this.ports.receipts.read(preparedRollbackId(cutoverId));
    if (!receipt) receipt = await this.reservePrepared(cutoverId);
    if (receipt.intent.authority.kind !== "PREPARED_CUTOVER" || receipt.intent.authority.cutoverId !== cutoverId) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_AUTHORITY_MISMATCH", cutoverId);
    }
    return this.execute(receipt);
  }

  async rollback(sessionId: string, ownerId: string): Promise<BootstrapRollbackReceipt> {
    let receipt = this.ports.receipts.read(bootstrapRollbackId(sessionId));
    if (!receipt) receipt = this.reserve(sessionId, ownerId);
    if (receipt.intent.authority.kind !== "SUCCESSOR_SESSION" || receipt.intent.authority.sessionId !== sessionId) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_SESSION_MISMATCH");
    }
    return this.execute(receipt);
  }

  /**
   * The physical restore, shared by both authorities.
   *
   * Only the durable intent differs between them; every irreversible step below
   * - archive proof, database swap, ref lease, application restoration,
   * verification and the gate - is one engine, so a prepared restore cannot
   * drift into being a second implementation that merely resembles this one.
   */
  private async execute(receipt: BootstrapRollbackReceipt): Promise<BootstrapRollbackReceipt> {
    this.assertDurableIntent(receipt);
    receipt = this.reconcileReserved(receipt);

    const oldSha = predecessorSha(receipt.intent);
    if (receipt.stage === "RESERVED") {
      const prepared = receipt.intent.authority.kind === "PREPARED_CUTOVER";
      const grant = await this.ports.runtime.acquire(
        receipt.intent.rollbackId,
        prepared ? oldSha : receipt.intent.targetSha,
        prepared,
      );
      const restored = await this.ports.storage.restore(receipt.intent.rollbackId, receipt.intent.predecessorDatabase, grant);
      if (restored.predecessorDatabase.sha256 !== receipt.intent.predecessorDatabase.sha256) {
        throw new BootstrapRollbackError("PREDECESSOR_DATABASE_DIGEST_MISMATCH");
      }
      receipt = this.ports.receipts.advance(receipt.intent.rollbackId, "DATABASE_RESTORED", {
        successorDatabase: restored.successorDatabase,
      });
    }

    if (receipt.stage === "DATABASE_RESTORED") {
      const current = await this.ports.refs.read();
      if (current === receipt.intent.targetSha) {
        await this.ports.refs.compareAndSet(receipt.intent.targetSha, oldSha);
      } else if (current !== oldSha) {
        throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_REF_CAS_CONFLICT", `found ${current}`);
      }
      receipt = this.ports.receipts.advance(receipt.intent.rollbackId, "REF_RESTORED");
    }

    receipt = await this.restoreApplication(receipt, "REF_RESTORED", "frontend", "FRONTEND_RESTORED", oldSha);
    receipt = await this.restoreApplication(receipt, "FRONTEND_RESTORED", "admin", "ADMIN_RESTORED", oldSha);
    receipt = await this.restoreApplication(receipt, "ADMIN_RESTORED", "commerce", "COMMERCE_RESTORED", oldSha);

    if (receipt.stage === "COMMERCE_RESTORED") {
      this.ports.storage.inspectPredecessorArchive(receipt.intent.predecessorDatabase);
      const observed = await this.ports.verification.observe();
      if (observed.lineage !== "LEGACY") throw new BootstrapRollbackError("PREDECESSOR_LINEAGE_NOT_RESTORED", observed.lineage);
      if (!snapshotEquals(observed.topology, receipt.intent.preDeployTopology)) {
        throw new BootstrapRollbackError("PREDECESSOR_TOPOLOGY_NOT_RESTORED");
      }
      if (!(await this.ports.predecessorGate.isClosed())) throw new BootstrapRollbackError("PREDECESSOR_GATE_ALREADY_OPEN");
      receipt = this.ports.receipts.advance(receipt.intent.rollbackId, "VERIFIED", { observation: observed.topology });
    }

    if (receipt.stage === "VERIFIED") {
      // COMPLETED is terminal external authority after the successor database
      // stops being canonical. It therefore has to be the final durable write:
      // a crash before or during the gate mutation leaves VERIFIED, which a
      // retry can reconcile without repeating storage, ref or Coolify work.
      if (await this.ports.predecessorGate.isClosed()) await this.ports.predecessorGate.open();
      if (await this.ports.predecessorGate.isClosed()) {
        throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_GATE_NOT_OPEN_AFTER_RECONCILE");
      }
      receipt = this.completeRollback(receipt);
      return receipt;
    }
    if (receipt.stage === "COMPLETED") {
      // A retry after the terminal receipt was flushed but before the process
      // returned may report exit 11 only after re-proving both terminal facts.
      this.assertFreshObservation(receipt);
      if (await this.ports.predecessorGate.isClosed()) {
        throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_COMPLETED_GATE_CLOSED");
      }
    }
    return receipt;
  }

  private reserve(sessionId: string, ownerId: string): BootstrapRollbackReceipt {
    const session = this.ports.authority.get(sessionId);
    if (!session) throw new BootstrapRollbackError("DEPLOY_SESSION_NOT_FOUND", sessionId);
    assertReversible(session, this.ports.authority.deploymentGate());
    const envelope = this.ports.envelopes.read(session.adoptedCutoverId!);
    if (!envelope) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_FOUND", session.adoptedCutoverId);
    if (!this.ports.envelopes.isConsumed(envelope.cutoverId)) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_CONSUMED");
    exactEnvelope(session, envelope);
    const predecessor = this.ports.storage.inspectPredecessorArchive(envelope.predecessorDatabase);
    const rollbackId = bootstrapRollbackId(session.id);

    this.ports.authority.reserveBootstrapRollback(session.id, ownerId, (this.ports.clock ?? (() => new Date()))(), rollbackId);
    const receipt: BootstrapRollbackReceipt = {
      stage: "RESERVED",
      intent: {
        rollbackId,
        cutoverId: envelope.cutoverId,
        authority: { kind: "SUCCESSOR_SESSION", sessionId: session.id },
        targetSha: envelope.targetSha,
        forwardEnvelopeSha256: canonicalEnvelopeSha256(envelope),
        predecessorDatabase: predecessor,
        preDeployTopology: envelope.preDeployTopology,
        createdAt: (this.ports.clock ?? (() => new Date()))().toISOString(),
      },
    };
    try {
      this.ports.receipts.write(receipt);
    } catch (error) {
      const existing = this.ports.receipts.read(rollbackId);
      if (!existing || canonicalRollbackReceiptSha256(existing) !== canonicalRollbackReceiptSha256(receipt)) throw error;
      return existing;
    }
    return receipt;
  }

  /**
   * Reserves a restore for a prepared cutover nothing ever adopted.
   *
   * Everything here is proved before a single byte moves, and deliberately
   * without consulting the envelope's expiry: expiry is an admission condition
   * for going FORWARD. It cannot revoke the ability to put the predecessor
   * back, or a cutover left overnight would become unrecoverable by the clock.
   */
  private async reservePrepared(cutoverId: string): Promise<BootstrapRollbackReceipt> {
    const envelope = this.ports.envelopes.read(cutoverId);
    if (!envelope) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_FOUND", cutoverId);
    // Consumption and adoption are the successor's marks. Either one means this
    // cutover belongs to a session, and racing that session's own rollback is
    // the one thing this command must never do.
    if (this.ports.envelopes.isConsumed(cutoverId)) {
      throw new BootstrapRollbackError("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION", `${cutoverId} is consumed; use rollback <session>`);
    }
    const adopted = this.ports.authority.findByAdoptedCutover(cutoverId);
    if (adopted) {
      throw new BootstrapRollbackError("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION", `${cutoverId} is adopted by session ${adopted.id}; use rollback <session>`);
    }
    const gate = this.ports.authority.deploymentGate();
    if (gate.deploymentSessionId !== null) {
      throw new BootstrapRollbackError("PREPARED_ROLLBACK_SUCCESSOR_GATE_OWNED", gate.deploymentSessionId);
    }
    // The database standing here must be the one the preparation installed. An
    // unknown third state is not something to restore over.
    const lineage = this.ports.lineage();
    if (lineage !== "SUPPORTED") throw new BootstrapRollbackError("PREPARED_ROLLBACK_SUCCESSOR_NOT_INSTALLED", lineage);

    const predecessor = this.ports.storage.inspectPredecessorArchive(envelope.predecessorDatabase);
    const rollbackId = preparedRollbackId(cutoverId);
    const intent: BootstrapRollbackIntent = {
      rollbackId,
      cutoverId,
      authority: { kind: "PREPARED_CUTOVER", cutoverId },
      targetSha: envelope.targetSha,
      forwardEnvelopeSha256: canonicalEnvelopeSha256(envelope),
      predecessorDatabase: predecessor,
      preDeployTopology: envelope.preDeployTopology,
      createdAt: (this.ports.clock ?? (() => new Date()))().toISOString(),
    };
    // Throws when the frozen vector is not uniform, before anything is written.
    predecessorSha(intent);
    // Nothing adopted this cutover, so the deploy pointer cannot legitimately
    // have left the predecessor. A ref that moved anyway is state this command
    // did not produce and must not silently overwrite.
    const frozen = predecessorSha(intent);
    const ref = await this.ports.refs.read();
    if (ref !== frozen) throw new BootstrapRollbackError("PREPARED_ROLLBACK_REF_MOVED", `expected ${frozen}, found ${ref}`);

    const receipt: BootstrapRollbackReceipt = { stage: "RESERVED", intent };
    try {
      this.ports.receipts.write(receipt);
    } catch (error) {
      const existing = this.ports.receipts.read(rollbackId);
      if (!existing || canonicalRollbackReceiptSha256(existing) !== canonicalRollbackReceiptSha256(receipt)) throw error;
      return existing;
    }
    return receipt;
  }

  /**
   * A RESERVED receipt is not permission to run the RESERVED step.
   *
   * It records intent, not that storage is still where it was when the intent
   * was written. Between invocations the database may have crossed: a process
   * that died after the atomic restore but before advancing the receipt leaves
   * RESERVED over a database that is already the predecessor. Replaying the
   * swap there would archive the predecessor as though it were the successor.
   *
   * So the stage is reconciled against the live lineage before it is acted on.
   * SUPPORTED means storage has not crossed and RESERVED is honest. LEGACY with
   * the exact predecessor in place means it has, and the receipt is advanced to
   * match reality rather than replayed against it. Anything else is a database
   * this restore cannot account for, and is refused.
   */
  private reconcileReserved(receipt: BootstrapRollbackReceipt): BootstrapRollbackReceipt {
    if (receipt.stage !== "RESERVED") return receipt;
    const lineage = this.ports.lineage();
    if (lineage === "SUPPORTED") return receipt;
    if (lineage !== "LEGACY") throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_LINEAGE_UNACCOUNTED", lineage);
    // The predecessor is already standing. Its identity is re-proved from the
    // immutable archive before the receipt is allowed to agree.
    this.ports.storage.inspectPredecessorArchive(receipt.intent.predecessorDatabase);
    return this.ports.receipts.advance(receipt.intent.rollbackId, "DATABASE_RESTORED");
  }

  private assertDurableIntent(receipt: BootstrapRollbackReceipt): void {
    const envelope = this.ports.envelopes.read(receipt.intent.cutoverId);
    if (!envelope) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_FOUND", receipt.intent.cutoverId);
    // Each authority re-proves its own precondition on every retry. A prepared
    // restore that found its envelope consumed mid-flight has had a successor
    // appear underneath it, and must stop rather than keep restoring.
    const consumed = this.ports.envelopes.isConsumed(envelope.cutoverId);
    if (receipt.intent.authority.kind === "SUCCESSOR_SESSION" && !consumed) {
      throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_CONSUMED");
    }
    if (receipt.intent.authority.kind === "PREPARED_CUTOVER" && consumed) {
      throw new BootstrapRollbackError("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION", envelope.cutoverId);
    }
    if (canonicalEnvelopeSha256(envelope) !== receipt.intent.forwardEnvelopeSha256
      || envelope.targetSha !== receipt.intent.targetSha
      || envelope.predecessorDatabase.ref !== receipt.intent.predecessorDatabase.ref
      || envelope.predecessorDatabase.sha256 !== receipt.intent.predecessorDatabase.sha256
      || !snapshotEquals(envelope.preDeployTopology, receipt.intent.preDeployTopology)) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_FORWARD_ENVELOPE_MISMATCH");
    }
    // Must precede quiescence on every retry. A missing/corrupt recovery source
    // may not stop production just because a receipt was written earlier.
    this.ports.storage.inspectPredecessorArchive(receipt.intent.predecessorDatabase);
  }

  private async restoreApplication(
    receipt: BootstrapRollbackReceipt,
    from: BootstrapRollbackStage,
    application: "frontend" | "admin" | "commerce",
    to: BootstrapRollbackStage,
    sha: string,
  ): Promise<BootstrapRollbackReceipt> {
    if (receipt.stage !== from) return receipt;
    if (!(await this.ports.runtime.applicationIsAt(application, sha))) {
      await this.ports.runtime.restoreApplication(application, sha);
      if (!(await this.ports.runtime.applicationIsAt(application, sha))) {
        throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_APPLICATION_NOT_CONVERGED", application);
      }
    }
    return this.ports.receipts.advance(receipt.intent.rollbackId, to);
  }

  private completeRollback(receipt: BootstrapRollbackReceipt): BootstrapRollbackReceipt {
    this.assertFreshObservation(receipt);
    return this.ports.receipts.advance(receipt.intent.rollbackId, "COMPLETED");
  }

  private assertFreshObservation(receipt: BootstrapRollbackReceipt): void {
    if (!receipt.observation || !snapshotEquals(receipt.observation, receipt.intent.preDeployTopology)) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_FRESH_OBSERVATION_REQUIRED");
    }
  }
}
