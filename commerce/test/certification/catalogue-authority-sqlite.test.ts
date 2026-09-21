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
    expect(authority.resultFor("run", "CREATE_OCCURRENCE")).toEqual(occurrence);
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
    expect(authority.resultFor("run", "CREATE_OCCURRENCE")).toBeUndefined();
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
    expect(authority.resultFor("run", "CREATE_OCCURRENCE")).toBeUndefined();
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
    expect(reopened.resultFor("run", "CREATE_OCCURRENCE")).toEqual(occurrence);
  });

  it("keeps each run's catalogue to itself", () => {
    seed();
    authority.admit("run", create, mutate());
    runs.create({ runId: "other", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt, pendingCommand: create });

    // A different run performing its own create is legitimate, and it gets its
    // own row rather than this one's result.
    expect(authority.admit("other", create, mutate("other-occ")).id).toBe("other-occ");
    expect(authority.resultFor("run", "CREATE_OCCURRENCE")?.id).toBe("occ");
  });

  it("refuses to rewrite or erase what a key already did", () => {
    seed();
    authority.admit("run", create, mutate());

    // Rewriting it would let a replay be answered with a different past than
    // the one the key actually produced.
    expect(() => db.prepare("UPDATE certification_catalogue_mutations SET occurrence_id = 'other' WHERE run_id = 'run'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM certification_catalogue_mutations WHERE run_id = 'run'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
  });
});

describe("one run, one occurrence, in order", () => {
  const publish = (occurrenceId: string, key: string) =>
    ({ kind: "PUBLISH_OCCURRENCE" as const, idempotencyKey: key, occurrenceId, expectedRevision: 1 });
  const open = (occurrenceId: string, key: string) =>
    ({ kind: "OPEN_SALES" as const, idempotencyKey: key, occurrenceId, expectedRevision: 2 });
  /**
   * Clear, then arm - which is what the run really does, because the baseline
   * refuses to swap one armed command for another in place. The test writes
   * directly rather than through the machine on purpose: the server's
   * cardinality must not depend on a well-behaved client.
   */
  const arm = (command: { kind: string }) => {
    runs.update("run", runs.load("run")!.revision, { pendingCommand: null });
    runs.update("run", runs.load("run")!.revision, { pendingCommand: command as never });
  };

  it("refuses a second create under a fresh command id", () => {
    // The case a client-supplied key cannot catch: both requests are formally
    // new, and the second would put a second certification occurrence in the
    // production catalogue and orphan the first.
    seed();
    authority.admit("run", create, mutate());

    const again = { ...create, idempotencyKey: "command-B" };
    arm(again);

    expect(authority.admit("run", again, mutate("second-occ"))).toEqual(occurrence);
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_catalogue_mutations WHERE run_id = 'run'").get())
      .toEqual({ n: 1 });
    expect(db.prepare("SELECT id FROM cities WHERE id = 'second-occ'").get()).toBeUndefined();
  });

  it("refuses to publish before anything was created", () => {
    // Out of order is not a slower path to the same place: an occurrence
    // published before it was created is one this run never made.
    const command = publish("occ", "command-B");
    seed({ pendingCommand: command });
    expect(() => authority.admit("run", command, mutate())).toThrow("CERTIFICATION_CATALOGUE_OUT_OF_ORDER");
  });

  it("refuses to open sales before publication", () => {
    seed();
    authority.admit("run", create, mutate());
    const command = open("occ", "command-C");
    arm(command);
    expect(() => authority.admit("run", command, () => occurrence)).toThrow("CERTIFICATION_CATALOGUE_OUT_OF_ORDER");
  });

  it("refuses a publish pointed at an occurrence this run did not create", () => {
    // A command naming a different one is either a mistake or a real event
    // being pointed at.
    seed();
    authority.admit("run", create, mutate());
    const command = publish("someone-elses-event", "command-B");
    arm(command);
    expect(() => authority.admit("run", command, () => occurrence)).toThrow("CERTIFICATION_CATALOGUE_OCCURRENCE_DIVERGED");
  });

  it("runs the whole legal sequence once each, and reconciles every repeat", () => {
    seed();
    authority.admit("run", create, mutate());

    const published = { ...occurrence, visibility: "PUBLISHED" };
    const publishCommand = publish("occ", "command-B");
    arm(publishCommand);
    expect(authority.admit("run", publishCommand, () => published)).toEqual(published);

    const opened = { ...published, sales_status: "OPEN" };
    const openCommand = open("occ", "command-C");
    arm(openCommand);
    expect(authority.admit("run", openCommand, () => opened)).toEqual(opened);

    // Every repeat, under any key, reconciles to what this run already did.
    expect(authority.admit("run", { ...create, idempotencyKey: "fresh" }, mutate("no"))).toEqual(occurrence);
    expect(authority.admit("run", publish("occ", "fresh"), () => ({ ...published, title: "changed" }))).toEqual(published);
    expect(authority.admit("run", open("occ", "fresh"), () => ({ ...opened, title: "changed" }))).toEqual(opened);
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_catalogue_mutations WHERE run_id = 'run'").get())
      .toEqual({ n: 3 });
  });

  it("derives the admin command key from the run and the kind, never from the caller", () => {
    expect(SqliteCertificationCatalogueAuthority.commandKey("run", "CREATE_OCCURRENCE"))
      .toBe("certification:run:CREATE_OCCURRENCE");
    // Same hole one layer down: a fresh caller key must not open a second
    // admin command for an operation this run already performed.
    expect(SqliteCertificationCatalogueAuthority.commandKey("run", "CREATE_OCCURRENCE"))
      .toBe(SqliteCertificationCatalogueAuthority.commandKey("run", "CREATE_OCCURRENCE"));
  });
});
