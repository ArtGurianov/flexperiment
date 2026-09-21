import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { certificationRunId, ProductionCertificationDriver } from "../../src/certification/driver";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { TerminalChannel } from "../../src/certification/operator-terminal";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { TEST_CAPABILITY_KEY } from "../support/certification-secret";

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
    serviceToken: "token", capabilityKey: TEST_CAPABILITY_KEY, citySlug: "test-city", now: () => now,
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
      serviceToken: "token", capabilityKey: TEST_CAPABILITY_KEY, citySlug: "test-city",
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

describe("the claim between prepare and certify", () => {
  /** A fresh process: nothing carried over but the file on disk. */
  const restarted = () => new ProductionCertificationDriver({
    db, candidate, adminBaseUrl: "http://127.0.0.1:1", publicBaseUrl: "http://127.0.0.1:1",
    serviceToken: "token", capabilityKey: TEST_CAPABILITY_KEY, citySlug: "test-city", now: () => now,
    operator: { occurrence: { startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", venueDisclosureText: "Later", venueAnnounceBy: "2026-09-25T00:00:00.000Z" }, checkoutBodyPath: "/dev/null" },
    terminal: terminal(),
  });

  it("recovers the same bearer after the issuing process is gone", async () => {
    // prepare exits with 13 and the process disappears. certify starts minutes
    // or hours later and must present the same bearer: a new capability per
    // attempt would be a new authorization for every restart.
    const issued = await driver.issueCapability(SESSION);
    const recovered = restarted().recoverCapability(SESSION);

    expect(recovered).toEqual(issued);
    expect(restarted().bearerFor(recovered!)).toBe(driver.bearerFor(issued));
    expect(db.prepare("SELECT COUNT(*) AS n FROM certification_capabilities").get()).toEqual({ n: 1 });
  });

  it("recovers it after the checkout spent it, because the run is not over", async () => {
    // Restart after the checkout request but before its response: the capability
    // is spent, the run continues to payment, email, refund and cleanup, and the
    // claim still identifies this caller to the catalogue endpoint.
    const issued = await driver.issueCapability(SESSION);
    new SqliteCertificationCapabilityStore(db).spend(issued.id, now);

    const recovered = restarted().recoverCapability(SESSION);
    expect(recovered?.id).toBe(issued.id);
    expect(restarted().bearerFor(recovered!)).toBe(driver.bearerFor(issued));
    expect(recovered?.consumedAt).toBe(now.toISOString());
  });

  it("gives another deploy session nothing", async () => {
    await driver.issueCapability(SESSION);
    db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
        pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
      VALUES ('other-session', 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'SUCCEEDED', 'OLD_LINEAGE_ALLOWED',
        '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
        '2026-09-19T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 0)`).run(SHA, SHA);

    expect(restarted().recoverCapability("other-session")).toBeUndefined();
  });

  it("answers nothing before anything was issued", () => {
    expect(restarted().recoverCapability(SESSION)).toBeUndefined();
  });

  it("never puts the bearer on a stream or an argument", () => {
    // The nonce is the bearer. It is read from the row and handed to the ports
    // in memory; nothing here writes it anywhere a person or a log would see.
    const source = readFileSync("commerce/src/certification/driver.ts", "utf8");
    for (const forbidden of ["console.", "process.stdout", "process.stderr", "process.argv", "appendFileSync", "writeFileSync"]) {
      expect(source, `${forbidden} must not appear here`).not.toContain(forbidden);
    }
    const ports = readFileSync("commerce/src/certification/http-ports.ts", "utf8");
    expect(ports).not.toContain("console.");
    // It travels in a header, never a query string.
    expect(ports).toContain("[CERTIFICATION_CLAIM_HEADER]");
    expect(ports).not.toMatch(/nonce=\$\{/);
  });
});
