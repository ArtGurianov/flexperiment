import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db";
import { startRuntimeInstance } from "../../src/release/runtime-instance";
import { runtimeInstances } from "../../src/release/runtime-instance-evidence";

const COMMIT = "a".repeat(40);

let db: Database.Database;
const previous = { commit: process.env.SOURCE_COMMIT, instance: process.env.COMMERCE_INSTANCE_ID };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
});
afterEach(() => {
  process.env.SOURCE_COMMIT = previous.commit;
  process.env.COMMERCE_INSTANCE_ID = previous.instance;
  vi.restoreAllMocks();
});

describe("a runtime recording what it is", () => {
  it("records the commit it is serving, per instance", () => {
    process.env.SOURCE_COMMIT = COMMIT;
    process.env.COMMERCE_INSTANCE_ID = "api-1";
    const instance = startRuntimeInstance(db, "COMMERCE");

    expect(runtimeInstances(db)).toEqual([expect.objectContaining({
      instanceId: "api-1", unit: "COMMERCE", sourceCommit: COMMIT, lastSuccessfulSweepAt: null,
    })]);
    instance?.stop();
  });

  it("records nothing rather than something it cannot vouch for", () => {
    // Readiness reads an absent row as "not converged", which is the correct
    // answer. A row asserting a commit this process cannot prove is worse than
    // no row at all, so an unset or malformed SOURCE_COMMIT writes neither.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.SOURCE_COMMIT;
    expect(startRuntimeInstance(db, "COMMERCE")).toBeUndefined();

    process.env.SOURCE_COMMIT = "not-a-commit";
    expect(startRuntimeInstance(db, "WORKER")).toBeUndefined();
    expect(runtimeInstances(db)).toEqual([]);
  });

  it("keeps an old instance visible beside the new one", () => {
    // The whole reason evidence is per instance: a previous container that has
    // not stopped is exactly what readiness has to be able to see.
    process.env.SOURCE_COMMIT = COMMIT;
    process.env.COMMERCE_INSTANCE_ID = "api-old";
    const old = startRuntimeInstance(db, "COMMERCE");
    process.env.SOURCE_COMMIT = "b".repeat(40);
    process.env.COMMERCE_INSTANCE_ID = "api-new";
    const fresh = startRuntimeInstance(db, "COMMERCE");

    // Order is not the subject: that both are there is.
    expect(runtimeInstances(db, "COMMERCE").map((row) => [row.instanceId, row.sourceCommit]).sort())
      .toEqual([["api-new", "b".repeat(40)], ["api-old", COMMIT]]);
    old?.stop();
    fresh?.stop();
  });

  it("gives each process its own identity when none is configured", () => {
    process.env.SOURCE_COMMIT = COMMIT;
    delete process.env.COMMERCE_INSTANCE_ID;
    const first = startRuntimeInstance(db, "COMMERCE");
    const second = startRuntimeInstance(db, "COMMERCE");

    const ids = runtimeInstances(db).map((row) => row.instanceId);
    expect(new Set(ids).size).toBe(2);
    first?.stop();
    second?.stop();
  });
});
