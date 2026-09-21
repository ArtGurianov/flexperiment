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

export type BootstrapRollbackIntent = {
  readonly rollbackId: string;
  readonly cutoverId: string;
  readonly successorSessionId: string;
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
  acquire(rollbackId: string, targetSha: string): Promise<RuntimeLeaseGrant>;
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

  async rollback(sessionId: string, ownerId: string): Promise<BootstrapRollbackReceipt> {
    let receipt = this.ports.receipts.read(bootstrapRollbackId(sessionId));
    if (!receipt) receipt = this.reserve(sessionId, ownerId);
    if (receipt.intent.successorSessionId !== sessionId) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_SESSION_MISMATCH");
    this.assertDurableIntent(receipt);

    const oldSha = predecessorSha(receipt.intent);
    if (receipt.stage === "RESERVED") {
      const grant = await this.ports.runtime.acquire(receipt.intent.rollbackId, receipt.intent.targetSha);
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

    if (receipt.stage === "VERIFIED") receipt = this.completeRollback(receipt);
    if (receipt.stage === "COMPLETED" && await this.ports.predecessorGate.isClosed()) {
      await this.ports.predecessorGate.open();
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
        successorSessionId: session.id,
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

  private assertDurableIntent(receipt: BootstrapRollbackReceipt): void {
    const envelope = this.ports.envelopes.read(receipt.intent.cutoverId);
    if (!envelope) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_FOUND", receipt.intent.cutoverId);
    if (!this.ports.envelopes.isConsumed(envelope.cutoverId)) throw new BootstrapRollbackError("CUTOVER_ENVELOPE_NOT_CONSUMED");
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
    if (!receipt.observation || !snapshotEquals(receipt.observation, receipt.intent.preDeployTopology)) {
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_FRESH_OBSERVATION_REQUIRED");
    }
    return this.ports.receipts.advance(receipt.intent.rollbackId, "COMPLETED");
  }
}
