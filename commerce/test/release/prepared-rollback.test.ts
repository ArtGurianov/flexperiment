import { describe, expect, it } from "vitest";
import {
  BootstrapRollback, InMemoryBootstrapRollbackReceiptStore, preparedRollbackId, bootstrapRollbackId,
  type BootstrapRollbackPorts, type DatabaseArchive,
} from "../../src/release/bootstrap-rollback";
import { canonicalEnvelopeSha256, createCutoverEnvelope, InMemoryCutoverEnvelopeStore } from "../../src/release/cutover-envelope";
import { DeploySessions, type DeploymentObservation, type ReleaseAuthorityStore } from "../../src/release/deploy-session";
import { releaseAuthorityStores } from "../support/release-authority-stores";
import { RuntimeQuiescenceAuthority, type RuntimeLeaseBinding } from "../../src/release/runtime-quiescence-authority";

/**
 * The state `prepare-bootstrap` leaves behind when the deploy that should have
 * followed never created a session.
 *
 * This is not a hypothetical. On 2026-09-23 a launch `deploy` refused before
 * `acquireFenced` — envelope durable, predecessor archived, launch database
 * installed, sales fenced, and no session for `resume` or `rollback` to name.
 * The runner had no command for a state it had itself produced, and recovery
 * was a sequence of shell commands. These prove that state now has an owner.
 */

const target = "a".repeat(40);
const predecessor = "b".repeat(40);
const CUTOVER = "cutover-prepared";
const before: DeploymentObservation = {
  runtime: { frontend: predecessor, admin: predecessor, commerce: predecessor, worker: predecessor },
  controlPlane: { productionDeployRefSha: predecessor },
};
const successorDatabase: DatabaseArchive = { ref: "/state/archive/successor.sqlite", sha256: "f".repeat(64) };
const predecessorDatabase: DatabaseArchive = { ref: "/state/archive/predecessor.sqlite", sha256: "e".repeat(64) };
const now = new Date("2026-09-23T00:00:00.000Z");

type Failure = "archive-hash" | "runtime" | "storage" | "ref" | "frontend" | "admin" | "commerce" | "observe" | "before-gate" | "after-gate";

/**
 * A prepared world: the predecessor is archived and fenced, the launch schema
 * is installed, and nothing has adopted the envelope.
 */
const world = (
  makeStore: () => ReleaseAuthorityStore,
  options: { fail?: Failure; lineage?: string; expiresAt?: string; consumed?: boolean; adopt?: boolean; ref?: string } = {},
) => {
  const log: string[] = [];
  const failures = new Set(options.fail ? [options.fail] : []);
  const authority = makeStore();
  const sessions = new DeploySessions(authority, () => now, 60_000);
  const envelopes = new InMemoryCutoverEnvelopeStore();
  const envelope = createCutoverEnvelope({
    cutoverId: CUTOVER, adoptionNonce: "nonce-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
    preDeployTopology: before, predecessorDatabase,
    createdAt: now.toISOString(),
    expiresAt: options.expiresAt ?? "2026-09-24T00:00:00.000Z",
  });
  envelopes.write(envelope);
  if (options.consumed) envelopes.markConsumed(envelope.cutoverId);
  if (options.adopt) {
    sessions.acquireFenced({
      id: "successor", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
      adoptedCutoverId: envelope.cutoverId, adoptedEnvelopeSha256: canonicalEnvelopeSha256(envelope),
      predecessorDatabaseRef: predecessorDatabase.ref, predecessorDatabaseSha256: predecessorDatabase.sha256,
    }, before);
  }

  const receipts = new InMemoryBootstrapRollbackReceiptStore();
  // Faithful to what `prepare-bootstrap` leaves: nothing was ever deployed, so
  // frontend and admin still serve the predecessor and the pointer never moved.
  // Commerce is the exception - quiescence stopped it, so it is at nothing and
  // is the one surface a prepared restore actually has to bring back.
  const applications: Record<"frontend" | "admin" | "commerce", string> = {
    frontend: predecessor, admin: predecessor, commerce: "",
  };
  let ref = options.ref ?? predecessor;
  let gateClosed = true;
  let gateChecks = 0;
  let archiveDigest = predecessorDatabase.sha256;
  let storageRestored = false;
  let lineage = options.lineage ?? "SUPPORTED";
  const runtimeAuthority = new RuntimeQuiescenceAuthority(() => 0);
  const binding: RuntimeLeaseBinding = {
    sessionId: preparedRollbackId(CUTOVER), operation: "RESTORE", databasePath: "/db",
    databaseIdentity: { canonicalPath: "/db", dev: 1, ino: 2 },
    applicationUuid: "commerce-uuid", applicationResourceId: "3",
    lockOwner: "runner",
  };

  const ports: BootstrapRollbackPorts = {
    authority, envelopes, receipts, clock: () => now,
    lineage: () => lineage,
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
          topology: {
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
  const rollback = new BootstrapRollback(ports);
  return {
    log, failures, authority, envelopes, receipts, ports, rollback,
    run: () => rollback.rollbackPrepared(CUTOVER),
    gateClosed: () => gateClosed,
    ref: () => ref,
    storageRestored: () => storageRestored,
    setLineage: (value: string) => { lineage = value; },
    applications,
    mutateArchive: () => { archiveDigest = "0".repeat(64); },
  };
};

/** Nothing irreversible happened: no database swap, no pointer move, no restart. */
const untouched = (local: ReturnType<typeof world>, ref = predecessor) => {
  expect(local.storageRestored()).toBe(false);
  expect(local.ref()).toBe(ref);
  expect(local.gateClosed()).toBe(true);
  expect(local.log.filter((entry) => entry.startsWith("restore-") || entry.startsWith("cas-ref"))).toEqual([]);
};

describe.each(releaseAuthorityStores)("rollback of a prepared cutover nobody adopted (%s)", (_name, makeStore) => {
  it("restores the predecessor and reopens sales, from the envelope alone", async () => {
    const local = world(makeStore);
    const receipt = await local.run();

    expect(receipt.stage).toBe("COMPLETED");
    expect(receipt.intent.authority).toEqual({ kind: "PREPARED_CUTOVER", cutoverId: CUTOVER });
    expect(receipt.intent.predecessorDatabase).toEqual(predecessorDatabase);
    expect(local.storageRestored()).toBe(true);
    expect(local.ref()).toBe(predecessor);
    expect(local.gateClosed()).toBe(false);
  });

  it("never invents a successor session to justify itself", async () => {
    const local = world(makeStore);
    await local.run();
    // The fact being represented is that adoption never happened. A synthetic
    // session would assert the opposite and make the envelope look consumed.
    expect(local.authority.deploymentGate().deploymentSessionId).toBeNull();
    expect(local.authority.findByAdoptedCutover(CUTOVER)).toBeUndefined();
    expect(local.envelopes.isConsumed(CUTOVER)).toBe(false);
  });

  it("restores a cutover whose envelope has expired", async () => {
    // Expiry is an admission condition for going FORWARD. It cannot revoke the
    // ability to put the predecessor back, or a cutover left overnight would
    // become unrecoverable by the clock alone.
    const local = world(makeStore, { expiresAt: "2026-09-23T00:00:00.001Z" });
    const receipt = await local.rollback.rollbackPrepared(CUTOVER);
    expect(receipt.stage).toBe("COMPLETED");
    expect(local.gateClosed()).toBe(false);
  });

  it("refuses when a successor session already adopted the cutover", async () => {
    const local = world(makeStore, { adopt: true, consumed: true });
    await expect(local.run()).rejects.toThrow("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION");
    untouched(local);
  });

  it("refuses a consumed envelope even with no session visible", async () => {
    // Consumption is written only after the successor database committed, so a
    // consumed envelope means a session existed. Restoring over it would race
    // that session's own rollback.
    const local = world(makeStore, { consumed: true });
    await expect(local.run()).rejects.toThrow("PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION");
    untouched(local);
  });

  it("refuses when the live database is not the prepared successor", async () => {
    const local = world(makeStore, { lineage: "LEGACY" });
    await expect(local.run()).rejects.toThrow("PREPARED_ROLLBACK_SUCCESSOR_NOT_INSTALLED");
    untouched(local);
  });

  it("refuses when the deploy pointer moved although nothing adopted the cutover", async () => {
    const local = world(makeStore, { ref: target });
    await expect(local.run()).rejects.toThrow("PREPARED_ROLLBACK_REF_MOVED");
    untouched(local, target);
  });

  it("refuses a corrupt predecessor archive before touching the live database", async () => {
    const local = world(makeStore, { fail: "archive-hash" });
    await expect(local.run()).rejects.toThrow("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_DIGEST_MISMATCH");
    untouched(local);
    expect(local.receipts.read(preparedRollbackId(CUTOVER))).toBeUndefined();
  });

  it("keeps its receipt in a namespace the session path cannot address", async () => {
    const local = world(makeStore);
    await local.run();
    expect(local.receipts.read(preparedRollbackId(CUTOVER))).toBeDefined();
    // The session-authority id for the same string is a different receipt, so
    // neither command can resume the other's durable intent.
    expect(preparedRollbackId(CUTOVER)).not.toBe(bootstrapRollbackId(CUTOVER));
    expect(local.receipts.read(bootstrapRollbackId(CUTOVER))).toBeUndefined();
  });

  it("re-proves completion instead of restoring twice", async () => {
    const local = world(makeStore);
    await local.run();
    const before = [...local.log];
    const again = await local.run();
    expect(again.stage).toBe("COMPLETED");
    // No second database swap, pointer move or restart.
    expect(local.log.slice(before.length).filter((entry) =>
      entry.startsWith("restore-") || entry.startsWith("cas-ref") || entry === "archive-successor")).toEqual([]);
  });

  it("reconciles a RESERVED receipt forward when the database already crossed", async () => {
    // The crash this exists for: the process died after the atomic restore but
    // before advancing the receipt. Replaying RESERVED there would archive the
    // predecessor as though it were the successor.
    const local = world(makeStore, { fail: "storage" });
    await expect(local.run()).rejects.toThrow();
    expect(local.receipts.read(preparedRollbackId(CUTOVER))?.stage).toBe("RESERVED");

    local.setLineage("LEGACY");
    const before = local.log.filter((entry) => entry === "archive-successor").length;
    const receipt = await local.run();
    expect(receipt.stage).toBe("COMPLETED");
    // No second database swap: the receipt agreed with reality instead.
    expect(local.log.filter((entry) => entry === "archive-successor").length).toBe(before);
  });

  it("refuses a RESERVED receipt over a database it cannot account for", async () => {
    const local = world(makeStore, { fail: "storage" });
    await expect(local.run()).rejects.toThrow();
    local.setLineage("UNKNOWN");
    await expect(local.run()).rejects.toThrow("BOOTSTRAP_ROLLBACK_LINEAGE_UNACCOUNTED");
  });

  it("requires an exact cutover id and never selects an envelope implicitly", async () => {
    const local = world(makeStore);
    await expect(local.rollback.rollbackPrepared("some-other-cutover")).rejects.toThrow("CUTOVER_ENVELOPE_NOT_FOUND");
    untouched(local);
  });
});

describe.each(releaseAuthorityStores)("a prepared rollback resumes from its durable stage (%s)", (_name, makeStore) => {
  // The ref, frontend and admin stages are genuine no-ops here and cannot fail:
  // nothing was ever deployed, so the pointer and those two surfaces are
  // already at the predecessor. Commerce is the surface quiescence stopped.
  const stages: { readonly fail: Failure; readonly reached: string }[] = [
    { fail: "storage", reached: "RESERVED" },
    { fail: "commerce", reached: "ADMIN_RESTORED" },
    { fail: "observe", reached: "COMMERCE_RESTORED" },
    { fail: "before-gate", reached: "VERIFIED" },
  ];

  it.each(stages)("continues after a crash at $fail rather than starting over", async ({ fail, reached }) => {
    const local = world(makeStore, { fail });
    await expect(local.run()).rejects.toThrow();
    expect(local.receipts.read(preparedRollbackId(CUTOVER))?.stage).toBe(reached);

    // A second invocation picks up the same durable intent and finishes.
    const receipt = await local.run();
    expect(receipt.stage).toBe("COMPLETED");
    expect(local.gateClosed()).toBe(false);
    expect(local.ref()).toBe(predecessor);
  });

  it("writes durable intent before the first irreversible step", async () => {
    const local = world(makeStore, { fail: "runtime" });
    await expect(local.run()).rejects.toThrow("COMPOSE_RUNTIME_CONTAINERS_STILL_RUNNING");
    // The receipt exists even though nothing was restored: a process that dies
    // after replacing the database must not lose its only recovery cursor,
    // because that database is the thing being replaced.
    expect(local.receipts.read(preparedRollbackId(CUTOVER))?.stage).toBe("RESERVED");
    expect(local.storageRestored()).toBe(false);
  });
});
