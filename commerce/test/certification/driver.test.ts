import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { certificationRunId, ProductionCertificationDriver } from "../../src/certification/driver";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { TerminalChannel } from "../../src/certification/operator-terminal";
import { schemaInventoryExpectation } from "../../src/release/expectation";

const SHA = "a".repeat(40);
const SESSION = "deploy-session";
// Deliberately in the past: retirement is refused before expiry by the
// database's own clock, so a capability can only be replaced once it has
// really expired - not once a test says it has.
const now = new Date("2026-09-19T12:00:00.000Z");

const candidate = {
  id: SHA, sha: SHA, releaseClass: "LAUNCH_BASELINE" as const,
  expectation: { schemaInventory: schemaInventoryExpectation(["0001_launch_baseline.sql"]), legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64) },
};

const terminal = (): TerminalChannel => ({ write: () => {}, readLine: () => "yes", close: () => {} });

let db: Database.Database;
let driver: ProductionCertificationDriver;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'DEPLOYING', 'OLD_LINEAGE_ALLOWED',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2026-09-21T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 1)`).run(SESSION, SHA, SHA);
  driver = new ProductionCertificationDriver({
    db, candidate, adminBaseUrl: "http://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1:1",
    serviceToken: "token", citySlug: "test-city", now: () => now,
    operator: { occurrence: { startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", venueDisclosureText: "Later", venueAnnounceBy: "2026-09-25T00:00:00.000Z" }, checkoutBodyPath: "/dev/null" },
    terminal: terminal(),
  });
});

describe("preparing a certification", () => {
  it("creates the run and issues a capability, and spends neither", async () => {
    const capability = await driver.issueCapability(SESSION);

    // Both are records this system keeps about itself: still before the point
    // of no return, so a cutover prepared and never certified is rollback-legal.
    expect(capability).toMatchObject({ runId: certificationRunId(SESSION), releaseSha: SHA, maxAmountKopecks: 100 });
    expect(new SqliteCertificationCapabilityStore(db).get(capability.id)?.consumedAt).toBeNull();
    expect(new SqliteCertificationRunStore(db).load(certificationRunId(SESSION))).toMatchObject({ phase: "NEW", direction: "NORMAL" });
    expect(db.prepare("SELECT rollback_authority FROM deploy_sessions WHERE id = ?").get(SESSION))
      .toEqual({ rollback_authority: "OLD_LINEAGE_ALLOWED" });
  });

  it("derives the run from the session, so a restart continues one certification", async () => {
    // A fresh id per invocation would make every restart a new certification,
    // which is the one thing a real payment must never let happen.
    const first = await driver.issueCapability(SESSION);
    const runs = new SqliteCertificationRunStore(db);
    runs.update(first.runId, 1, { phase: "CHECKOUT_CREATED", statusId: "status-1" });

    // The first capability has to expire before a second can be issued - its
    // scope is immutable, so only the clock can do it - and the run itself is
    // untouched by that.
    const later = new ProductionCertificationDriver({
      db, candidate, adminBaseUrl: "http://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1:1",
      serviceToken: "token", citySlug: "test-city",
      now: () => new Date(now.getTime() + 5 * 60 * 60_000),
      operator: { occurrence: { startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", venueDisclosureText: "Later", venueAnnounceBy: "2026-09-25T00:00:00.000Z" }, checkoutBodyPath: "/dev/null" },
      terminal: terminal(),
    });
    const second = await later.issueCapability(SESSION);

    expect(second.runId).toBe(first.runId);
    expect(runs.load(first.runId)).toMatchObject({ phase: "CHECKOUT_CREATED", statusId: "status-1" });
  });

  it("refuses a second live capability for one fence", async () => {
    await driver.issueCapability(SESSION);
    // Two capabilities, both authorised, is the state the stored slot exists to
    // make impossible.
    await expect(driver.issueCapability(SESSION)).rejects.toThrow("CERTIFICATION_CAPABILITY_ALREADY_LIVE");
  });

  it("keeps nothing about progress in this process", () => {
    // Everything a resume needs is on the other side of a commit: the run
    // record, the catalogue ledger and the checkout idempotency row.
    const source = readFileSync("commerce/src/certification/driver.ts", "utf8");
    expect(source).not.toMatch(/#phase|#progress|#step|this\.#state/);
    expect(source).toContain("certificationRunId(sessionId)");
  });
});

describe("reporting a run without deciding anything", () => {
  it("answers with the durable phase, or nothing", async () => {
    expect(driver.phase(SESSION)).toBeUndefined();
    await driver.issueCapability(SESSION);
    expect(driver.phase(SESSION)).toBe("NEW");
  });
});
