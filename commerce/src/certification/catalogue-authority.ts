import type { OccurrenceView } from "./evidence";
import {
  directionAtLeast, sameCommand,
  type CertificationRunStore, type CreateOccurrenceCommand, type OpenSalesCommand, type PublishOccurrenceCommand,
} from "./run";

/**
 * The server-side boundary a certification catalogue command has to cross.
 *
 * Compare-and-set on the run protects the run. It does not protect production,
 * because by the time a command has been armed the request may already have
 * left the process - and a request that left before cleanup began can arrive
 * after it finished:
 *
 *   occurrence HIDDEN+CLOSED at revision 7
 *   PUBLISH(expectedRevision 7) dispatched, runner times out
 *   cleanup begins, finds nothing to close, records CATALOGUE_CLEAN
 *   the original PUBLISH finally executes, matches revision 7, succeeds
 *
 * The run then says clean and the catalogue says published. Nothing on the
 * runner's side can prevent this, and bumping the occurrence revision during
 * cleanup to invalidate the straggler would be a trick rather than a rule.
 *
 * So the server refuses it instead. Admission requires that the durable run
 * still names this exact command and has not turned to cleanup, and in P9 that
 * check and the mutation are one `BEGIN IMMEDIATE`:
 *
 *   resolve the admin-command idempotency key; existing -> return it
 *   load the certification run
 *   require run.pending_command == exactly this command
 *   require run.direction < CLEANUP_STARTED
 *   perform the occurrence compare-and-set
 *   record the idempotency result
 *   COMMIT
 *
 * Which of the two transactions commits first then decides the outcome, and
 * both outcomes are correct: either the command lands and cleanup afterwards
 * sees it and closes it, or cleanup lands and the straggler is refused.
 */
export type CertificationCatalogueCommand = CreateOccurrenceCommand | PublishOccurrenceCommand | OpenSalesCommand;

export class CatalogueAuthorityError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CatalogueAuthorityError";
  }
}

export interface CertificationCatalogueAuthority {
  /**
   * Admits one catalogue command for one run, or refuses it. `perform` runs
   * only if it was admitted, and its result is recorded against the command's
   * key so that re-issuing the command returns it rather than repeating it.
   */
  admit(runId: string, command: CertificationCatalogueCommand, perform: () => Promise<OccurrenceView>): Promise<OccurrenceView>;
  /**
   * What this key already did, without doing anything. This is how a run that
   * lost a response learns the occurrence it may have created, instead of
   * leaving an orphan nobody knows the id of.
   */
  resultFor(idempotencyKey: string): OccurrenceView | undefined;
}

export interface CatalogueMutationLedger {
  find(idempotencyKey: string): OccurrenceView | undefined;
  record(idempotencyKey: string, occurrence: OccurrenceView): void;
}

export class InMemoryCatalogueMutationLedger implements CatalogueMutationLedger {
  #results = new Map<string, OccurrenceView>();
  find(idempotencyKey: string): OccurrenceView | undefined { return this.#results.get(idempotencyKey); }
  record(idempotencyKey: string, occurrence: OccurrenceView): void { this.#results.set(idempotencyKey, occurrence); }
}

export class InMemoryCertificationCatalogueAuthority implements CertificationCatalogueAuthority {
  constructor(
    private readonly runs: CertificationRunStore,
    private readonly ledger: CatalogueMutationLedger = new InMemoryCatalogueMutationLedger(),
  ) {}

  async admit(runId: string, command: CertificationCatalogueCommand, perform: () => Promise<OccurrenceView>): Promise<OccurrenceView> {
    const existing = this.ledger.find(command.idempotencyKey);
    if (existing) return existing;

    const run = this.runs.load(runId);
    if (!run) throw new CatalogueAuthorityError("CERTIFICATION_RUN_NOT_FOUND", runId);
    // Not "a command like this one": the exact command the run is holding. A
    // straggler whose intent has since been retired is no longer armed.
    if (!sameCommand(run.pendingCommand, command)) throw new CatalogueAuthorityError("CERTIFICATION_COMMAND_NOT_ARMED", command.kind);
    if (directionAtLeast(run.direction, "CLEANUP_STARTED")) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN", run.direction);

    const occurrence = await perform();
    this.ledger.record(command.idempotencyKey, occurrence);
    return occurrence;
  }

  resultFor(idempotencyKey: string): OccurrenceView | undefined { return this.ledger.find(idempotencyKey); }
}
