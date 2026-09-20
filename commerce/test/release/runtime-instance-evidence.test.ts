import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { RuntimeInstanceEvidenceRecorder, runtimeInstances } from "../../src/release/runtime-instance-evidence";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});

const recorder = (instanceId: string, unit: "COMMERCE" | "WORKER" = "COMMERCE", at = "2026-09-20T00:00:00.000Z") =>
  new RuntimeInstanceEvidenceRecorder(db, instanceId, unit, () => new Date(at));

describe("runtime instance evidence", () => {
  it("keeps a second instance of the same unit rather than overwriting the first", () => {
    // This is the whole reason it replaced the singleton: an old instance that
    // has not stopped is exactly what readiness has to be able to see.
    recorder("old").start(COMMIT);
    recorder("new", "COMMERCE", "2026-09-20T00:01:00.000Z").start(OTHER);

    expect(runtimeInstances(db, "COMMERCE").map((row) => [row.instanceId, row.sourceCommit]))
      .toEqual([["old", COMMIT], ["new", OTHER]]);
  });

  it("refuses a source commit it cannot vouch for", () => {
    // An instance that cannot say what it is serving must not be able to record
    // that it is serving something.
    expect(() => recorder("bad").start("not-a-commit")).toThrow("RUNTIME_EVIDENCE_SOURCE_COMMIT_INVALID");
    expect(runtimeInstances(db)).toEqual([]);
  });

  it("resumes the same instance on restart instead of forking a second row", () => {
    recorder("api-1").start(COMMIT);
    const resumed = recorder("api-1", "COMMERCE", "2026-09-20T00:05:00.000Z").start(COMMIT);

    expect(runtimeInstances(db)).toHaveLength(1);
    expect(resumed).toMatchObject({ startedAt: "2026-09-20T00:00:00.000Z", heartbeatAt: "2026-09-20T00:05:00.000Z" });
  });

  it("will not let a restart restate which commit, or which unit, it has been serving", () => {
    recorder("api-1").start(COMMIT);
    expect(() => recorder("api-1", "COMMERCE", "2026-09-20T00:05:00.000Z").start(OTHER))
      .toThrow("RUNTIME_INSTANCE_EVIDENCE_IDENTITY_IMMUTABLE");
    expect(() => recorder("api-1", "WORKER", "2026-09-20T00:05:00.000Z").start(COMMIT))
      .toThrow("RUNTIME_INSTANCE_EVIDENCE_IDENTITY_IMMUTABLE");
    expect(runtimeInstances(db)[0]).toMatchObject({ sourceCommit: COMMIT, unit: "COMMERCE", heartbeatAt: "2026-09-20T00:00:00.000Z" });
  });

  it("moves the heartbeat and the sweep, and nothing else", () => {
    recorder("api-1").start(COMMIT);
    const swept = recorder("api-1", "COMMERCE", "2026-09-20T00:10:00.000Z").recordSuccessfulSweep();

    expect(swept).toMatchObject({
      sourceCommit: COMMIT, startedAt: "2026-09-20T00:00:00.000Z",
      heartbeatAt: "2026-09-20T00:10:00.000Z", lastSuccessfulSweepAt: "2026-09-20T00:10:00.000Z",
    });
  });

  it("refuses to heartbeat an instance that never started", () => {
    // Otherwise a lost start reads as a converged runtime with a fresh pulse.
    expect(() => recorder("ghost").heartbeat()).toThrow("RUNTIME_INSTANCE_EVIDENCE_NOT_STARTED");
    expect(() => recorder("ghost").recordSuccessfulSweep()).toThrow("RUNTIME_INSTANCE_EVIDENCE_NOT_STARTED");
  });

  it("reports no sweep until one has finished", () => {
    expect(recorder("worker-1", "WORKER").start(COMMIT).lastSuccessfulSweepAt).toBeNull();
  });
});
