import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { InMemoryCertificationCatalogueAuthority, type CertificationCatalogueAuthority, type CertificationCatalogueCommand } from "../../src/certification/catalogue-authority";
import { SqliteCertificationCatalogueAuthority } from "../../src/certification/catalogue-authority-sqlite";
import { InMemoryCertificationRunStore, type CertificationRun, type CertificationRunStore } from "../../src/certification/run";
import { SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { OccurrenceView } from "../../src/certification/evidence";

const SHA = "a".repeat(40);
const startedAt = "2026-09-20T12:00:00.000Z";
const occurrence: OccurrenceView = { id: "occ", title: "Certification", visibility: "HIDDEN", sales_status: "CLOSED" };
const create: CertificationCatalogueCommand = { kind: "CREATE_OCCURRENCE", idempotencyKey: "key-1", draft: {
  cityId: "city", startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z",
  venueDisclosureText: "Announced later", venueAnnounceBy: "2026-09-25T00:00:00.000Z",
} };

type Fixture = { readonly authority: CertificationCatalogueAuthority; readonly runs: CertificationRunStore };

const seed = (runs: CertificationRunStore, over: Partial<CertificationRun> = {}) => runs.create({
  runId: "run", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt,
  pendingCommand: create, ...over,
});

const implementations: ReadonlyArray<readonly [string, () => Fixture]> = [
  ["in-memory", () => {
    const runs = new InMemoryCertificationRunStore();
    return { runs, authority: new InMemoryCertificationCatalogueAuthority(runs) };
  }],
  ["sqlite", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const runs = new SqliteCertificationRunStore(db);
    return { runs, authority: new SqliteCertificationCatalogueAuthority(db, runs) };
  }],
];

describe.each(implementations)("admitting a catalogue command (%s)", (_name, make) => {
  let fixture: Fixture;
  beforeEach(() => { fixture = make(); });

  it("performs an armed command once and answers a repeat from the record", async () => {
    seed(fixture.runs);
    let performed = 0;
    const perform = async () => { performed += 1; return occurrence; };

    expect(await fixture.authority.admit("run", create, perform)).toEqual(occurrence);
    expect(await fixture.authority.admit("run", create, perform)).toEqual(occurrence);

    // A run whose creation response was lost must learn the occurrence it made,
    // not make a second one in the production catalogue.
    expect(performed).toBe(1);
    expect(fixture.authority.resultFor("key-1")).toEqual(occurrence);
  });

  it("refuses a command the run is not holding", async () => {
    // Not "a command like this one": a straggler whose intent has since been
    // retired is no longer armed.
    seed(fixture.runs, { pendingCommand: { ...create, idempotencyKey: "other-key" } });
    await expect(fixture.authority.admit("run", create, async () => occurrence)).rejects.toThrow("CERTIFICATION_COMMAND_NOT_ARMED");
    expect(fixture.authority.resultFor("key-1")).toBeUndefined();
  });

  it("refuses a catalogue that has turned to cleanup", async () => {
    seed(fixture.runs, { direction: "CLEANUP_STARTED" });
    await expect(fixture.authority.admit("run", create, async () => occurrence)).rejects.toThrow("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
  });

  it("refuses a run that does not exist", async () => {
    await expect(fixture.authority.admit("absent", create, async () => occurrence)).rejects.toThrow("CERTIFICATION_RUN_NOT_FOUND");
  });

  it("records nothing when the catalogue refused the command", async () => {
    seed(fixture.runs);
    await expect(fixture.authority.admit("run", create, async () => { throw new Error("CATALOGUE_REFUSED"); }))
      .rejects.toThrow("CATALOGUE_REFUSED");
    // Nothing happened, so a retry has to be able to happen.
    expect(fixture.authority.resultFor("key-1")).toBeUndefined();
  });
});

describe("what only a durable ledger can say", () => {
  const sqlite = () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const runs = new SqliteCertificationRunStore(db);
    return { db, runs, authority: new SqliteCertificationCatalogueAuthority(db, runs) };
  };

  it("survives the process that performed the command", async () => {
    // The failure this exists for is a runner that died between performing a
    // command and remembering it. An in-memory ledger's lifetime is exactly the
    // one that does not help.
    const { db, runs, authority } = sqlite();
    seed(runs);
    await authority.admit("run", create, async () => occurrence);

    const reopened = new SqliteCertificationCatalogueAuthority(db, new SqliteCertificationRunStore(db));
    expect(reopened.resultFor("key-1")).toEqual(occurrence);
  });

  it("will not hand one run the catalogue another run's key made", async () => {
    const { db, runs, authority } = sqlite();
    seed(runs);
    await authority.admit("run", create, async () => occurrence);
    runs.create({ runId: "other", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt, pendingCommand: create });

    await expect(authority.admit("other", create, async () => occurrence))
      .rejects.toThrow("CERTIFICATION_CATALOGUE_KEY_FOREIGN_RUN");
  });

  it("refuses to rewrite or erase what a key already did", () => {
    const { db, runs } = sqlite();
    seed(runs);
    db.prepare(`INSERT INTO certification_catalogue_mutations(idempotency_key, run_id, command_kind, occurrence_id, occurrence_json)
      VALUES ('key-1', 'run', 'CREATE_OCCURRENCE', 'occ', '{"id":"occ"}')`).run();

    // Rewriting it would let a replay be answered with a different past than
    // the one the key actually produced.
    expect(() => db.prepare("UPDATE certification_catalogue_mutations SET occurrence_id = 'other' WHERE idempotency_key = 'key-1'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM certification_catalogue_mutations WHERE idempotency_key = 'key-1'").run())
      .toThrow("CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE");
  });
});
