import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { recordRuntimeHeartbeatEvidence, recordRuntimeStartupEvidence, recordSuccessfulWorkerSweep } from "../src/runtime-release-evidence";
import { runWorkerCycle } from "../src/worker-cycle";
import { releaseRuntimeEvidence } from "../src/release-control";

const sourceCommit = "a".repeat(40);

const workerDomain = (collectProviderDrift: () => Promise<void>) => ({
  recoverStaleCommands: () => undefined,
  detectStalePreparedSettlements: () => 0,
  reconcileCreateUnknownPayments: async () => undefined,
  reconcilePendingPayments: async () => undefined,
  createObligationRefunds: () => undefined,
  submitRequestedRefunds: async () => undefined,
  reconcilePendingRefunds: async () => undefined,
  processEmailOutbox: async () => undefined,
  reconcileUnisenderEventDumps: async () => undefined,
  detectOverdueVenueAnnouncements: () => undefined,
  processCityInterestLifecycle: async () => ({ expired_deleted: 0, intents_created: 0 }),
  processOccurrenceNotificationLifecycle: async () => ({ deleted: 0, intents_created: 0 }),
  collectProviderDrift,
}) as unknown as Parameters<typeof runWorkerCycle>[0]["domain"];

describe("worker successful-sweep evidence", () => {
  it("invalidates previous success on restart while heartbeats remain liveness-only", () => {
    const db = openDatabase(":memory:"); migrate(db);
    expect(recordRuntimeStartupEvidence(db, "WORKER", sourceCommit)).toBe(true);
    expect(recordSuccessfulWorkerSweep(db, sourceCommit)).toBe(true);
    expect(recordRuntimeHeartbeatEvidence(db, "WORKER", sourceCommit)).toBe(true);
    expect(db.prepare("SELECT last_successful_sweep_at FROM runtime_release_evidence WHERE unit = 'WORKER'").get()).toEqual({ last_successful_sweep_at: expect.any(String) });
    const runtime = releaseRuntimeEvidence(db, { sourceCommit, currentLegalCopiesMatch: () => false });
    expect(runtime).toMatchObject({
      worker_source_commit: sourceCommit,
      worker_started_at: expect.any(String),
      worker_last_successful_sweep_at: expect.any(String),
    });
    expect(runtime.migration_versions).toEqual(readdirSync("commerce/migrations").filter((name) => name.endsWith(".sql")).sort());
    expect(recordRuntimeStartupEvidence(db, "WORKER", sourceCommit)).toBe(true);
    expect(db.prepare("SELECT last_successful_sweep_at FROM runtime_release_evidence WHERE unit = 'WORKER'").get()).toEqual({ last_successful_sweep_at: null });
    db.close();
  });

  it("does not record success when a complete cycle fails", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    recordRuntimeStartupEvidence(db, "WORKER", sourceCommit);
    await expect(runWorkerCycle({ domain: workerDomain(async () => { throw new Error("drift failed"); }), db, sourceCommit, collectProviderDrift: true })).rejects.toThrow("drift failed");
    expect(db.prepare("SELECT last_successful_sweep_at FROM runtime_release_evidence WHERE unit = 'WORKER'").get()).toEqual({ last_successful_sweep_at: null });
    db.close();
  });

  it("records success only after a complete worker cycle", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    recordRuntimeStartupEvidence(db, "WORKER", sourceCommit);
    await runWorkerCycle({ domain: workerDomain(async () => undefined), db, sourceCommit, collectProviderDrift: true });
    expect(db.prepare("SELECT last_successful_sweep_at FROM runtime_release_evidence WHERE unit = 'WORKER'").get()).toEqual({ last_successful_sweep_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    db.close();
  });
});
