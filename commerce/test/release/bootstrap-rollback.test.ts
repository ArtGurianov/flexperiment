import { describe, expect, it } from "vitest";
import {
  BootstrapRollback, InMemoryBootstrapRollbackReceiptStore,
  type BootstrapRollbackPorts, type DatabaseArchive,
} from "../../src/release/bootstrap-rollback";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeployTopology } from "../../src/release/deploy-session";

const target = "a".repeat(40);
const before: PreDeployTopology = { frontend: "b".repeat(40), admin: "c".repeat(40), commerce: "b".repeat(40), worker: "d".repeat(40) };
const afterCutover: PreDeployTopology = { frontend: target, admin: target, commerce: target, worker: target };
const predecessorDatabase: DatabaseArchive = { ref: "prelaunch-2026-09-20.sqlite", sha256: "e".repeat(64) };
const successorDatabase: DatabaseArchive = { ref: "successor-2026-09-20.sqlite", sha256: "f".repeat(64) };
const now = new Date("2026-09-20T00:00:00.000Z");

const world = (options: {
  archiveFails?: string;
  restoredSha256?: string;
  restoredTopology?: PreDeployTopology;
  lineage?: "LEGACY" | "SUPPORTED";
  predecessorGateOpen?: boolean;
  armed?: boolean;
} = {}) => {
  const log: string[] = [];
  let gateClosed = !options.predecessorGateOpen;
  let observed = afterCutover;
  const receipts = new InMemoryBootstrapRollbackReceiptStore();
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => now);
  const session = sessions.acquireFenced({
    id: "successor", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
    adoptedCutoverId: "cutover-1",
    predecessorDatabaseRef: predecessorDatabase.ref, predecessorDatabaseSha256: predecessorDatabase.sha256,
  }, before);
  sessions.beginDeploying(session.id, "owner");
  if (options.armed) {
    sessions.observeTopology(session.id, "owner", afterCutover);
    sessions.armExternalEffects(session.id, "owner");
  }

  const ports: BootstrapRollbackPorts = {
    receipts, clock: () => now,
    archiver: {
      async quiesceAndArchive() {
        log.push("archive-successor");
        if (options.archiveFails) throw new Error(options.archiveFails);
        return successorDatabase;
      },
    },
    restorer: {
      async stopSuccessorRuntimes() { log.push("stop-successor"); },
      async restoreDatabase(archive) { log.push(`restore-db:${archive.ref}`); },
      async restoreTopology() { log.push("restore-topology"); observed = options.restoredTopology ?? before; },
      async startPredecessorRuntime() { log.push("start-predecessor"); },
    },
    identity: {
      async restedFileSha256() { return options.restoredSha256 ?? predecessorDatabase.sha256; },
      async runningLineage() { return options.lineage ?? "LEGACY"; },
    },
    predecessorGate: {
      async isClosed() { return gateClosed; },
      async open() { log.push("open-predecessor-gate"); gateClosed = false; },
    },
    topology: { async observe() { return observed; } },
  };
  return {
    log, receipts, store, sessions, session,
    gate: () => store.deploymentGate(),
    rollback: new BootstrapRollback(ports),
    prepare: () => new BootstrapRollback(ports).prepare(store, session.id, { rollbackId: "rb-1", nonce: "n-1", expiresAt: "2026-09-20T06:00:00.000Z" }),
  };
};

describe("bootstrap reverse handoff", () => {
  it("cannot even be prepared once external effects are armed", async () => {
    const { prepare, log } = world({ armed: true });
    await expect(prepare()).rejects.toThrow("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    // Not "refused later by whoever executes it": nothing was archived at all.
    expect(log).toEqual([]);
  });

  it("writes no envelope and leaves the successor untouched when its archive fails", async () => {
    const { prepare, receipts, log } = world({ archiveFails: "SUCCESSOR_BACKUP_FAILED" });
    await expect(prepare()).rejects.toThrow("SUCCESSOR_BACKUP_FAILED");
    expect(receipts.read("rb-1")).toBeUndefined();
    expect(log).toEqual(["archive-successor"]);
  });

  it("captures both archives and the observed successor topology before anything is discarded", async () => {
    const { prepare } = world();
    const receipt = await prepare();
    expect(receipt.stage).toBe("PREPARED");
    expect(receipt.envelope).toMatchObject({
      rollbackId: "rb-1", cutoverId: "cutover-1", successorSessionId: "successor",
      predecessorDatabase, successorDatabase, preDeployTopology: before, successorTopology: afterCutover,
    });
  });

  it("never starts the predecessor when the restored archive has the wrong digest", async () => {
    const { prepare, rollback, log, receipts } = world({ restoredSha256: "0".repeat(64) });
    const { envelope } = await prepare();

    await expect(rollback.execute("rb-1", envelope)).rejects.toThrow("PREDECESSOR_DATABASE_DIGEST_MISMATCH");
    // Verified while nothing runs: once writers start the file legitimately
    // diverges and this check could never be made again.
    expect(log).not.toContain("start-predecessor");
    expect(log).not.toContain("open-predecessor-gate");
    expect(receipts.read("rb-1")!.stage).toBe("PREPARED");
  });

  it("refuses to complete when the database came back but the topology did not", async () => {
    const stillPartial = { ...before, worker: target };
    const { prepare, rollback, log, receipts } = world({ restoredTopology: stillPartial });
    const { envelope } = await prepare();

    await expect(rollback.execute("rb-1", envelope)).rejects.toThrow("PREDECESSOR_TOPOLOGY_NOT_RESTORED");
    expect(receipts.read("rb-1")!.stage).toBe("RESTORED");
    expect(log).not.toContain("open-predecessor-gate");
  });

  it("records completion before the predecessor gate may reopen", async () => {
    const { prepare, rollback, log, receipts } = world();
    const { envelope } = await prepare();

    const done = await rollback.execute("rb-1", envelope);

    expect(done.stage).toBe("COMPLETED");
    expect(receipts.read("rb-1")!.stage).toBe("COMPLETED");
    expect(log).toEqual([
      "archive-successor", "stop-successor", `restore-db:${predecessorDatabase.ref}`,
      "restore-topology", "start-predecessor", "open-predecessor-gate",
    ]);
  });

  it("resumes from the last durable fact and never restores a database twice", async () => {
    const { prepare, rollback, log, receipts } = world();
    const { envelope } = await prepare();
    await rollback.execute("rb-1", envelope);
    const restoresBefore = log.filter((entry) => entry.startsWith("restore-db")).length;

    // The crash this models: COMPLETED is durable, the reopen did not happen.
    // A retry may only finish the reopen.
    receipts.advance("rb-1", "COMPLETED");
    await rollback.execute("rb-1", envelope);

    expect(log.filter((entry) => entry.startsWith("restore-db")).length).toBe(restoresBefore);
    expect(receipts.read("rb-1")!.stage).toBe("COMPLETED");
  });

  it("refuses a rollback id whose envelope is a different rollback", async () => {
    const { prepare, rollback } = world();
    const { envelope } = await prepare();

    await expect(rollback.execute("rb-1", { ...envelope, nonce: "n-2" }))
      .rejects.toThrow("BOOTSTRAP_ROLLBACK_IDENTITY_MISMATCH");
  });
});
