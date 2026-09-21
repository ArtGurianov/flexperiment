import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { DeploySessions } from "../../src/release/deploy-session";
import { SqliteReleaseAuthorityStore } from "../../src/release/deploy-session-store";
import { snapshot } from "../support/deploy-snapshot";

const target = "a".repeat(40);
const old = "b".repeat(40);
const now = new Date("2026-09-20T00:00:00.000Z");

let db: Database.Database;
let store: SqliteReleaseAuthorityStore;
let sessions: DeploySessions;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  store = new SqliteReleaseAuthorityStore(db);
  sessions = new DeploySessions(store, () => now);
});

const fenced = () => sessions.acquireFenced(
  { id: "stored", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target, candidateId: "candidate" },
  snapshot(old),
);

/**
 * A row as an older build would have left it.
 *
 * It has to be inserted rather than updated into place: the baseline freezes
 * `pre_deploy_topology` at acquisition, so the legacy value can only arrive the
 * way it really would - written once, by code that predates the second layer.
 */
const legacyRow = (storedSnapshot: string) => db.prepare(`INSERT INTO deploy_sessions(
  id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
  mutation_observed, deployment_gate_closed, created_at, lease_expires_at, pre_deploy_topology
) VALUES ('stored', 'owner', 'MAINTENANCE_CUTOVER', ?, 'candidate', 'DEPLOYING', 'OLD_LINEAGE_ALLOWED',
  0, 1, ?, ?, ?)`).run(target, now.toISOString(), new Date(now.getTime() + 60_000).toISOString(), storedSnapshot);

describe("what the release authority will read back out of its own column", () => {
  it("round-trips both layers of the snapshot, and freezes them once written", () => {
    fenced();
    // Write-once, by the baseline's own trigger: a snapshot that could be
    // rewritten later is not a record of what production was.
    expect(() => db.prepare("UPDATE deploy_sessions SET pre_deploy_topology = ? WHERE id = 'stored'").run(JSON.stringify(snapshot(target))))
      .toThrow("DEPLOY_SESSION_IDENTITY_IMMUTABLE");
    expect(store.get("stored")?.preDeployTopology).toEqual(snapshot(old));
  });

  it("refuses a stored snapshot that carries only the four surfaces", () => {
    // The shape this column held before the deploy pointer joined the snapshot.
    // Completing it with an assumed pointer is the one repair that must never
    // happen here: the session would then compare against a control plane
    // nobody observed, and a safe abort decided from it would be a guess.
    legacyRow(JSON.stringify({ frontend: old, admin: old, commerce: old, worker: old }));

    expect(() => store.get("stored")).toThrow("DEPLOY_SNAPSHOT_MALFORMED");
    // It fails closed on every path that reads the session, not only the one
    // the test happened to pick - a refusal one caller can walk around is not
    // a refusal.
    expect(() => sessions.read("stored")).toThrow("DEPLOY_SNAPSHOT_MALFORMED");
    expect(() => sessions.classifyFailure("stored", "owner", snapshot(old))).toThrow("DEPLOY_SNAPSHOT_MALFORMED");
  });

  it("refuses a stored snapshot that is not JSON at all", () => {
    legacyRow("not json");
    expect(() => store.get("stored")).toThrow("DEPLOY_SNAPSHOT_MALFORMED");
  });

  it("refuses an observed topology of the old shape just as firmly", () => {
    // The observation column decides safe aborts on the way out of a failure,
    // so a legacy value there is no more readable than one in the snapshot.
    const session = fenced();
    sessions.beginDeploying(session.id, "owner");
    sessions.observeTopology(session.id, "owner", snapshot(old));
    db.prepare("UPDATE deploy_sessions SET observed_topology = ? WHERE id = 'stored'")
      .run(JSON.stringify({ frontend: old, admin: old, commerce: old, worker: old }));

    expect(() => store.get("stored")).toThrow("DEPLOY_SNAPSHOT_MALFORMED");
  });
});
