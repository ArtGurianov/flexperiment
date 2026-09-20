import { createHash, randomUUID } from "node:crypto";
import type { DeploySession, PreDeployTopology, ReleaseAuthorityStore } from "./deploy-session";
import { topologyEquals } from "./deploy-session";
import type { SchemaLineage } from "./schema-identity";

/**
 * Undoing the launch cutover is not the same operation as undoing an ordinary
 * deploy, and must not share its API.
 *
 * An ordinary rollback restores a topology while the authority that records it
 * stays where it is. This one replaces the database that authority lives in, so
 * writing ROLLED_BACK into `deploy_sessions` would either be impossible - the
 * row is gone - or worse, land in a successor database that is no longer
 * canonical and that the restored predecessor will never read. A rollback
 * cannot keep its only receipt inside the thing it is destroying.
 *
 * So the terminal fact lives outside `commerce.sqlite`, next to the forward
 * envelope, and `completeRollback()` stays what it always was: the same-lineage
 * ending for ordinary maintenance deploys.
 */

export type DatabaseArchive = {
  readonly ref: string;
  readonly sha256: string;
};

export type BootstrapRollbackEnvelope = {
  readonly rollbackId: string;
  readonly cutoverId: string;
  readonly successorSessionId: string;
  readonly predecessorDatabase: DatabaseArchive;
  readonly preDeployTopology: PreDeployTopology;
  /** The database about to be discarded, kept so the operation is symmetric with the forward handoff. */
  readonly successorDatabase: DatabaseArchive;
  readonly successorTopology: PreDeployTopology;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
};

/**
 * Monotonic markers rather than a state machine: each says one thing has
 * durably happened, and replay only ever needs to know how far the last attempt
 * got. RESTORED means the predecessor database and topology are back and
 * verified; COMPLETED means the rollback is finished and only the predecessor's
 * own emergency gate is still holding sales shut.
 */
export type BootstrapRollbackStage = "PREPARED" | "RESTORED" | "COMPLETED";

export type BootstrapRollbackReceipt = {
  readonly envelope: BootstrapRollbackEnvelope;
  readonly stage: BootstrapRollbackStage;
};

export const canonicalRollbackSha256 = (envelope: BootstrapRollbackEnvelope): string =>
  createHash("sha256").update(JSON.stringify([
    envelope.rollbackId, envelope.cutoverId, envelope.successorSessionId,
    envelope.predecessorDatabase.ref, envelope.predecessorDatabase.sha256,
    envelope.successorDatabase.ref, envelope.successorDatabase.sha256,
    Object.values(envelope.preDeployTopology), Object.values(envelope.successorTopology),
    envelope.createdAt, envelope.expiresAt, envelope.nonce,
  ])).digest("hex");

export class BootstrapRollbackError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const STAGE_ORDER: readonly BootstrapRollbackStage[] = ["PREPARED", "RESTORED", "COMPLETED"];

export interface BootstrapRollbackReceiptStore {
  read(rollbackId: string): BootstrapRollbackReceipt | undefined;
  /** Written once, before the successor database may be discarded. */
  write(receipt: BootstrapRollbackReceipt): void;
  /** Monotonic: a stage may advance, never regress. */
  advance(rollbackId: string, stage: BootstrapRollbackStage): BootstrapRollbackReceipt;
}

export class InMemoryBootstrapRollbackReceiptStore implements BootstrapRollbackReceiptStore {
  #receipts = new Map<string, BootstrapRollbackReceipt>();

  read(rollbackId: string): BootstrapRollbackReceipt | undefined { return this.#receipts.get(rollbackId); }

  write(receipt: BootstrapRollbackReceipt): void {
    if (this.#receipts.has(receipt.envelope.rollbackId)) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_EXISTS");
    this.#receipts.set(receipt.envelope.rollbackId, receipt);
  }

  advance(rollbackId: string, stage: BootstrapRollbackStage): BootstrapRollbackReceipt {
    const receipt = this.#receipts.get(rollbackId);
    if (!receipt) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_NOT_FOUND", rollbackId);
    const from = STAGE_ORDER.indexOf(receipt.stage);
    const to = STAGE_ORDER.indexOf(stage);
    if (to < from) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_REGRESSION", `${receipt.stage} -> ${stage}`);
    // Each stage is the proof the next one rests on, so skipping one would let
    // a caller record a finished rollback that never restored anything.
    if (to > from + 1) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_STAGE_SKIP", `${receipt.stage} -> ${stage}`);
    const next = { ...receipt, stage };
    this.#receipts.set(rollbackId, next);
    return next;
  }
}

/**
 * Whether this session may be reversed at all. Arming is the hard stop: once
 * external effects are committed the predecessor database no longer accounts
 * for what happened, so a reverse handoff must be impossible to even prepare -
 * not merely refused later by whoever executes it.
 */
export const assertReversible = (session: DeploySession, gate: { closed: boolean; deploymentSessionId: string | null }): void => {
  if (!session.adoptedCutoverId) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_NOT_A_CUTOVER_SESSION", session.id);
  if (session.mode !== "MAINTENANCE_CUTOVER") throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_REQUIRES_MAINTENANCE_CUTOVER");
  if (session.rollbackAuthority !== "OLD_LINEAGE_ALLOWED") throw new BootstrapRollbackError("OLD_LINEAGE_ROLLBACK_FORBIDDEN", session.id);
  if (!session.preDeployTopology) throw new BootstrapRollbackError("PRE_DEPLOY_TOPOLOGY_REQUIRED", session.id);
  if (!session.predecessorDatabaseRef || !session.predecessorDatabaseSha256) {
    throw new BootstrapRollbackError("PREDECESSOR_ARCHIVE_IDENTITY_INCOMPLETE", session.id);
  }
  if (!gate.closed || gate.deploymentSessionId !== session.id) {
    throw new BootstrapRollbackError("DEPLOYMENT_GATE_NOT_OWNED", session.id);
  }
};

/** Quiesces the successor and captures the database about to be discarded. */
export interface SuccessorArchiver {
  quiesceAndArchive(): Promise<DatabaseArchive>;
}

/**
 * Every operation is an `ensure`, and every one is idempotent. A crash can land
 * between any two of them, and a replay must be able to run the whole sequence
 * again without asking what the last attempt got through - "make it so" is
 * replayable, "do it" is not.
 */
export interface PredecessorRestorer {
  ensureSuccessorRuntimesStopped(): Promise<void>;
  ensurePredecessorDatabaseRestored(archive: DatabaseArchive): Promise<void>;
  ensurePreDeployTopologyRestored(topology: PreDeployTopology): Promise<void>;
  ensurePredecessorRuntimeRunning(): Promise<void>;
}

/**
 * Proof, independent of whoever performed the restore. A driver that both acts
 * and reports on itself can say the archive is back without it being back, and
 * the whole point of reading it separately is that nobody has to take its word.
 */
export interface DatabaseIdentityReader {
  /** Digest of the restored file, read before any writer starts and can change it. */
  restedFileSha256(): Promise<string>;
  /** Lineage of the running predecessor, once it is up. */
  runningLineage(): Promise<SchemaLineage>;
}

/** The predecessor's own operator gate, which the pre-cutover backup was taken behind. */
export interface PredecessorEmergencyGate {
  isClosed(): Promise<boolean>;
  open(): Promise<void>;
}

export type BootstrapRollbackPorts = {
  readonly receipts: BootstrapRollbackReceiptStore;
  readonly archiver: SuccessorArchiver;
  readonly restorer: PredecessorRestorer;
  readonly identity: DatabaseIdentityReader;
  readonly predecessorGate: PredecessorEmergencyGate;
  readonly topology: { observe(): Promise<PreDeployTopology> };
  readonly clock?: () => Date;
};

export class BootstrapRollback {
  constructor(private readonly ports: BootstrapRollbackPorts) {}

  /**
   * Everything that must survive the successor database is captured and written
   * down first. Only when the envelope is durable may that database be
   * discarded - a failure before this point leaves the successor untouched and
   * the rollback simply not started.
   */
  async prepare(authority: ReleaseAuthorityStore, sessionId: string, ownerId: string, input: {
    readonly rollbackId?: string;
    readonly nonce?: string;
    readonly expiresAt: string;
  }): Promise<BootstrapRollbackReceipt> {
    // Read here rather than accept a snapshot: a caller holding a session
    // captured before arming would otherwise pass the reversibility check with
    // an answer that stopped being true.
    // The caller's own identity, never the session's. Reading the owner out of
    // the row and then acting as it means any caller acts as whoever holds the
    // lease - including a runner that was displaced a moment ago.
    const session = authority.get(sessionId);
    if (!session) throw new BootstrapRollbackError("DEPLOY_SESSION_NOT_FOUND", sessionId);
    assertReversible(session, authority.deploymentGate());
    const now = (this.ports.clock ?? (() => new Date()))();
    if (Date.parse(input.expiresAt) <= now.getTime()) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_EXPIRY_INVALID", input.expiresAt);

    // Direction is chosen in the successor's own authority before that database
    // can be archived and lost. From here arming is refused, so no external
    // effect can appear behind a rollback that has already committed to
    // restoring the predecessor. A failure after this leaves a rollback intent
    // and sales closed - safe, resumable, and deliberately not cleared
    // automatically, since clearing it would reopen the very race it closes.
    const rollbackId = input.rollbackId ?? randomUUID();
    authority.reserveBootstrapRollback(sessionId, ownerId, now, rollbackId);

    const successorDatabase = await this.ports.archiver.quiesceAndArchive();
    if (!successorDatabase.ref.trim()) throw new BootstrapRollbackError("SUCCESSOR_ARCHIVE_REF_INVALID");
    if (!/^[a-f0-9]{64}$/.test(successorDatabase.sha256)) throw new BootstrapRollbackError("SUCCESSOR_ARCHIVE_DIGEST_INVALID");
    // Read after quiescing: the vector recorded is the one the successor was
    // actually serving when it stopped, not one observed earlier and hoped for.
    const successorTopology = await this.ports.topology.observe();

    const envelope: BootstrapRollbackEnvelope = {
      rollbackId,
      cutoverId: session.adoptedCutoverId!,
      successorSessionId: session.id,
      predecessorDatabase: { ref: session.predecessorDatabaseRef!, sha256: session.predecessorDatabaseSha256! },
      preDeployTopology: session.preDeployTopology!,
      successorDatabase,
      successorTopology,
      createdAt: now.toISOString(),
      expiresAt: input.expiresAt,
      nonce: input.nonce ?? randomUUID(),
    };
    // Archiving is a long external step, and a lease can lapse while it runs.
    // Re-prove ownership before writing anything durable outside the database,
    // or a displaced runner leaves a receipt the real owner never made.
    authority.assertBootstrapRollbackOwned(sessionId, ownerId, now, rollbackId);

    const receipt: BootstrapRollbackReceipt = { envelope, stage: "PREPARED" };
    this.ports.receipts.write(receipt);
    return receipt;
  }

  /**
   * Resumable by construction. Each stage is re-derived from the receipt, so a
   * crash anywhere replays from the last durable fact rather than from the
   * start - and a completed rollback never restores a database twice.
   */
  async execute(rollbackId: string, expected: BootstrapRollbackEnvelope): Promise<BootstrapRollbackReceipt> {
    const receipt = this.ports.receipts.read(rollbackId);
    if (!receipt) throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_RECEIPT_NOT_FOUND", rollbackId);
    if (canonicalRollbackSha256(receipt.envelope) !== canonicalRollbackSha256(expected)) {
      // Same id, different rollback. Choosing between them is not a decision
      // automated recovery may make.
      throw new BootstrapRollbackError("BOOTSTRAP_ROLLBACK_IDENTITY_MISMATCH", rollbackId);
    }

    let current = receipt;
    if (current.stage === "PREPARED") current = await this.restore(current);
    if (current.stage === "RESTORED") current = await this.complete(current);
    // Reopening is last and separately replayable: a crash between COMPLETED
    // and the reopen leaves "rolled back, sales still shut", which is safe and
    // finishable. The reverse order would open sales with no durable proof the
    // rollback ever finished.
    if (await this.ports.predecessorGate.isClosed()) await this.ports.predecessorGate.open();
    return current;
  }

  /**
   * RESTORED means the predecessor database and topology are in place and the
   * digest checked, and deliberately that nothing has been started yet. Marking
   * it after startup instead left a window where a crash would replay the
   * restore over a predecessor that was already running and writing.
   */
  private async restore(receipt: BootstrapRollbackReceipt): Promise<BootstrapRollbackReceipt> {
    const { envelope } = receipt;
    await this.ports.restorer.ensureSuccessorRuntimesStopped();

    // A replay may find the file already in place. Overwriting it blindly would
    // be a second restore nobody asked for, so the digest decides.
    if (await this.ports.identity.restedFileSha256() !== envelope.predecessorDatabase.sha256) {
      await this.ports.restorer.ensurePredecessorDatabaseRestored(envelope.predecessorDatabase);
      const restoredSha256 = await this.ports.identity.restedFileSha256();
      // Checked while nothing runs: once writers start, the file legitimately
      // diverges from the archive and this could never be checked again.
      if (restoredSha256 !== envelope.predecessorDatabase.sha256) {
        throw new BootstrapRollbackError("PREDECESSOR_DATABASE_DIGEST_MISMATCH", restoredSha256);
      }
    }

    await this.ports.restorer.ensurePreDeployTopologyRestored(envelope.preDeployTopology);
    return this.ports.receipts.advance(envelope.rollbackId, "RESTORED");
  }

  private async complete(receipt: BootstrapRollbackReceipt): Promise<BootstrapRollbackReceipt> {
    const { envelope } = receipt;
    await this.ports.restorer.ensurePredecessorRuntimeRunning();
    const lineage = await this.ports.identity.runningLineage();
    if (lineage !== "LEGACY") throw new BootstrapRollbackError("PREDECESSOR_LINEAGE_NOT_RESTORED", lineage);

    const topology = await this.ports.topology.observe();
    if (!topologyEquals(topology, envelope.preDeployTopology)) {
      throw new BootstrapRollbackError("PREDECESSOR_TOPOLOGY_NOT_RESTORED");
    }
    // The pre-cutover backup was taken behind this gate, so the restored
    // predecessor must come up still holding it. If it is already open,
    // something reopened sales without this rollback's consent.
    if (!(await this.ports.predecessorGate.isClosed())) throw new BootstrapRollbackError("PREDECESSOR_GATE_ALREADY_OPEN");

    return this.ports.receipts.advance(envelope.rollbackId, "COMPLETED");
  }
}
