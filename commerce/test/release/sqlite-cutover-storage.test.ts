import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createCutoverEnvelope } from "../../src/release/cutover-envelope";
import { SqliteCutoverStorage } from "../../src/release/sqlite-cutover-storage";
import { classifySchemaLineage } from "../../src/release/schema-identity";
import { openReadOnlyDatabase, readSchemaIdentity } from "../../src/db";
import { RuntimeQuiescenceAuthority, type RuntimeLeaseBinding, type RuntimeLeaseOperation } from "../../src/release/runtime-quiescence-authority";

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const predecessor = "b".repeat(40);
const target = "a".repeat(40);

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-cutover-"));
  const replacement = join(root, "replacement");
  const state = join(root, "release-state");
  const archive = join(state, "archives");
  const envelopes = join(state, "envelopes");
  mkdirSync(replacement); mkdirSync(state); mkdirSync(archive); mkdirSync(envelopes);
  const database = join(replacement, "commerce.sqlite");
  const db = new Database(database);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY); INSERT INTO schema_migrations VALUES ('legacy'); CREATE TABLE legacy_payload (value TEXT NOT NULL); INSERT INTO legacy_payload VALUES ('real clone payload');");
  db.close();
  let now = 0;
  const authority = new RuntimeQuiescenceAuthority(() => now, 10);
  const revalidation = {
    async assertLockHeld() {}, async assertDatabaseIdentity() {}, async assertUnitsStopped() {}, async assertNoSqliteHandles() {},
  };
  const storage = new SqliteCutoverStorage({
    databasePath: database, replacementRoot: replacement, stateDirectory: state,
    archiveDirectory: archive, envelopeDirectory: envelopes,
    journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"), authority, revalidation,
  });
  let lastIdentity = (() => { const stat = statSync(database); return { canonicalPath: realpathSync(database), dev: stat.dev, ino: stat.ino }; })();
  const grant = (operation: RuntimeLeaseOperation, sessionId: string, override: Partial<RuntimeLeaseBinding> = {}) => {
    if (existsSync(database)) { const stat = statSync(database); lastIdentity = { canonicalPath: realpathSync(database), dev: stat.dev, ino: stat.ino }; }
    const binding: RuntimeLeaseBinding = {
      sessionId, operation, databasePath: database, databaseIdentity: lastIdentity,
      applicationUuid: "commerce-uuid", applicationResourceId: "3", lockOwner: "runner-1", ...override,
    };
    return { lease: authority.acquire(binding), binding };
  };
  return { root, replacement, state, archive, envelopes, database, storage, authority, grant, expire: () => { now = 11; }, revalidation };
};

const envelope = (database: { ref: string; sha256: string }) => createCutoverEnvelope({
  cutoverId: "cutover-1", adoptionNonce: "nonce-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
  preDeployTopology: { runtime: { frontend: predecessor, admin: predecessor, commerce: predecessor, worker: predecessor }, controlPlane: { productionDeployRefSha: predecessor } },
  predecessorDatabase: database, createdAt: "2026-09-21T00:00:00.000Z", expiresAt: "2026-09-21T06:00:00.000Z",
});

describe("physical SQLite launch handoff", () => {
  it("takes two checked online backups, writes an archive identity before moving it, and bootstraps through db.ts", async () => {
    const { database, archive, storage, grant } = fixture();
    const backups = await storage.createVerifiedBackups("cutover-1");
    expect(backups).toHaveLength(2);
    expect(backups[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backups[1]!.sha256).toMatch(/^[a-f0-9]{64}$/);

    const first = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", first.lease, first.binding);
    expect(existsSync(planned.ref)).toBe(false);
    const second = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(envelope(planned), second.lease, second.binding);

    expect(sha(join(archive, "cutover-1.predecessor.sqlite"))).toBe(planned.sha256);
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("resumes after envelope-before-rename and after fresh-db-before-deploy without a second move", async () => {
    const { database, archive, storage, grant } = fixture();
    const first = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", first.lease, first.binding);
    const handoff = envelope(planned);
    // This is the durable-envelope / before-rename crash: no archive exists.
    let next = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(handoff, next.lease, next.binding);
    const firstArchiveHash = sha(join(archive, "cutover-1.predecessor.sqlite"));
    next = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(handoff, next.lease, next.binding);
    expect(sha(join(archive, "cutover-1.predecessor.sqlite"))).toBe(firstArchiveHash);
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("resumes after an atomic rename completed but before fresh db.ts bootstrap", async () => {
    const { database, storage, grant } = fixture();
    let next = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", next.lease, next.binding);
    // Simulate the power loss after rename/fsync but before fresh-db creation.
    renameSync(database, planned.ref);
    next = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(envelope(planned), next.lease, next.binding);
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("never overwrites an archive target and refuses an archive paired with a still-live legacy database", async () => {
    const { database, archive, storage, grant } = fixture();
    let next = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", next.lease, next.binding);
    const copied = join(archive, "cutover-1.predecessor.sqlite");
    copyFileSync(database, copied);
    next = grant("PREPARE", "cutover-1");
    await expect(storage.prepareArchive("cutover-1", next.lease, next.binding)).rejects.toMatchObject({ code: "CUTOVER_STORAGE_ARCHIVE_ALREADY_EXISTS" });
    next = grant("PREPARE", "cutover-1");
    await expect(storage.ensureArchivedAndFresh(envelope(planned), next.lease, next.binding)).rejects.toMatchObject({ code: "CUTOVER_STORAGE_ARCHIVE_AND_LEGACY_PRESENT" });
  });

  it("archives the successor and restores the predecessor under one consumed RESTORE lease", async () => {
    const { archive, storage, grant } = fixture();
    let next = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", next.lease, next.binding);
    next = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(envelope(planned), next.lease, next.binding);
    next = grant("RESTORE", "rollback-1");
    const restored = await storage.restore("rollback-1", { ref: planned.ref, sha256: planned.sha256 }, next.lease, next.binding);
    expect(storage.restedFileSha256()).toBe(planned.sha256);
    expect(sha(planned.ref)).toBe(planned.sha256);
    expect(sha(join(archive, "rollback-1.successor.sqlite"))).toBe(restored.successorDatabase.sha256);
    const replay = grant("RESTORE", "rollback-1");
    await expect(storage.restore("rollback-1", { ref: planned.ref, sha256: planned.sha256 }, replay.lease, replay.binding))
      .resolves.toEqual(restored);
  });

  it("resumes after the no-overwrite launch archive is durable but before predecessor rename", async () => {
    const { archive, database, storage, grant } = fixture();
    let next = grant("PREPARE", "cutover-1");
    const planned = await storage.prepareArchive("cutover-1", next.lease, next.binding);
    next = grant("PREPARE", "cutover-1");
    await storage.ensureArchivedAndFresh(envelope(planned), next.lease, next.binding);
    const launchHash = sha(database);
    copyFileSync(database, join(archive, "rollback-1.successor.sqlite"));

    next = grant("RESTORE", "rollback-1");
    const restored = await storage.restore("rollback-1", planned, next.lease, next.binding);
    expect(restored.successorDatabase.sha256).toBe(launchHash);
    expect(storage.restedFileSha256()).toBe(planned.sha256);
    expect(sha(planned.ref)).toBe(planned.sha256);
  });

  it("rejects state under the replaceable namespace and any symlinked path", () => {
    const { root, replacement, state, archive, envelopes, database, authority, revalidation } = fixture();
    expect(() => new SqliteCutoverStorage({
      databasePath: database, replacementRoot: replacement, stateDirectory: replacement,
      archiveDirectory: archive, envelopeDirectory: envelopes,
      journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"), authority, revalidation,
    })).toThrow("CUTOVER_STORAGE_STATE_NAMESPACE_INVALID");

    const alias = join(root, "state-alias");
    symlinkSync(state, alias);
    expect(() => new SqliteCutoverStorage({
      databasePath: database, replacementRoot: replacement, stateDirectory: alias,
      archiveDirectory: archive, envelopeDirectory: envelopes,
      journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"), authority, revalidation,
    })).toThrow("CUTOVER_STORAGE_SYMLINK_REFUSED");
  });

  it("refuses to move a main file while a live WAL writer prevents a clean checkpoint", async () => {
    const { database, storage, grant } = fixture();
    const writer = new Database(database);
    try {
      writer.pragma("journal_mode = WAL");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO legacy_payload VALUES ('uncheckpointed')").run();
      const next = grant("PREPARE", "cutover-1");
      await expect(storage.prepareArchive("cutover-1", next.lease, next.binding)).rejects.toMatchObject({ code: "CUTOVER_STORAGE_WAL_STILL_ACTIVE" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("rejects a lease issued by another authority before any SQLite mutation", async () => {
    const { storage, grant, database } = fixture();
    const before = sha(database);
    const expected = grant("PREPARE", "cutover-1");
    const foreignAuthority = new RuntimeQuiescenceAuthority(() => 0);
    const foreignLease = foreignAuthority.acquire(expected.binding);
    await expect(storage.prepareArchive("cutover-1", foreignLease, expected.binding)).rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
    expect(sha(database)).toBe(before);
    // The local authority still issues a capability after the refusal.
    const local = grant("PREPARE", "cutover-1");
    await expect(storage.prepareArchive("cutover-1", local.lease, local.binding)).resolves.toBeDefined();
  });

  it("rejects expired, wrong-direction, and mismatched bindings with zero durable mutation", async () => {
    const expired = fixture();
    const expiredGrant = expired.grant("PREPARE", "cutover-1");
    const before = sha(expired.database);
    expired.expire();
    await expect(expired.storage.prepareArchive("cutover-1", expiredGrant.lease, expiredGrant.binding))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_EXPIRED" });
    expect(sha(expired.database)).toBe(before);

    const wrongDirection = fixture();
    const wrongDirectionBefore = sha(wrongDirection.database);
    const restore = wrongDirection.grant("RESTORE", "cutover-1");
    await expect(wrongDirection.storage.prepareArchive("cutover-1", restore.lease, restore.binding))
      .rejects.toMatchObject({ code: "CUTOVER_STORAGE_QUIESCENCE_DIRECTION_MISMATCH" });
    expect(sha(wrongDirection.database)).toBe(wrongDirectionBefore);

    const mismatch = fixture();
    const original = mismatch.grant("PREPARE", "cutover-1");
    const changed: RuntimeLeaseBinding = { ...original.binding, applicationUuid: "other-uuid" };
    const mismatchBefore = sha(mismatch.database);
    await expect(mismatch.storage.prepareArchive("cutover-1", original.lease, changed))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_BINDING_MISMATCH" });
    expect(sha(mismatch.database)).toBe(mismatchBefore);
  });

  it("destroys the token after consume even when storage fails, and accepts a new lease for retry", async () => {
    const { archive, database, storage, grant } = fixture();
    copyFileSync(database, join(archive, "cutover-1.predecessor.sqlite"));
    const consumed = grant("PREPARE", "cutover-1");
    await expect(storage.prepareArchive("cutover-1", consumed.lease, consumed.binding))
      .rejects.toMatchObject({ code: "CUTOVER_STORAGE_ARCHIVE_ALREADY_EXISTS" });
    await expect(storage.prepareArchive("cutover-1", consumed.lease, consumed.binding))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });

    const retry = grant("PREPARE", "cutover-2");
    await expect(storage.prepareArchive("cutover-2", retry.lease, retry.binding)).resolves.toBeDefined();
  });

  it("never crosses PREPARE and RESTORE capabilities", async () => {
    const prepareFixture = fixture();
    const prepare = prepareFixture.grant("PREPARE", "rollback-1");
    await expect(prepareFixture.storage.restore("rollback-1", { ref: join(prepareFixture.archive, "missing.sqlite"), sha256: "0".repeat(64) }, prepare.lease, prepare.binding))
      .rejects.toMatchObject({ code: "CUTOVER_STORAGE_QUIESCENCE_DIRECTION_MISMATCH" });

    const restoreFixture = fixture();
    const restore = restoreFixture.grant("RESTORE", "cutover-1");
    await expect(restoreFixture.storage.prepareArchive("cutover-1", restore.lease, restore.binding))
      .rejects.toMatchObject({ code: "CUTOVER_STORAGE_QUIESCENCE_DIRECTION_MISMATCH" });
  });

  it("allows at most one parallel mutation attempt with one token", async () => {
    const { storage, grant } = fixture();
    const shared = grant("PREPARE", "cutover-1");
    const results = await Promise.allSettled([
      storage.prepareArchive("cutover-1", shared.lease, shared.binding),
      storage.prepareArchive("cutover-1", shared.lease, shared.binding),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused).toMatchObject({ reason: { code: "RUNTIME_LEASE_INVALID" } });
  });

  it("does not write the envelope callback before successful consume", async () => {
    const local = fixture();
    const predecessorIdentity = local.grant("PREPARE", "cutover-1");
    const planned = await local.storage.prepareArchive("cutover-1", predecessorIdentity.lease, predecessorIdentity.binding);
    const expected = local.grant("PREPARE", "cutover-1");
    const foreignAuthority = new RuntimeQuiescenceAuthority(() => 0);
    const foreign = foreignAuthority.acquire(expected.binding);
    let writes = 0;
    await expect(local.storage.ensureArchivedAndFresh(envelope(planned), foreign, expected.binding, () => { writes += 1; }))
      .rejects.toMatchObject({ code: "RUNTIME_LEASE_INVALID" });
    expect(writes).toBe(0);
  });
});
