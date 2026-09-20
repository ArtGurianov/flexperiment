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
let clock = now;

const world = (options: {
  archiveFails?: string;
  restoredSha256?: string;
  restoredTopology?: PreDeployTopology;
  lineage?: "LEGACY" | "SUPPORTED";
  predecessorGateOpen?: boolean;
  armed?: boolean;
  installedSha256?: string;
} = {}) => {
  const log: string[] = [];
  let gateClosed = !options.predecessorGateOpen;
  let observed = afterCutover;
  /** Digest of the database file at rest, as a restore would actually change it. */
  let installed = options.installedSha256 ?? "0".repeat(64);
  clock = now;
  const receipts = new InMemoryBootstrapRollbackReceiptStore();
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => clock, 60_000);
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
    receipts, clock: () => clock,
    archiver: {
      async quiesceAndArchive() {
        log.push("archive-successor");
        if (options.archiveFails) throw new Error(options.archiveFails);
        return successorDatabase;
      },
    },
    restorer: {
      async ensureSuccessorRuntimesStopped() { log.push("stop-successor"); },
      async ensurePredecessorDatabaseRestored(archive) { log.push(`restore-db:${archive.ref}`); installed = options.restoredSha256 ?? predecessorDatabase.sha256; },
      async ensurePreDeployTopologyRestored() { log.push("restore-topology"); observed = options.restoredTopology ?? before; },
      async ensurePredecessorRuntimeRunning() { log.push("start-predecessor"); },
    },
    identity: {
      async restedFileSha256() { return installed; },
      async runningLineage() { return options.lineage ?? "LEGACY"; },
    },
    predecessorGate: {
      async isClosed() { return gateClosed; },
      async open() { log.push("open-predecessor-gate"); gateClosed = false; },
    },
    topology: { async observe() { return observed; } },
  };
  return {
    log, receipts, store, sessions, session, portsFor: () => ports,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    gate: () => store.deploymentGate(),
    rollback: new BootstrapRollback(ports),
    prepare: (owner = "owner") => new BootstrapRollback(ports).prepare(store, session.id, owner, { rollbackId: "rb-1", nonce: "n-1", expiresAt: "2026-09-20T06:00:00.000Z" }),
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

  it("closes the arming race by reserving the direction before the successor is archived", async () => {
    // The successor database is about to be archived and lost, so which way
    // recovery goes has to be decided in it first. Otherwise another runner
    // arms external effects - and takes a real payment - behind a rollback
    // that already committed to restoring the predecessor.
    const { prepare, sessions, session, store } = world();
    await prepare();

    expect(store.get(session.id)!.bootstrapRollbackId).toBe("rb-1");
    expect(() => sessions.armExternalEffects(session.id, "owner")).toThrow("BOOTSTRAP_ROLLBACK_RESERVED");
    expect(() => sessions.completeTarget(session.id, "owner", afterCutover)).toThrow("BOOTSTRAP_ROLLBACK_RESERVED");
  });

  it("refuses a displaced runner even when it repeats the very same rollback id", async () => {
    // Idempotent is not unauthenticated: the same id from a runner that lost
    // its lease must fail, or it reads success and carries on archiving.
    const { prepare, sessions, session, advance } = world();
    await prepare();
    advance(120_000);
    sessions.takeOverExpiredLease(session.id, "new-runner");

    expect(() => sessions.reserveBootstrapRollback(session.id, "owner", "rb-1")).toThrow("DEPLOY_SESSION_NOT_OWNER");
    expect(sessions.reserveBootstrapRollback(session.id, "new-runner", "rb-1").bootstrapRollbackId).toBe("rb-1");
  });

  it("refuses to prepare as an owner it is not, and archives nothing", async () => {
    const { store, session, sessions, advance, portsFor, log } = world();
    advance(120_000);
    sessions.takeOverExpiredLease(session.id, "new-runner");

    // The dead runner comes back and tries to prepare. It must not be able to
    // act as whoever currently holds the lease.
    await expect(new BootstrapRollback(portsFor()).prepare(store, session.id, "owner", { rollbackId: "rb-1", nonce: "n", expiresAt: "2026-09-20T06:00:00.000Z" }))
      .rejects.toThrow("DEPLOY_SESSION_NOT_OWNER");
    expect(log).toEqual([]);
  });

  it("writes no receipt when the lease lapses while the successor is being archived", async () => {
    // Archiving is a long external step. A runner that lost ownership during it
    // must not leave a durable receipt outside the database.
    const { store, session, sessions, portsFor, receipts, advance } = world();
    const ports = portsFor();
    const stealing = {
      ...ports,
      archiver: {
        async quiesceAndArchive() {
          advance(120_000);
          sessions.takeOverExpiredLease(session.id, "new-runner");
          return successorDatabase;
        },
      },
    };

    await expect(new BootstrapRollback(stealing).prepare(store, session.id, "owner", { rollbackId: "rb-1", nonce: "n", expiresAt: "2026-09-20T06:00:00.000Z" }))
      .rejects.toThrow("DEPLOY_SESSION_NOT_OWNER");
    expect(receipts.read("rb-1")).toBeUndefined();
  });

  it("refuses a second reverse handoff over the first", async () => {
    const { prepare, sessions, session } = world();
    await prepare();
    expect(() => sessions.reserveBootstrapRollback(session.id, "owner", "rb-2")).toThrow("BOOTSTRAP_ROLLBACK_ALREADY_RESERVED");
    // The same one again is simply the same decision, so it is a no-op.
    expect(sessions.reserveBootstrapRollback(session.id, "owner", "rb-1").bootstrapRollbackId).toBe("rb-1");
  });

  it("does not restore over a database that is already the right one", async () => {
    // The crash this models: the file was replaced, the RESTORED marker was
    // not written. A replay must not write over it a second time.
    const { prepare, rollback, log } = world({ installedSha256: predecessorDatabase.sha256 });
    const { envelope } = await prepare();

    await rollback.execute("rb-1", envelope);

    expect(log).not.toContain(`restore-db:${predecessorDatabase.ref}`);
    expect(log).toContain("start-predecessor");
  });

  it("marks the restore durable before the predecessor is ever started", async () => {
    // A marker written after startup would let a replay restore the database
    // out from under a predecessor that was already running and writing.
    const { prepare, rollback, receipts, log } = world({ lineage: "SUPPORTED" });
    const { envelope } = await prepare();

    await expect(rollback.execute("rb-1", envelope)).rejects.toThrow("PREDECESSOR_LINEAGE_NOT_RESTORED");
    expect(receipts.read("rb-1")!.stage).toBe("RESTORED");
    expect(log.indexOf("restore-topology")).toBeLessThan(log.indexOf("start-predecessor"));
  });

  it("refuses a receipt that skips straight from prepared to completed", async () => {
    // Each stage is the proof the next rests on; skipping records a finished
    // rollback that never restored anything.
    const { prepare, receipts } = world();
    await prepare();
    expect(() => receipts.advance("rb-1", "COMPLETED")).toThrow("BOOTSTRAP_ROLLBACK_STAGE_SKIP");
  });

  it("refuses an expiry that has already passed, but never lets one cancel a started rollback", async () => {
    const expired = world();
    await expect(
      new BootstrapRollback({ ...expired.portsFor(), clock: () => now })
        .prepare(expired.store, expired.session.id, "owner", { rollbackId: "rb-expired", nonce: "n", expiresAt: "2026-09-19T00:00:00.000Z" }),
    ).rejects.toThrow("BOOTSTRAP_ROLLBACK_EXPIRY_INVALID");

    // Once PREPARED is durable the window no longer matters: the operation has
    // begun, and the only safe direction is to finish it.
    const started = world();
    const { envelope } = await started.prepare();
    const late = new BootstrapRollback({ ...started.portsFor(), clock: () => new Date("2026-09-21T00:00:00.000Z") });
    expect((await late.execute("rb-1", envelope)).stage).toBe("COMPLETED");
  });

  it("refuses a rollback id whose envelope is a different rollback", async () => {
    const { prepare, rollback } = world();
    const { envelope } = await prepare();

    await expect(rollback.execute("rb-1", { ...envelope, nonce: "n-2" }))
      .rejects.toThrow("BOOTSTRAP_ROLLBACK_IDENTITY_MISMATCH");
  });
});
