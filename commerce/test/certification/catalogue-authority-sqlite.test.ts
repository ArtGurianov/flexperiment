import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { migrate } from "../../src/db";
import type { CertificationCatalogueCommand } from "../../src/certification/catalogue-authority";
import { SqliteCertificationCatalogueAuthority } from "../../src/certification/catalogue-authority-sqlite";
import type { CertificationRun, CertificationRunStore } from "../../src/certification/run";
import { SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { OccurrenceView } from "../../src/certification/evidence";

/**
 * The production catalogue authority admits, mutates and records in one
 * transaction. The reference performs the command and then records it, and
 * between those two a dying process leaves an occurrence in the production
 * catalogue that nothing can attribute - during a cutover, with sales about to
 * reopen.
 */

const SHA = "a".repeat(40);
const startedAt = "2026-09-20T12:00:00.000Z";
const occurrence: OccurrenceView = { id: "occ", title: "Certification", visibility: "HIDDEN", sales_status: "CLOSED" };
const create: CertificationCatalogueCommand = { kind: "CREATE_OCCURRENCE", idempotencyKey: "key-1", draft: {
  cityId: "city", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z",
  venueDisclosureText: "Announced later", venueAnnounceBy: "2026-09-25T00:00:00.000Z",
} };

let db: Database.Database;
let runs: CertificationRunStore;
let authority: SqliteCertificationCatalogueAuthority;

const seed = (over: Partial<CertificationRun> = {}) => runs.create({
  runId: "run", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt,
  pendingCommand: create, ...over,
});

/** Stands in for the catalogue: a real write the authority's transaction owns. */
const mutate = (id = "occ") => () => {
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'Certification city')").run(id, id);
  return { ...occurrence, id };
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  runs = new SqliteCertificationRunStore(db);
  authority = new SqliteCertificationCatalogueAuthority(db, runs);
});

describe("admitting a catalogue command", () => {
  it("performs an armed command once and answers a repeat from the record", () => {
    seed();
    let performed = 0;
    const perform = () => { performed += 1; return mutate()(); };

    expect(authority.admit("run", create, perform)).toEqual(occurrence);
    expect(authority.admit("run", create, perform)).toEqual(occurrence);

    // A run whose response was lost must learn the occurrence it made, not make
    // a second one in the production catalogue.
    expect(performed).toBe(1);
    expect(authority.resultFor("key-1")).toEqual(occurrence);
  });

  it("commits the mutation and the record together, or neither", () => {
    // The whole point. If the ledger write failed after the catalogue write
    // committed, there would be an occurrence nothing can attribute to a run.
    seed();
    expect(() => authority.admit("run", create, () => {
      db.prepare("INSERT INTO cities(id, slug, title) VALUES ('occ', 'occ', 'Certification city')").run();
      throw new Error("LEDGER_WRITE_FAILED");
    })).toThrow("LEDGER_WRITE_FAILED");

    expect(db.prepare("SELECT id FROM cities WHERE id = 'occ'").get()).toBeUndefined();
    expect(authority.resultFor("key-1")).toBeUndefined();
  });

  it("offers no asynchronous entry point at all", () => {
    // An `await` in the middle of this would be the same gap with a different
    // spelling: better-sqlite3 transactions cannot span one.
    const source = readFileSync("commerce/src/certification/catalogue-authority-sqlite.ts", "utf8");
    expect(source).not.toContain("async ");
    expect(source).not.toContain("await ");
    expect(source).toMatch(/admit\([^)]*perform: \(\) => OccurrenceView\): OccurrenceView/);
  });

  it("refuses a command the run is not holding", () => {
    // Not "a command like this one": a straggler whose intent has since been
    // retired is no longer armed.
    seed({ pendingCommand: { ...create, idempotencyKey: "other-key" } });
    expect(() => authority.admit("run", create, mutate())).toThrow("CERTIFICATION_COMMAND_NOT_ARMED");
    expect(authority.resultFor("key-1")).toBeUndefined();
  });

  it("refuses a catalogue that has turned to cleanup", () => {
    seed({ direction: "CLEANUP_STARTED" });
    expect(() => authority.admit("run", create, mutate())).toThrow("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
  });

  it("refuses a run that does not exist", () => {
    expect(() => authority.admit("absent", create, mutate())).toThrow("CERTIFICATION_RUN_NOT_FOUND");
  });
});

describe("what only a durable ledger can say", () => {
  it("survives the process that performed the command", () => {
    // The failure this exists for is a runner that died between performing a
    // command and remembering it. An in-memory ledger's lifetime is exactly the
    // one that does not help.
    seed();
    authority.admit("run", create, mutate());

    const reopened = new SqliteCertificationCatalogueAuthority(db, new SqliteCertificationRunStore(db));
    expect(reopened.resultFor("key-1")).toEqual(occurrence);
  });

  it("will not hand one run the catalogue another run's key made", () => {
    seed();
    authority.admit("run", create, mutate());
    runs.create({ runId: "other", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt, pendingCommand: create });

    expect(() => authority.admit("other", create, mutate("other-occ")))
      .toThrow("CERTIFICATION_CATALOGUE_KEY_FOREIGN_RUN");
  });

  it("refuses to rewrite or erase what a key already did", () => {
    seed();
    authority.admit("run", create, mutate());

    // Rewriting it would let a replay be answered with a different past than
    // the one the key actually produced.
    expect(() => db.prepare("UPDATE certification_catalogue_mutations SET occurrence_id = 'other' WHERE idempotency_key = 'key-1'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM certification_catalogue_mutations WHERE idempotency_key = 'key-1'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
  });
});
