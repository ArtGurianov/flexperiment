import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { LegacyPredecessorTopologyReader } from "../../src/release/legacy-predecessor-topology";
import { migrate } from "../../src/db";

/**
 * The predecessor bridge, against a database shaped exactly like the one a
 * cutover starts from.
 *
 * The real copy carries personal data and is never committed, so the fixture
 * below is built from what that copy actually contains: the 61-migration ledger
 * of `726dc412`, `runtime_release_evidence` with one row per unit, no
 * `schema_identity` and no `runtime_instance_evidence`. The names come from the
 * deployed tree rather than being invented.
 *
 * Two facts from the real copy drive the design and are asserted here:
 * commerce's row is written once at startup and never refreshed, while the
 * worker's is a heartbeat. Ageing them the same way would refuse a healthy
 * predecessor for having been up a while.
 */

const PREDECESSOR = "726dc412f62a726cc1f93a03b91de0834c4333e1";
const OTHER = "b".repeat(40);
const NOW = new Date("2026-09-21T03:10:00.000Z");
const LEDGER = execFileSync("git", ["ls-tree", "--name-only", "726dc412", "commerce/migrations/"], { encoding: "utf8" })
  .split("\n").filter(Boolean).map((path) => path.replace("commerce/migrations/", ""));

let db: Database.Database;

const legacyDatabase = () => {
  const fixture = new Database(":memory:");
  fixture.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE runtime_release_evidence (
      unit TEXT PRIMARY KEY, source_commit TEXT NOT NULL, started_at TEXT NOT NULL,
      observed_at TEXT NOT NULL, last_successful_sweep_at TEXT);`);
  const record = fixture.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  for (const version of LEDGER) record.run(version);
  const evidence = fixture.prepare(`INSERT INTO runtime_release_evidence(unit, source_commit, started_at, observed_at, last_successful_sweep_at)
    VALUES (?, ?, ?, ?, ?)`);
  // Exactly the shape the real copy holds.
  evidence.run("COMMERCE", PREDECESSOR, "2026-09-20T21:00:06Z", "2026-09-20T21:00:06Z", null);
  evidence.run("WORKER", PREDECESSOR, "2026-09-20T21:00:06Z", "2026-09-21T03:07:23Z", "2026-09-21T03:07:23Z");
  return fixture;
};

const answering = (sha = PREDECESSOR, ready = 200) => (async (url: string) =>
  String(url).includes("readyz")
    ? new Response("{}", { status: ready })
    : new Response(JSON.stringify({ source_commit: sha }), { status: 200 })) as unknown as typeof fetch;

const reader = (over: Partial<ConstructorParameters<typeof LegacyPredecessorTopologyReader>[0]> = {}) =>
  new LegacyPredecessorTopologyReader({
    frontendReleaseUrl: "https://flexperiment.invalid/release.json",
    adminReleaseUrl: "https://admin.flexperiment.invalid/release.json",
    commerceReadyUrl: "https://commerce.flexperiment.invalid/readyz",
    db, deployRef: { read: async () => PREDECESSOR },
    expectedPredecessorSha: PREDECESSOR, expectedLedgerLength: 61,
    fetch: answering(), now: () => NOW, ...over,
  });

beforeEach(() => { db = legacyDatabase(); });

describe("reading the predecessor a cutover starts from", () => {
  it("answers with four surfaces and the pointer", async () => {
    expect(await reader().observe()).toEqual({
      runtime: { frontend: PREDECESSOR, admin: PREDECESSOR, commerce: PREDECESSOR, worker: PREDECESSOR },
      controlPlane: { productionDeployRefSha: PREDECESSOR },
    });
  });

  it("is the only thing that can: the canonical reader cannot read this database at all", async () => {
    // This is why the bridge exists. `runtime_instance_evidence` arrives with
    // the launch baseline, so on the database a cutover starts from the
    // canonical reader throws - before the fence, on the first line.
    const { ProductionTopologyReader } = await import("../../src/release/topology-reader");
    const canonical = new ProductionTopologyReader({
      frontendReleaseUrl: "https://flexperiment.invalid/release.json",
      adminReleaseUrl: "https://admin.flexperiment.invalid/release.json",
      db, deployRef: { read: async () => PREDECESSOR }, fetch: answering(), now: () => NOW,
    });
    await expect(canonical.observe()).rejects.toThrow("no such table: runtime_instance_evidence");
  });

  it("refuses a unit that never recorded anything", async () => {
    db.prepare("DELETE FROM runtime_release_evidence WHERE unit = 'COMMERCE'").run();
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_UNIT_MISSING: COMMERCE");
  });

  it("refuses a worker whose heartbeat has stopped", async () => {
    // Here staleness is real evidence of a stopped worker: this row is a
    // heartbeat, refreshed as it sweeps.
    await expect(reader({ now: () => new Date("2026-09-21T05:00:00.000Z") }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_WORKER_STALE");
  });

  it("refuses a worker that has never completed a sweep", async () => {
    db.prepare("UPDATE runtime_release_evidence SET last_successful_sweep_at = NULL WHERE unit = 'WORKER'").run();
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_WORKER_NEVER_SWEPT");
  });

  it("does not age commerce's row, because it is a start record and not a heartbeat", async () => {
    // The real copy's commerce row was six hours old and the predecessor was
    // perfectly healthy. Ageing it would refuse a cutover for the crime of
    // having been up for a while.
    db.prepare("UPDATE runtime_release_evidence SET observed_at = '2026-09-01T00:00:00Z' WHERE unit = 'COMMERCE'").run();
    await expect(reader().observe()).resolves.toMatchObject({ runtime: { commerce: PREDECESSOR } });
  });

  it("proves commerce is up separately, without a credential", async () => {
    // Its row says which commit started, not that anything is still running.
    // The old runtime has no unauthenticated surface naming its commit, and its
    // admin evidence route sits behind a browser session this must not drive.
    await expect(reader({ fetch: answering(PREDECESSOR, 503) }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_COMMERCE_NOT_READY");
  });

  it("refuses when any surface or the pointer disagrees", async () => {
    db.prepare("UPDATE runtime_release_evidence SET source_commit = ? WHERE unit = 'WORKER'").run(OTHER);
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES: worker");

    db = legacyDatabase();
    await expect(reader({ deployRef: { read: async () => OTHER } }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES: deploy ref");

    db = legacyDatabase();
    await expect(reader({ fetch: answering(OTHER) }).observe())
      .rejects.toThrow("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES");
  });

  it("refuses a legacy database that is not this predecessor", async () => {
    // Bound to one reviewed commit: another legacy database is an operator
    // pointing a cutover at something nobody looked at.
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(LEDGER.at(-1));
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_LEDGER_UNEXPECTED: 60 migrations");
  });

  it("refuses a database that has already been launched", async () => {
    // Asking this reader after the cutover would hand back a frozen topology
    // for a lineage it knows nothing about.
    const launched = new Database(":memory:");
    launched.pragma("foreign_keys = ON");
    migrate(launched);
    db = launched;
    await expect(reader().observe()).rejects.toThrow(/LEGACY_PREDECESSOR_LINEAGE_NOT_LEGACY|LEGACY_PREDECESSOR_ALREADY_LAUNCHED/);
  });

  it("refuses a database carrying the launch evidence table", async () => {
    db.exec("CREATE TABLE runtime_instance_evidence (instance_id TEXT PRIMARY KEY)");
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_HAS_LAUNCH_EVIDENCE");
  });

  it("refuses a legacy database with no evidence at all", async () => {
    db.exec("DROP TABLE runtime_release_evidence");
    await expect(reader().observe()).rejects.toThrow("LEGACY_PREDECESSOR_HAS_NO_EVIDENCE");
  });

  it("writes nothing", async () => {
    // Read-only by construction: it never migrates and never records.
    const before = db.prepare("SELECT COUNT(*) AS n FROM runtime_release_evidence").get();
    await reader().observe();
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_release_evidence").get()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_identity'").get()).toBeUndefined();
  });

  it("restores the same frozen topology after a predecessor restart", async () => {
    // What a bootstrap rollback needs: the worker comes back, refreshes its
    // row, and the observation matches the snapshot the cutover froze.
    const frozen = await reader().observe();
    db.prepare("UPDATE runtime_release_evidence SET observed_at = ?, last_successful_sweep_at = ? WHERE unit = 'WORKER'")
      .run("2026-09-21T03:09:30Z", "2026-09-21T03:09:30Z");
    expect(await reader().observe()).toEqual(frozen);
  });
});
