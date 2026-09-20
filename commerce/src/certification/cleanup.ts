import type { OccurrenceView } from "./evidence";
import { enterCleanup, type CertificationRun, type CertificationRunStore } from "./run";

/**
 * Shutting the fixture, as a safety invariant rather than a repeated request.
 *
 * This deliberately does not go through the business-command machinery. A
 * business command must be re-issued exactly as it was armed, because its
 * effect is a specific historical act. Closing and hiding are the opposite:
 * what matters is the end state, so re-reading the occurrence's current
 * revision each time is correct, and the operation converges no matter how
 * many times it is interrupted.
 *
 * Giving cleanup the shape of a business command is what previously made
 * "which pending commands survive cleanup" an unanswerable question - the two
 * kinds of intent were stored the same way while meaning opposite things.
 *
 * The keys are derived from the run, not minted, so an interrupted close and
 * the close that follows it are the same request to the admin API.
 */
export const cleanupKey = (runId: string, step: "close-sales" | "hide-occurrence"): string => `cert:${runId}:${step}`;

export interface CatalogueCleanupPorts {
  occurrence(occurrenceId: string): Promise<OccurrenceView>;
  /**
   * What a catalogue command's key already did, without doing anything. A run
   * whose creation response was lost does not know the occurrence it may have
   * made; without this it would leave one nobody can find.
   */
  occurrenceForCommand(idempotencyKey: string): Promise<OccurrenceView | undefined>;
  patchOccurrence(occurrenceId: string, patch: Record<string, unknown>, expectedRevision: number, reason: string, idempotencyKey: string): Promise<OccurrenceView>;
  occurrenceIsPubliclyVisible(occurrenceId: string): Promise<boolean>;
  tourIncludes(occurrenceId: string): Promise<boolean>;
}

export class CatalogueCleanupError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CatalogueCleanupError"; }
}

/**
 * Arms the direction first, then converges the catalogue, then proves the
 * absence publicly before recording that it is clean.
 *
 * The order is the whole safety property: the record says cleanup has begun
 * before anything is destroyed, so a crash in the middle leaves a run that no
 * later resume will decide to reopen. And `CATALOGUE_CLEAN` is written only
 * after the public surfaces agree, so a run that merely asked for a close
 * cannot pass for one that achieved it.
 */
export const ensureCatalogueClean = async (
  store: CertificationRunStore,
  ports: CatalogueCleanupPorts,
  run: CertificationRun,
): Promise<CertificationRun> => {
  let current = await reconcileOccurrenceId(store, ports, enterCleanup(store, run));
  const occurrenceId = current.occurrenceId;
  if (!occurrenceId) {
    // Reconciliation proved the creation never landed, so there is nothing to
    // shut. Saying so is different from not knowing.
    return current.direction === "CATALOGUE_CLEAN" ? current : store.update(current.runId, current.revision, { direction: "CATALOGUE_CLEAN" });
  }
  const reason = `Production E2E certification ${current.runId}`;

  const sales = await ports.occurrence(occurrenceId);
  if (sales.sales_status !== "CLOSED") {
    await ports.patchOccurrence(occurrenceId, { sales_status: "CLOSED" }, requireRevision(sales), reason, cleanupKey(current.runId, "close-sales"));
  }

  const visibility = await ports.occurrence(occurrenceId);
  if (visibility.visibility !== "HIDDEN") {
    await ports.patchOccurrence(occurrenceId, { visibility: "HIDDEN" }, requireRevision(visibility), reason, cleanupKey(current.runId, "hide-occurrence"));
  }

  await assertCatalogueClean(ports, occurrenceId);
  if (current.direction !== "CATALOGUE_CLEAN") current = store.update(current.runId, current.revision, { direction: "CATALOGUE_CLEAN" });
  return current;
};

/**
 * Recovers the occurrence a lost creation response may have produced.
 *
 * The command carries its own key, and the server can say what that key
 * already did. Skipping this is how a failed run leaves a hidden orphan whose
 * id exists only in a response nobody received.
 */
export const reconcileOccurrenceId = async (
  store: CertificationRunStore,
  ports: CatalogueCleanupPorts,
  run: CertificationRun,
): Promise<CertificationRun> => {
  if (run.occurrenceId) return run;
  const pending = run.pendingCommand?.kind === "CREATE_OCCURRENCE" ? run.pendingCommand : undefined;
  const superseded = run.supersededCommand?.command.kind === "CREATE_OCCURRENCE" ? run.supersededCommand.command : undefined;
  const command = pending ?? superseded;
  if (!command) return run;

  const occurrence = await ports.occurrenceForCommand(command.idempotencyKey);
  return occurrence ? store.update(run.runId, run.revision, { occurrenceId: occurrence.id }) : run;
};

/** Read live, never from the record: an external reopen after a crash must be caught here. */
export const assertCatalogueClean = async (ports: CatalogueCleanupPorts, occurrenceId: string): Promise<void> => {
  const occurrence = await ports.occurrence(occurrenceId);
  if (occurrence.sales_status !== "CLOSED" || occurrence.visibility !== "HIDDEN") throw new CatalogueCleanupError("CERTIFICATION_CLEANUP_INCOMPLETE");
  if (await ports.occurrenceIsPubliclyVisible(occurrenceId)) throw new CatalogueCleanupError("CERTIFICATION_HIDDEN_OCCURRENCE_STILL_PUBLIC");
  if (await ports.tourIncludes(occurrenceId)) throw new CatalogueCleanupError("CERTIFICATION_HIDDEN_OCCURRENCE_STILL_IN_TOUR");
};

const requireRevision = (occurrence: OccurrenceView): number => {
  const revision = Number(occurrence.admin_revision);
  if (!Number.isSafeInteger(revision)) throw new CatalogueCleanupError("CERTIFICATION_CLEANUP_REVISION_INVALID");
  return revision;
};
