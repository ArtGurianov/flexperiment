import { randomUUID } from "node:crypto";
import { createCutoverEnvelope, type CutoverEnvelope, type PredecessorDatabase } from "./cutover-envelope";
import { snapshotEquals, type DeploymentObservation } from "./deploy-session";
import { isSourceCommit } from "./runtime-identity";

/**
 * The predecessor half of the launch handoff.
 *
 * Its whole purpose is to make one statement true: once the forward envelope
 * exists, the successor holds a self-sufficient and proven snapshot of the
 * predecessor. Until it exists, the lineage has not been handed over at all and
 * the old side remains wholly recoverable. The filesystem move is deliberately
 * not one of those proofs: it happens only after the envelope is durable.
 *
 * Everything the envelope vouches for happens before it; once it exists the
 * physical tail is an idempotent, fail-closed completion of that exact intent.
 */

export class CutoverPreparationError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface PredecessorSalesFence {
  ensureClosed(): Promise<void>;
  isClosed(): Promise<boolean>;
}

export interface WriterQuiescer {
  ensureQuiesced(): Promise<void>;
}

export interface FinalCensus {
  inspect(): Promise<{
    readonly admitted: boolean;
    readonly blockers: readonly string[];
    readonly evidenceDigest: string;
  }>;
}

/**
 * Named for what it must deliver, not what it runs. A backup command returning
 * success is not evidence; the contract above it receives an immutable
 * `{ ref, sha256 }` that something has already proved restorable.
 */
export interface PredecessorDatabaseArchiver {
  /**
   * Two independently verified online backups, while the predecessor is still
   * running. They are a pre-stop restore probe, not the archive handed to the
   * successor.
   */
  verifyOnlineBackups(cutoverId: string): Promise<void>;
  /**
   * Runs only after writers are quiet. It checkpoints the live SQLite bundle
   * and returns the archive identity it is prepared to move, but does not move
   * it yet: the envelope must become durable first.
   */
  prepareArchive(cutoverId: string): Promise<PredecessorDatabase>;
  /**
   * Completes an envelope that already exists. This is deliberately an ensure,
   * so a retry after the durable-envelope/before-rename crash resumes the
   * physical handoff instead of treating the old database as a fresh cutover.
   */
  ensureArchivedAndFresh(envelope: CutoverEnvelope): Promise<void>;
}

export interface CutoverEnvelopeWriter {
  read(cutoverId: string): Promise<CutoverEnvelope | undefined>;
  writeOnce(envelope: CutoverEnvelope): Promise<void>;
}

export type PreparationPorts = {
  readonly fence: PredecessorSalesFence;
  readonly quiescer: WriterQuiescer;
  readonly census: FinalCensus;
  readonly archiver: PredecessorDatabaseArchiver;
  readonly topology: { observe(): Promise<DeploymentObservation> };
  readonly envelopes: CutoverEnvelopeWriter;
  readonly clock?: () => Date;
};

export type PreparationRequest = {
  readonly targetSha: string;
  readonly expiresAt: string;
  readonly cutoverId?: string;
  readonly adoptionNonce?: string;
};

export type PreparationResult = {
  readonly envelope: CutoverEnvelope;
  /** True when a previous attempt already published this exact envelope. */
  readonly alreadyPrepared: boolean;
};

export class BootstrapCutoverPreparation {
  constructor(private readonly ports: PreparationPorts) {}

  /**
   * Nothing is reopened on failure. A census blocker, a failed archive or a
   * drifted topology all leave sales closed: an availability failure, but an
   * unambiguous one. Resuming is a repeat of this call; abandoning the cutover
   * is an operator's decision made outside this protocol.
   */
  async prepare(request: PreparationRequest): Promise<PreparationResult> {
    const now = (this.ports.clock ?? (() => new Date()))();
    if (!isSourceCommit(request.targetSha)) throw new CutoverPreparationError("CUTOVER_TARGET_SHA_INVALID", request.targetSha);
    if (Date.parse(request.expiresAt) <= now.getTime()) throw new CutoverPreparationError("CUTOVER_ENVELOPE_EXPIRY_INVALID", request.expiresAt);

    const cutoverId = request.cutoverId ?? randomUUID();

    // Checked before any side effect, because the crash worth surviving is
    // "the envelope was written and the runner died before hearing so". A
    // retry must not census and archive the predecessor a second time.
    //
    // Compared against the request, not a reconstructed envelope: what is being
    // asked is whether this is the same preparation, and that is exactly the
    // three inputs a caller supplies. The nonce is only checked when one was
    // given - a plain retry that omits it is still the same intent, and minting
    // a fresh one before this point made that ordinary case fail as a mismatch.
    const existing = await this.ports.envelopes.read(cutoverId);
    if (existing) {
      const sameIntent = existing.targetSha === request.targetSha
        && existing.expiresAt === request.expiresAt
        && (request.adoptionNonce === undefined || existing.adoptionNonce === request.adoptionNonce);
      if (!sameIntent) throw new CutoverPreparationError("CUTOVER_ENVELOPE_IDENTITY_MISMATCH", cutoverId);
      // The envelope is durable intent, not proof the rename finished. A crash
      // in the next line of a previous run must resume through the same
      // quiescence boundary before the old database can be moved.
      await this.ports.fence.ensureClosed();
      await this.ports.quiescer.ensureQuiesced();
      await this.ports.archiver.ensureArchivedAndFresh(existing);
      return { envelope: existing, alreadyPrepared: true };
    }

    const adoptionNonce = request.adoptionNonce ?? randomUUID();

    await this.ports.fence.ensureClosed();
    const beforeQuiesce = await this.ports.topology.observe();
    await this.ports.archiver.verifyOnlineBackups(cutoverId);
    // Once the real runtime is stopped there is intentionally no `/readyz` or
    // instance evidence left to read. Compare the two live observations before
    // that boundary instead; after it, quiescence plus the checkpointed SQLite
    // archive is the proof that no writer can move the frozen predecessor.
    const beforeStop = await this.ports.topology.observe();
    if (!snapshotEquals(beforeQuiesce, beforeStop)) throw new CutoverPreparationError("PREDECESSOR_TOPOLOGY_DRIFTED");
    await this.ports.quiescer.ensureQuiesced();

    const census = await this.ports.census.inspect();
    if (!census.admitted) throw new CutoverPreparationError("FINAL_CENSUS_BLOCKED", census.blockers.join(","));

    const predecessorDatabase = await this.ports.archiver.prepareArchive(cutoverId);

    // Archiving takes time, and the gate could have been opened during it. A
    // backup taken behind a gate that is now open is not the quiet snapshot it
    // is about to be treated as.
    if (!(await this.ports.fence.isClosed())) throw new CutoverPreparationError("PREDECESSOR_GATE_NOT_CLOSED");

    const envelope = createCutoverEnvelope({
      cutoverId, adoptionNonce,
      targetSha: request.targetSha,
      // A bootstrap launch is a maintenance cutover by definition; there is no
      // rolling variant of replacing the database, so no caller may ask for one.
      mode: "MAINTENANCE_CUTOVER",
      preDeployTopology: beforeStop,
      predecessorDatabase,
      createdAt: now.toISOString(),
      expiresAt: request.expiresAt,
    });
    await this.ports.envelopes.writeOnce(envelope);
    // This must stay after writeOnce. The archive name and digest have been
    // frozen in an fsync'd envelope before the irreversible filesystem rename.
    await this.ports.archiver.ensureArchivedAndFresh(envelope);
    return { envelope, alreadyPrepared: false };
  }
}
