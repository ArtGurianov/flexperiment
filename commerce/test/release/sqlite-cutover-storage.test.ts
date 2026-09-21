import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createCutoverEnvelope } from "../../src/release/cutover-envelope";
import { SqliteCutoverStorage } from "../../src/release/sqlite-cutover-storage";
import { classifySchemaLineage } from "../../src/release/schema-identity";
import { openReadOnlyDatabase, readSchemaIdentity } from "../../src/db";

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
  const storage = new SqliteCutoverStorage({
    databasePath: database, replacementRoot: replacement, stateDirectory: state,
    archiveDirectory: archive, envelopeDirectory: envelopes,
    journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"),
  });
  return { root, replacement, state, archive, envelopes, database, storage };
};

const envelope = (database: { ref: string; sha256: string }) => createCutoverEnvelope({
  cutoverId: "cutover-1", adoptionNonce: "nonce-1", targetSha: target, mode: "MAINTENANCE_CUTOVER",
  preDeployTopology: { runtime: { frontend: predecessor, admin: predecessor, commerce: predecessor, worker: predecessor }, controlPlane: { productionDeployRefSha: predecessor } },
  predecessorDatabase: database, createdAt: "2026-09-21T00:00:00.000Z", expiresAt: "2026-09-21T06:00:00.000Z",
});

describe("physical SQLite launch handoff", () => {
  it("takes two checked online backups, writes an archive identity before moving it, and bootstraps through db.ts", async () => {
    const { database, archive, storage } = fixture();
    const backups = await storage.verifyOnlineBackups("cutover-1");
    expect(backups).toHaveLength(2);
    expect(backups[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(backups[1]!.sha256).toMatch(/^[a-f0-9]{64}$/);

    const planned = await storage.prepareArchive("cutover-1");
    expect(existsSync(planned.ref)).toBe(false);
    await storage.ensureArchivedAndFresh(envelope(planned));

    expect(sha(join(archive, "cutover-1.predecessor.sqlite"))).toBe(planned.sha256);
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("resumes after envelope-before-rename and after fresh-db-before-deploy without a second move", async () => {
    const { database, archive, storage } = fixture();
    const planned = await storage.prepareArchive("cutover-1");
    const handoff = envelope(planned);
    // This is the durable-envelope / before-rename crash: no archive exists.
    await storage.ensureArchivedAndFresh(handoff);
    const firstArchiveHash = sha(join(archive, "cutover-1.predecessor.sqlite"));
    await storage.ensureArchivedAndFresh(handoff);
    expect(sha(join(archive, "cutover-1.predecessor.sqlite"))).toBe(firstArchiveHash);
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("resumes after an atomic rename completed but before fresh db.ts bootstrap", async () => {
    const { database, storage } = fixture();
    const planned = await storage.prepareArchive("cutover-1");
    // Simulate the power loss after rename/fsync but before fresh-db creation.
    renameSync(database, planned.ref);
    await storage.ensureArchivedAndFresh(envelope(planned));
    const launched = openReadOnlyDatabase(database);
    try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
  });

  it("never overwrites an archive target and refuses an archive paired with a still-live legacy database", async () => {
    const { database, archive, storage } = fixture();
    const planned = await storage.prepareArchive("cutover-1");
    const copied = join(archive, "cutover-1.predecessor.sqlite");
    copyFileSync(database, copied);
    await expect(storage.prepareArchive("cutover-1")).rejects.toMatchObject({ code: "CUTOVER_STORAGE_ARCHIVE_ALREADY_EXISTS" });
    await expect(storage.ensureArchivedAndFresh(envelope(planned))).rejects.toMatchObject({ code: "CUTOVER_STORAGE_ARCHIVE_AND_LEGACY_PRESENT" });
  });

  it("archives the successor, then restores the predecessor through a checked temporary file without consuming the archive", async () => {
    const { archive, database, storage } = fixture();
    const planned = await storage.prepareArchive("cutover-1");
    await storage.ensureArchivedAndFresh(envelope(planned));
    const successor = await storage.archiveSuccessor("rollback-1");
    expect(existsSync(database)).toBe(false);
    await storage.restorePredecessor({ ref: planned.ref, sha256: planned.sha256 });
    expect(storage.restedFileSha256()).toBe(planned.sha256);
    expect(sha(planned.ref)).toBe(planned.sha256);
    expect(sha(join(archive, "rollback-1.successor.sqlite"))).toBe(successor.sha256);
  });

  it("rejects state under the replaceable namespace and any symlinked path", () => {
    const { root, replacement, state, archive, envelopes, database } = fixture();
    expect(() => new SqliteCutoverStorage({
      databasePath: database, replacementRoot: replacement, stateDirectory: replacement,
      archiveDirectory: archive, envelopeDirectory: envelopes,
      journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"),
    })).toThrow("CUTOVER_STORAGE_STATE_NAMESPACE_INVALID");

    const alias = join(root, "state-alias");
    symlinkSync(state, alias);
    expect(() => new SqliteCutoverStorage({
      databasePath: database, replacementRoot: replacement, stateDirectory: alias,
      archiveDirectory: archive, envelopeDirectory: envelopes,
      journalPath: join(state, "release.jsonl"), lockPath: join(state, "release.lock"),
    })).toThrow("CUTOVER_STORAGE_SYMLINK_REFUSED");
  });

  it("refuses to move a main file while a live WAL writer prevents a clean checkpoint", async () => {
    const { database, storage } = fixture();
    const writer = new Database(database);
    try {
      writer.pragma("journal_mode = WAL");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO legacy_payload VALUES ('uncheckpointed')").run();
      await expect(storage.prepareArchive("cutover-1")).rejects.toMatchObject({ code: "CUTOVER_STORAGE_WAL_STILL_ACTIVE" });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
