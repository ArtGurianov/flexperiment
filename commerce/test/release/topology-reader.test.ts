import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { DatabaseRuntimeEvidenceReader, ProductionTopologyReader } from "../../src/release/topology-reader";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = new Date("2026-09-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

let db: Database.Database;
let servers: Server[] = [];

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});
afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  servers = [];
});

const descriptor = async (body: string | null, status = 200): Promise<string> => {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/release.json`;
};

const instance = (unit: "COMMERCE" | "WORKER", id: string, commit: string, heartbeatOffsetMs = 0, sweep: string | null = null) =>
  db.prepare(`INSERT INTO runtime_instance_evidence(instance_id, unit, source_commit, started_at, heartbeat_at, last_successful_sweep_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, unit, commit, at(-60_000), at(heartbeatOffsetMs), sweep);

const reader = async (frontend: string, admin: string) => new ProductionTopologyReader({
  frontendReleaseUrl: frontend, adminReleaseUrl: admin, db, now: () => NOW,
});

describe("reading what production is serving", () => {
  it("answers with all four surfaces when every one of them agrees", async () => {
    const url = await descriptor(JSON.stringify({ source_commit: COMMIT }));
    instance("COMMERCE", "api-1", COMMIT);
    instance("WORKER", "worker-1", COMMIT, 0, at(-30_000));

    expect(await (await reader(url, url)).observe()).toEqual({ frontend: COMMIT, admin: COMMIT, commerce: COMMIT, worker: COMMIT });
  });

  it("fails closed on a surface it cannot reach", async () => {
    const good = await descriptor(JSON.stringify({ source_commit: COMMIT }));
    instance("COMMERCE", "api-1", COMMIT);
    instance("WORKER", "worker-1", COMMIT);
    const gone = await descriptor(null, 502);

    await expect((await reader(good, gone)).observe()).rejects.toThrow("TOPOLOGY_SURFACE_UNREACHABLE");
  });

  it("fails closed on a descriptor that is not a descriptor", async () => {
    instance("COMMERCE", "api-1", COMMIT);
    instance("WORKER", "worker-1", COMMIT);
    const good = await descriptor(JSON.stringify({ source_commit: COMMIT }));

    const html = await descriptor("<html>404</html>");
    await expect((await reader(good, html)).observe()).rejects.toThrow("TOPOLOGY_SURFACE_MALFORMED");

    const noCommit = await descriptor(JSON.stringify({ built_at: "yesterday" }));
    await expect((await reader(good, noCommit)).observe()).rejects.toThrow("TOPOLOGY_SURFACE_COMMIT_INVALID");

    const notACommit = await descriptor(JSON.stringify({ source_commit: "HEAD" }));
    await expect((await reader(good, notACommit)).observe()).rejects.toThrow("TOPOLOGY_SURFACE_COMMIT_INVALID");
  });

  it("fails closed on a unit that has stopped reporting", async () => {
    const url = await descriptor(JSON.stringify({ source_commit: COMMIT }));
    instance("COMMERCE", "api-1", COMMIT);
    // The worker's last heartbeat is older than the window allows.
    instance("WORKER", "worker-1", COMMIT, -10 * 60_000);

    await expect((await reader(url, url)).observe()).rejects.toThrow("TOPOLOGY_UNIT_NOT_RUNNING: WORKER");
  });

  it("fails closed while two instances of a unit disagree", async () => {
    // Half a rollout is not a surface with a commit. Answering with either one
    // would let a caller conclude convergence from it.
    const url = await descriptor(JSON.stringify({ source_commit: COMMIT }));
    instance("COMMERCE", "api-old", COMMIT);
    instance("COMMERCE", "api-new", OTHER);
    instance("WORKER", "worker-1", COMMIT);

    await expect((await reader(url, url)).observe()).rejects.toThrow("TOPOLOGY_UNIT_DISAGREES");
  });

  it("fails closed when no instance has ever reported", async () => {
    const url = await descriptor(JSON.stringify({ source_commit: COMMIT }));
    await expect((await reader(url, url)).observe()).rejects.toThrow("TOPOLOGY_UNIT_NOT_RUNNING: COMMERCE");
  });
});

describe("reading the evidence readiness judges", () => {
  const evidence = (legal?: { version: string; manifestSha256: string }) =>
    new DatabaseRuntimeEvidenceReader({ db, now: () => NOW, legal: () => legal });

  it("reports both units, the lineage and the ledger", async () => {
    instance("COMMERCE", "api-1", COMMIT);
    instance("WORKER", "worker-1", COMMIT, 0, at(-30_000));

    expect(await evidence({ version: "2026-08-28.1", manifestSha256: "f".repeat(64) }).read()).toMatchObject({
      commerce: { sourceCommit: COMMIT, lastSuccessfulSweepAt: null },
      worker: { sourceCommit: COMMIT, lastSuccessfulSweepAt: at(-30_000) },
      schema: { lineage: "SUPPORTED", versions: ["0001_launch_baseline.sql"] },
      legal: { version: "2026-08-28.1" },
    });
  });

  it("withholds a unit rather than guessing which instance speaks for it", async () => {
    // Undefined is a real answer: readiness reads it as "not converged", which
    // is exactly right for a unit whose instances disagree.
    instance("COMMERCE", "api-old", COMMIT);
    instance("COMMERCE", "api-new", OTHER);
    expect((await evidence().read()).commerce).toBeUndefined();
  });

  it("withholds a unit whose heartbeat has gone stale", async () => {
    instance("COMMERCE", "api-1", COMMIT, -10 * 60_000);
    expect((await evidence().read()).commerce).toBeUndefined();
  });

  it("reports a legacy database as legacy rather than refusing to answer", async () => {
    // The reader reports; `evaluateReadiness` decides. That split is what lets
    // readiness say "converged and inadmissible" instead of only "not yet".
    const legacy = new Database(":memory:");
    legacy.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    legacy.exec("CREATE TABLE orders (id TEXT PRIMARY KEY)");
    legacy.prepare("INSERT INTO schema_migrations(version) VALUES ('0001_initial.sql')").run();

    expect(await new DatabaseRuntimeEvidenceReader({ db: legacy, now: () => NOW }).read())
      .toMatchObject({ schema: { lineage: "LEGACY" }, commerce: undefined, worker: undefined });
  });
});
