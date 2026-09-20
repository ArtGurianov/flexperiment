import {
  assessCutoverAdoption, type CutoverEnvelope, type CutoverEnvelopeStore,
} from "./cutover-envelope";
import {
  topologyEquals, type DeploySession, type DeploySessions, type ReleaseAuthorityStore,
} from "./deploy-session";
import type { SchemaLineage } from "./schema-identity";

/**
 * The launch cutover crosses a lineage boundary, and the two halves cannot share
 * a transaction: the envelope lives on the filesystem, the session lives in the
 * successor's database. So the protocol is ordered rather than atomic, and the
 * ordering is the safety property.
 *
 * Predecessor, in this order: fence sales with the old runtime's own emergency
 * gate, quiesce writers, take the final census and the online backup, obtain the
 * archive's immutable ref and digest, and only then write the envelope. Dying
 * before the envelope exists leaves the old lineage wholly recoverable and the
 * successor holding nothing.
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

/**
 * What must match for a leftover envelope to be the same handoff as a session
 * already committed. A cutover id alone is not enough: an id can be reused, and
 * the whole point of the check is to tell a resumed handoff apart from a
 * different one that happens to collide.
 */
const identityMismatch = (session: DeploySession, envelope: CutoverEnvelope): string | undefined => {
  if (session.targetSha !== envelope.targetSha) return "targetSha";
  if (session.mode !== envelope.mode) return "mode";
  if (!session.preDeployTopology || !topologyEquals(session.preDeployTopology, envelope.preDeployTopology)) return "preDeployTopology";
  if (session.predecessorDatabaseRef !== envelope.predecessorDatabase.ref) return "predecessorDatabase.ref";
  if (session.predecessorDatabaseSha256 !== envelope.predecessorDatabase.sha256) return "predecessorDatabase.sha256";
  return undefined;
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
  const existing = store.findByAdoptedCutover(cutoverId);
  if (existing) {
    const mismatch = identityMismatch(existing, envelope);
    // A mismatch is corruption, not something to reconcile: two different
    // handoffs claim one cutover id, and guessing which is authoritative is
    // exactly the decision no automated recovery should make.
    if (mismatch) throw new CutoverHandoffError("CUTOVER_ADOPTION_IDENTITY_MISMATCH", mismatch);
    // Expiry deliberately does not apply here. The adoption already happened,
    // in time; a runner that crashed and came back late must not be told the
    // envelope expired and leave the filesystem half dangling forever.
    if (!envelopes.isConsumed(cutoverId)) envelopes.markConsumed(cutoverId);
    return { session: existing, reconciled: true };
  }

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
  }, envelope.preDeployTopology);

  envelopes.markConsumed(cutoverId);
  return { session, reconciled: false };
};
