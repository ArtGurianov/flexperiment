import {
  assessCutoverAdoption, canonicalEnvelopeSha256, type CutoverEnvelopeStore,
} from "./cutover-envelope";
import type { DeploySession, DeploySessions, ReleaseAuthorityStore } from "./deploy-session";
import type { SchemaLineage } from "./schema-identity";

/**
 * The launch cutover crosses a lineage boundary, and the two halves cannot share
 * a transaction: the envelope lives on the filesystem, the session lives in the
 * successor's database. So the protocol is ordered rather than atomic, and the
 * ordering is the safety property.
 *
 * Predecessor, in this order: fence sales with the old runtime's own emergency
 * gate, take two online backups, quiesce writers, take the final census and
 * obtain the archive's immutable ref and digest. The envelope is written next,
 * durably; only then may the checked predecessor file be atomically renamed
 * to that ref. Dying before the envelope exists leaves the old lineage wholly
 * recoverable and the successor holding nothing.
 *
 * Successor: read, validate, adopt into the database, commit - and only then
 * mark the envelope consumed. Dying in that last gap is the case this module
 * exists for.
 */

export class CutoverHandoffError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AdoptionContext = {
  readonly ownerId: string;
  readonly sourceCommit: string;
  readonly schemaLineage: SchemaLineage;
  readonly adoptionNonce: string;
  readonly now: Date;
};

export type AdoptionResult = {
  readonly session: DeploySession;
  /** True when the session already existed and this call only finished the handoff. */
  readonly reconciled: boolean;
};


export const adoptCutover = (
  sessions: DeploySessions,
  store: ReleaseAuthorityStore,
  envelopes: CutoverEnvelopeStore,
  cutoverId: string,
  context: AdoptionContext,
): AdoptionResult => {
  const envelope = envelopes.read(cutoverId);
  if (!envelope) throw new CutoverHandoffError("CUTOVER_ENVELOPE_NOT_FOUND", cutoverId);

  // Look for a completed adoption first. If the database already committed, the
  // handoff happened; all that can be missing is the filesystem half.
  const digest = canonicalEnvelopeSha256(envelope);
  const existing = store.findByAdoptedCutover(cutoverId);
  if (existing) {
    // A mismatch is corruption, not something to reconcile: two different
    // handoffs claim one cutover id, and guessing which is authoritative is
    // exactly the decision no automated recovery should make.
    if (existing.adoptedEnvelopeSha256 !== digest) throw new CutoverHandoffError("CUTOVER_ADOPTION_IDENTITY_MISMATCH", cutoverId);
    // Expiry deliberately does not apply here. The adoption already happened,
    // in time; a runner that crashed and came back late must not be told the
    // envelope expired and leave the filesystem half dangling forever.
    if (!envelopes.isConsumed(cutoverId)) envelopes.markConsumed(cutoverId);
    return { session: existing, reconciled: true };
  }

  // Consumed means the database committed, by the protocol's own ordering. A
  // consumed envelope with no session is therefore not an invitation to adopt
  // again - it is a successor authority that has gone missing, and adopting a
  // second time would paper over the loss.
  if (envelopes.isConsumed(cutoverId)) throw new CutoverHandoffError("CUTOVER_ENVELOPE_CONSUMED_WITHOUT_ADOPTION", cutoverId);

  const refusal = assessCutoverAdoption(envelope, {
    sourceCommit: context.sourceCommit,
    schemaLineage: context.schemaLineage,
    deploySessionExists: store.deploymentGate().deploymentSessionId !== null,
    adoptionNonce: context.adoptionNonce,
    now: context.now,
  });
  if (refusal) throw new CutoverHandoffError(refusal, cutoverId);

  // The database side is one operation: session, active ownership, closed gate
  // and the adoption identity all commit together or not at all.
  const session = sessions.acquireFenced({
    ownerId: context.ownerId,
    mode: "MAINTENANCE_CUTOVER",
    targetSha: envelope.targetSha,
    adoptedCutoverId: envelope.cutoverId,
    predecessorDatabaseRef: envelope.predecessorDatabase.ref,
    predecessorDatabaseSha256: envelope.predecessorDatabase.sha256,
    adoptedEnvelopeSha256: digest,
  }, envelope.preDeployTopology);

  envelopes.markConsumed(cutoverId);
  return { session, reconciled: false };
};
