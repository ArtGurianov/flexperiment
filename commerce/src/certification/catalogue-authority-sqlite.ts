import type Database from "better-sqlite3";
import { CatalogueAuthorityError, type CertificationCatalogueCommand } from "./catalogue-authority";
import type { OccurrenceView } from "./evidence";
import { directionAtLeast, sameCommand, type CertificationRunStore } from "./run";

/**
 * The production catalogue authority: admission, mutation and record in one
 * `BEGIN IMMEDIATE`.
 *
 * The reference performs the command and then records what it did. Between
 * those two, a dying process leaves an occurrence in the production catalogue
 * that nothing can attribute to any run - during a cutover, with sales about to
 * reopen. So `perform` here is synchronous and runs inside the transaction that
 * writes the ledger, and there is deliberately no asynchronous entry point: an
 * `await` in the middle of this would be the same gap with a different spelling.
 *
 * The identity of a command is `(run_id, kind)`, decided here, not the key the
 * caller sent. A client key makes a repeated request safe and says nothing
 * about a fresh key asking for the same operation again - which would create a
 * second certification occurrence and orphan the first. Order is the database's
 * too: create, then publish, then open.
 */

/**
 * Shutting a certification fixture is a convergence, not an armed business
 * command: a run that failed anywhere still has to be able to close what it
 * made. So these are admitted on the run's recorded direction rather than on a
 * pending command, and they are recorded under the same `(run_id, kind)`
 * identity as everything else.
 */
export type CleanupKind = "CLOSE_SALES" | "HIDE_OCCURRENCE";
export type LedgerKind = CertificationCatalogueCommand["kind"] | CleanupKind;

export type LedgerEntry = { readonly occurrence: OccurrenceView; readonly commandId: string };

export class SqliteCatalogueMutationLedger {
  constructor(private readonly db: Database.Database, private readonly runId: string) {}

  find(kind: LedgerKind): LedgerEntry | undefined {
    const row = this.db.prepare("SELECT command_id, occurrence_json FROM certification_catalogue_mutations WHERE run_id = ? AND command_kind = ?")
      .get(this.runId, kind) as { command_id: string; occurrence_json: string } | undefined;
    return row ? { occurrence: JSON.parse(row.occurrence_json) as OccurrenceView, commandId: row.command_id } : undefined;
  }

  /** The occurrence this run is working on, once it has created one. */
  occurrenceId(): string | undefined {
    const row = this.db.prepare("SELECT occurrence_id FROM certification_catalogue_mutations WHERE run_id = ? AND command_kind = 'CREATE_OCCURRENCE'")
      .get(this.runId) as { occurrence_id: string } | undefined;
    return row?.occurrence_id;
  }

  record(kind: LedgerKind, commandId: string, occurrence: OccurrenceView): void {
    this.db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(this.runId, kind, commandId, occurrence.id, JSON.stringify(occurrence));
  }
}

export class SqliteCertificationCatalogueAuthority {
  constructor(
    private readonly db: Database.Database,
    private readonly runs: CertificationRunStore,
  ) {}

  /**
   * The admin command's key, derived rather than accepted.
   *
   * Passing the caller's key through would let a fresh one open a second admin
   * command for an operation this run has already performed, which is the same
   * hole one layer down.
   */
  static commandKey(runId: string, kind: LedgerKind): string {
    return `certification:${runId}:${kind}`;
  }

  admit(runId: string, command: CertificationCatalogueCommand, perform: () => OccurrenceView): OccurrenceView {
    const work = this.db.transaction(() => {
      const ledger = new SqliteCatalogueMutationLedger(this.db, runId);
      const existing = ledger.find(command.kind);
      // A repeat reconciles to what this run already did, whatever key it came
      // with. It must not mutate again: the catalogue is production's, and a
      // second occurrence is one nobody asked for.
      if (existing) return existing.occurrence;

      const run = this.runs.load(runId);
      if (!run) throw new CatalogueAuthorityError("CERTIFICATION_RUN_NOT_FOUND", runId);
      // Not "a command like this one": the exact command the run is holding. A
      // straggler whose intent has since been retired is no longer armed.
      if (!sameCommand(run.pendingCommand, command)) throw new CatalogueAuthorityError("CERTIFICATION_COMMAND_NOT_ARMED", command.kind);
      if (directionAtLeast(run.direction, "CLEANUP_STARTED")) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN", run.direction);

      // Publication and opening act on the occurrence this run created, and on
      // no other. A command naming a different one is either a mistake or a
      // real event being pointed at.
      if (command.kind !== "CREATE_OCCURRENCE") {
        const created = ledger.occurrenceId();
        if (!created) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_OUT_OF_ORDER", command.kind);
        if (command.occurrenceId !== created) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_OCCURRENCE_DIVERGED", command.occurrenceId);
      }

      const occurrence = perform();
      ledger.record(command.kind, command.idempotencyKey, occurrence);
      return occurrence;
    });
    return this.db.inTransaction ? work() : work.immediate();
  }

  /**
   * Shuts the run's fixture, once, whatever else happened to the run.
   *
   * Admitted on the recorded direction rather than on an armed command: by the
   * time a run is cleaning up it may have no pending command at all, and a
   * fixture that could not be closed because the run failed is exactly the one
   * that must be.
   */
  clean(runId: string, kind: CleanupKind, commandId: string, perform: (occurrenceId: string) => OccurrenceView): OccurrenceView {
    const work = this.db.transaction(() => {
      const ledger = new SqliteCatalogueMutationLedger(this.db, runId);
      const existing = ledger.find(kind);
      if (existing) return existing.occurrence;

      const run = this.runs.load(runId);
      if (!run) throw new CatalogueAuthorityError("CERTIFICATION_RUN_NOT_FOUND", runId);
      // The record says cleanup has begun before anything is shut, so a crash
      // in the middle leaves a run no later resume will decide to reopen.
      if (!directionAtLeast(run.direction, "CLEANUP_STARTED")) throw new CatalogueAuthorityError("CERTIFICATION_CLEANUP_NOT_ARMED", run.direction);
      const occurrenceId = ledger.occurrenceId();
      if (!occurrenceId) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_OUT_OF_ORDER", kind);

      const occurrence = perform(occurrenceId);
      ledger.record(kind, commandId, occurrence);
      return occurrence;
    });
    return this.db.inTransaction ? work() : work.immediate();
  }

  /** What this run has already done, by command kind. */
  resultFor(runId: string, kind: LedgerKind): OccurrenceView | undefined {
    return new SqliteCatalogueMutationLedger(this.db, runId).find(kind)?.occurrence;
  }
}
