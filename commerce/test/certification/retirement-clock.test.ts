import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { SqliteCertificationRunStore } from "../../src/certification/store-sqlite";

/**
 * Retirement frees the one live slot behind a deployment fence, so who decides
 * when it happens is the whole question. After `0003` the answer is the
 * database: the stamp must be its own clock, and a capability that has not
 * expired cannot be retired at any stamp at all.
 */

const SHA = "a".repeat(40);
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

let db: Database.Database;

const capability = (id: string, expiresAt: string, consumedAt: string | null = null) =>
  db.prepare(`INSERT INTO certification_capabilities(id, run_id, deployment_session_id, release_sha,
      max_amount_kopecks, expires_at, nonce, consumed_at)
    VALUES (?, 'run', 'session', ?, 100, ?, ?, ?)`).run(id, SHA, expiresAt, `digest-${id}`, consumedAt);

const retire = (id: string, stamp: string) =>
  db.prepare("UPDATE certification_capabilities SET retired_at = ? WHERE id = ?").run(stamp, id);

const retireAtDatabaseClock = (id: string) =>
  db.prepare(`UPDATE certification_capabilities SET retired_at = ${NOW_SQL} WHERE id = ?`).run(id);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  new SqliteCertificationRunStore(db).create({
    runId: "run", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: "2020-01-01T00:00:00.000Z",
  });
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES ('session', 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'DEPLOYING', 'OLD_LINEAGE_ALLOWED',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 1)`).run(SHA, SHA);
});

describe("who decides when a capability is retired", () => {
  it("accepts the database's own clock for a capability that has expired", () => {
    capability("expired", "2020-01-01T00:00:00.000Z");
    expect(() => retireAtDatabaseClock("expired")).not.toThrow();
    expect(db.prepare("SELECT retired_at FROM certification_capabilities WHERE id = 'expired'").get())
      .toMatchObject({ retired_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown as string });
  });

  it("refuses a stamp the caller chose, however plausible", () => {
    // The application does not get to pick the moment. A stamp between expiry
    // and now used to be admissible; it is not a time this database observed.
    capability("expired", "2020-01-01T00:00:00.000Z");
    for (const stamp of ["2020-06-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]) {
      expect(() => retire("expired", stamp)).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    }
  });

  it("refuses to retire a capability that has not expired, even at the right clock", () => {
    // The single authoritative predicate: `NEW.retired_at < OLD.expires_at`.
    // With the stamp pinned to now, this is exactly "it has not expired yet",
    // and there is no second term implying the same thing.
    capability("live", "2099-01-01T00:00:00.000Z");
    expect(() => retireAtDatabaseClock("live")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("refuses to retire one that was spent", () => {
    // Spent and replaced are different endings, and never both.
    capability("spent", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:01.000Z");
    expect(() => retireAtDatabaseClock("spent")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("has no term left that no test can reach", () => {
    // Four terms since 0005: spent, the stamp, and expiry are each killed by a
    // case above; the forward-supersession term (session armed and stuck, the
    // capability of its current binding) by capability-revocation.test.ts. The
    // baseline's guard carried a redundant one - and a predicate nobody can
    // reach is one nobody can prove still works.
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'certification_capabilities_retirement_guard'")
      .get() as { sql: string };
    const terms = sql.sql.split(/\bOR\b/).length;
    expect(terms).toBe(4);
    expect(sql.sql).not.toContain("< OLD.expires_at\n    OR NEW.retired_at >");
  });
});
