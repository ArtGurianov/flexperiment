import { describe, expect, it } from "vitest";
import {
  BootstrapRollback, InMemoryBootstrapRollbackReceiptStore, bootstrapRollbackId,
  type BootstrapRollbackPorts, type DatabaseArchive,
} from "../../src/release/bootstrap-rollback";
import { canonicalEnvelopeSha256, createCutoverEnvelope, InMemoryCutoverEnvelopeStore } from "../../src/release/cutover-envelope";
import { DeploySessions, InMemoryReleaseAuthorityStore, type DeploymentObservation, type ReleaseAuthorityStore } from "../../src/release/deploy-session";
import { releaseAuthorityStores } from "../support/release-authority-stores";
import { RuntimeQuiescenceAuthority, type RuntimeLeaseBinding } from "../../src/release/runtime-quiescence-authority";

const target = "a".repeat(40);
const predecessor = "b".repeat(40);
const before: DeploymentObservation = {
  runtime: { frontend: predecessor, admin: predecessor, commerce: predecessor, worker: predecessor },
  controlPlane: { productionDeployRefSha: predecessor },
};
const successorDatabase: DatabaseArchive = { ref: "/state/archive/successor.sqlite", sha256: "f".repeat(64) };
const predecessorDatabase: DatabaseArchive = { ref: "/state/archive/predecessor.sqlite", sha256: "e".repeat(64) };
const now = new Date("2026-09-21T00:00:00.000Z");

type Failure = "archive-hash" | "runtime" | "storage" | "ref" | "frontend" | "admin" | "commerce" | "observe" | "before-gate" | "after-gate";

const world = (makeStore: () => ReleaseAuthorityStore, options: { armed?: boolean; fail?: Failure; observed?: DeploymentObservation; lineage?: string } = {}) => {
  const log: string[] = [];
  const failures = new Set(options.fail ? [options.fail] : []);
  const authority = makeStore();
  const sessions = new DeploySessions(authority, () => now, 60_000);
  const envelopes = new InMemoryCutoverEnvelopeStore();
  const envelope = createCutoverEnvelope({
    cutoverId: "cutover-1", adoptionNonce: "nonce-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
    preDeployTopology: before, predecessorDatabase,
    createdAt: now.toISOString(), expiresAt: "2026-09-21T06:00:00.000Z",
  });
  envelopes.write(envelope);
  envelopes.markConsumed(envelope.cutoverId);
  const session = sessions.acquireFenced({
    id: "successor", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
    adoptedCutoverId: envelope.cutoverId, adoptedEnvelopeSha256: canonicalEnvelopeSha256(envelope),
    predecessorDatabaseRef: predecessorDatabase.ref, predecessorDatabaseSha256: predecessorDatabase.sha256,
  }, before);
  sessions.beginDeploying(session.id, "owner");
  if (options.armed) {
    sessions.observeTopology(session.id, "owner", {
      runtime: { frontend: target, admin: target, commerce: target, worker: target },
      controlPlane: { productionDeployRefSha: target },
    });
    sessions.armExternalEffects(session.id, "owner");
  }

  const receipts = new InMemoryBootstrapRollbackReceiptStore();
  const applications: Record<"frontend" | "admin" | "commerce", string> = { frontend: target, admin: target, commerce: target };
  let ref = target;
  let gateClosed = true;
  let gateChecks = 0;
  let archiveDigest = predecessorDatabase.sha256;
  let storageRestored = false;
  const runtimeAuthority = new RuntimeQuiescenceAuthority(() => 0);
  const binding: RuntimeLeaseBinding = {
    sessionId: bootstrapRollbackId(session.id), operation: "RESTORE", databasePath: "/db",
    databaseIdentity: { canonicalPath: "/db", dev: 1, ino: 2 },
    applicationUuid: "commerce-uuid", applicationResourceId: "3",
    lockOwner: "runner",
  };

  const ports: BootstrapRollbackPorts = {
    authority, envelopes, receipts, clock: () => now,
    lineage: () => options.lineage ?? "SUPPORTED",
    storage: {
      inspectPredecessorArchive(archive) {
        log.push("inspect-archive");
        if (failures.delete("archive-hash")) throw new Error("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_DIGEST_MISMATCH");
        if (archive.sha256 !== archiveDigest) throw new Error("PREDECESSOR_ARCHIVE_CHANGED");
        return archive;
      },
      async restore(_rollbackId, archive) {
        log.push("archive-successor");
        storageRestored = true;
        log.push("restore-predecessor");
        if (failures.delete("storage")) throw new Error("CRASH_AFTER_DATABASE_RESTORE");
        return { successorDatabase, predecessorDatabase: archive };
      },
    },
    runtime: {
      async acquire() {
        log.push("stop-runtime");
        if (failures.delete("runtime")) throw new Error("COMPOSE_RUNTIME_CONTAINERS_STILL_RUNNING");
        return { lease: runtimeAuthority.acquire(binding), binding };
      },
      async applicationIsAt(name, sha) { log.push(`observe-${name}`); return applications[name] === sha; },
      async restoreApplication(name, sha) {
        log.push(`restore-${name}`);
        if (failures.delete(name)) throw new Error(`ROLLBACK_${name.toUpperCase()}_FAILED`);
        applications[name] = sha;
      },
    },
    refs: {
      async read() { log.push("read-ref"); return ref; },
      async compareAndSet(expected, next) {
        log.push(`cas-ref:${expected}:${next}`);
        if (failures.delete("ref")) throw new Error("DEPLOY_REF_LEASE_REFUSED");
        if (ref !== expected) throw new Error("DEPLOY_REF_LEASE_REFUSED");
        ref = next;
        return ref;
      },
    },
    verification: {
      async observe() {
        log.push("fresh-observation");
        if (failures.delete("observe")) throw new Error("OBSERVATION_FAILED");
        return {
          lineage: "LEGACY",
          topology: options.observed ?? {
            runtime: { frontend: applications.frontend, admin: applications.admin, commerce: applications.commerce, worker: applications.commerce },
            controlPlane: { productionDeployRefSha: ref },
          },
        };
      },
    },
    predecessorGate: {
      async isClosed() {
        log.push("gate-is-closed");
        gateChecks += 1;
        // The first read belongs to accepting the fresh observation while the
        // gate is still closed. Crash on the next read, after VERIFIED is
        // durable and immediately before the gate reconciliation begins.
        if (gateChecks > 1 && failures.delete("before-gate")) throw new Error("CRASH_BEFORE_GATE_OPEN");
        return gateClosed;
      },
      async open() {
        log.push("open-gate");
        gateClosed = false;
        if (failures.delete("after-gate")) throw new Error("CRASH_AFTER_GATE_OPEN");
      },
    },
  };
  return {
    log, failures, authority, sessions, session, receipts, ports,
    rollback: new BootstrapRollback(ports),
    run: () => new BootstrapRollback(ports).rollback(session.id, "owner"),
    gateClosed: () => gateClosed,
    ref: () => ref,
    storageRestored: () => storageRestored,
    mutateArchive: () => { archiveDigest = "0".repeat(64); },
  };
};

describe.each(releaseAuthorityStores)("production cross-lineage rollback (%s)", (_name, makeStore) => {
  it("forbids rollback permanently after NEW_LINEAGE_ONLY", async () => {
    const local = world(makeStore, { armed: true });
    await expect(local.run()).rejects.toThrow("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    expect(local.log).toEqual([]);
  });

  it("rejects a wrong predecessor hash with zero live DB/ref mutation", async () => {
    const local = world(makeStore, { fail: "archive-hash" });
    await expect(local.run()).rejects.toThrow("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_DIGEST_MISMATCH");
    expect(local.storageRestored()).toBe(false);
    expect(local.ref()).toBe(target);
    expect(local.authority.get(local.session.id)?.bootstrapRollbackId).toBeUndefined();
  });

  it("cannot restore while target runtime remains live", async () => {
    const local = world(makeStore, { fail: "runtime" });
    await expect(local.run()).rejects.toThrow("COMPOSE_RUNTIME_CONTAINERS_STILL_RUNNING");
    expect(local.log).not.toContain("archive-successor");
    expect(local.authority.get(local.session.id)?.state).toBe("RECOVERY_REQUIRED");
    expect(local.gateClosed()).toBe(true);
  });

  it("archives the launch DB before restoring predecessor and keeps the source archive immutable", async () => {
    const local = world(makeStore);
    await local.run();
    expect(local.log.indexOf("archive-successor")).toBeLessThan(local.log.indexOf("restore-predecessor"));
    expect(local.log.filter((entry) => entry === "inspect-archive")).toHaveLength(3);
    expect(local.gateClosed()).toBe(false);
  });

  it("resumes after DB restore before CAS without restoring the DB twice", async () => {
    const local = world(makeStore, { fail: "ref" });
    await expect(local.run()).rejects.toThrow("DEPLOY_REF_LEASE_REFUSED");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("DATABASE_RESTORED");
    const restores = local.log.filter((entry) => entry === "restore-predecessor").length;
    await local.run();
    expect(local.log.filter((entry) => entry === "restore-predecessor")).toHaveLength(restores);
  });

  it("re-enters storage idempotently when the process dies after atomic DB restore but before its receipt advance", async () => {
    const local = world(makeStore, { fail: "storage" });
    await expect(local.run()).rejects.toThrow("CRASH_AFTER_DATABASE_RESTORE");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("RESERVED");
    expect(local.storageRestored()).toBe(true);
    await local.run();
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMPLETED");
    expect(local.gateClosed()).toBe(false);
  });

  it("reports a ref CAS conflict and never starts Coolify rollback", async () => {
    const local = world(makeStore, { fail: "ref" });
    await expect(local.run()).rejects.toThrow("DEPLOY_REF_LEASE_REFUSED");
    expect(local.log.some((entry) => entry.startsWith("restore-frontend"))).toBe(false);
    expect(local.gateClosed()).toBe(true);
  });

  it("resumes a partial Coolify rollback without repeating a converged application", async () => {
    const local = world(makeStore, { fail: "admin" });
    await expect(local.run()).rejects.toThrow("ROLLBACK_ADMIN_FAILED");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("FRONTEND_RESTORED");
    const frontendRestores = local.log.filter((entry) => entry === "restore-frontend").length;
    await local.run();
    expect(local.log.filter((entry) => entry === "restore-frontend")).toHaveLength(frontendRestores);
  });

  it("refuses completion when ref is restored but one fresh surface remains target", async () => {
    const local = world(makeStore, { observed: {
      runtime: { ...before.runtime, worker: target }, controlPlane: before.controlPlane,
    } });
    await expect(local.run()).rejects.toThrow("PREDECESSOR_TOPOLOGY_NOT_RESTORED");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMMERCE_RESTORED");
    expect(local.gateClosed()).toBe(true);
  });

  it("resumes after convergence before gate open and completes the receipt last", async () => {
    const local = world(makeStore, { fail: "before-gate" });
    await expect(local.run()).rejects.toThrow("CRASH_BEFORE_GATE_OPEN");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("VERIFIED");
    expect(local.gateClosed()).toBe(true);
    const beforeRetry = local.log.length;
    await local.run();
    expect(local.log.slice(beforeRetry)).toEqual([
      "inspect-archive", "gate-is-closed", "open-gate", "gate-is-closed",
    ]);
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMPLETED");
    expect(local.gateClosed()).toBe(false);
  });

  it("resumes after gate open before COMPLETED without repeating recovery work", async () => {
    const local = world(makeStore, { fail: "after-gate" });
    await expect(local.run()).rejects.toThrow("CRASH_AFTER_GATE_OPEN");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("VERIFIED");
    expect(local.gateClosed()).toBe(false);
    const beforeRetry = local.log.length;
    await local.run();
    expect(local.log.slice(beforeRetry)).toEqual(["inspect-archive", "gate-is-closed", "gate-is-closed"]);
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMPLETED");
    expect(local.log.filter((entry) => entry === "restore-predecessor")).toHaveLength(1);
    expect(local.log.filter((entry) => entry.startsWith("restore-frontend"))).toHaveLength(1);
  });

  it("re-proves observation and gate after COMPLETED before returning exit success", async () => {
    const local = world(makeStore);
    await local.run();
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMPLETED");
    const beforeRetry = local.log.length;
    await local.run();
    expect(local.log.slice(beforeRetry)).toEqual(["inspect-archive", "gate-is-closed"]);
    expect(local.gateClosed()).toBe(false);
    expect(local.log.filter((entry) => entry === "restore-predecessor")).toHaveLength(1);
  });

  it("refuses completion if fresh observation itself fails", async () => {
    const local = world(makeStore, { fail: "observe" });
    await expect(local.run()).rejects.toThrow("OBSERVATION_FAILED");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMMERCE_RESTORED");
    expect(local.log).not.toContain("open-gate");
  });

  it("continues the same receipt after process restart without a successor session row", async () => {
    const local = world(makeStore, { fail: "admin" });
    await expect(local.run()).rejects.toThrow("ROLLBACK_ADMIN_FAILED");
    const restarted = new BootstrapRollback({ ...local.ports, authority: new InMemoryReleaseAuthorityStore() });
    await restarted.rollback(local.session.id, "new-owner");
    expect(local.receipts.read(bootstrapRollbackId(local.session.id))?.stage).toBe("COMPLETED");
  });

  it("detects immutable predecessor archive drift before final observation", async () => {
    const local = world(makeStore, { fail: "commerce" });
    await expect(local.run()).rejects.toThrow("ROLLBACK_COMMERCE_FAILED");
    local.mutateArchive();
    await expect(local.run()).rejects.toThrow("PREDECESSOR_ARCHIVE_CHANGED");
    expect(local.gateClosed()).toBe(true);
  });
});
