import type Database from "better-sqlite3";
import {
  CatalogueAuthorityError, type CatalogueMutationLedger, type CertificationCatalogueCommand,
} from "./catalogue-authority";
import type { OccurrenceView } from "./evidence";
import { directionAtLeast, sameCommand, type CertificationRunStore } from "./run";

/**
 * What a catalogue command already did, durably.
 *
 * The in-memory ledger lives as long as the process, which is precisely the
 * lifetime that does not matter: the failure this exists for is a runner that
 * died between performing a command and recording it. `0002` gives the record
 * the same durability as the run it belongs to.
 */
export class SqliteCatalogueMutationLedger implements CatalogueMutationLedger {
  constructor(private readonly db: Database.Database, private readonly runId: string) {}

  find(idempotencyKey: string): OccurrenceView | undefined {
    const row = this.db.prepare("SELECT run_id, occurrence_json FROM certification_catalogue_mutations WHERE idempotency_key = ?")
      .get(idempotencyKey) as { run_id: string; occurrence_json: string } | undefined;
    if (!row) return undefined;
    // A key belonging to another run is not this run's result. Returning it
    // would let one certification read another's catalogue as its own.
    if (row.run_id !== this.runId) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_KEY_FOREIGN_RUN", idempotencyKey);
    return JSON.parse(row.occurrence_json) as OccurrenceView;
  }

  record(idempotencyKey: string, occurrence: OccurrenceView, kind?: CertificationCatalogueCommand["kind"]): void {
    this.db.prepare(`INSERT INTO certification_catalogue_mutations(idempotency_key, run_id, command_kind, occurrence_id, occurrence_json)
      VALUES (?, ?, ?, ?, ?)`)
      .run(idempotencyKey, this.runId, kind ?? "CREATE_OCCURRENCE", occurrence.id, JSON.stringify(occurrence));
  }
}

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
 */
export class SqliteCertificationCatalogueAuthority {
  constructor(
    private readonly db: Database.Database,
    private readonly runs: CertificationRunStore,
  ) {}

  admit(runId: string, command: CertificationCatalogueCommand, perform: () => OccurrenceView): OccurrenceView {
    const work = this.db.transaction(() => {
      const ledger = new SqliteCatalogueMutationLedger(this.db, runId);
      const existing = ledger.find(command.idempotencyKey);
      // A repeat returns what the key already did. It must not mutate again:
      // the catalogue is production's, and a second occurrence is one nobody
      // asked for.
      if (existing) return existing;

      const run = this.runs.load(runId);
      if (!run) throw new CatalogueAuthorityError("CERTIFICATION_RUN_NOT_FOUND", runId);
      // Not "a command like this one": the exact command the run is holding. A
      // straggler whose intent has since been retired is no longer armed.
      if (!sameCommand(run.pendingCommand, command)) throw new CatalogueAuthorityError("CERTIFICATION_COMMAND_NOT_ARMED", command.kind);
      if (directionAtLeast(run.direction, "CLEANUP_STARTED")) throw new CatalogueAuthorityError("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN", run.direction);

      const occurrence = perform();
      ledger.record(command.idempotencyKey, occurrence, command.kind);
      return occurrence;
    });
    return this.db.inTransaction ? work() : work.immediate();
  }

  resultFor(idempotencyKey: string): OccurrenceView | undefined {
    const row = this.db.prepare("SELECT occurrence_json FROM certification_catalogue_mutations WHERE idempotency_key = ?")
      .get(idempotencyKey) as { occurrence_json: string } | undefined;
    return row ? JSON.parse(row.occurrence_json) as OccurrenceView : undefined;
  }
}
