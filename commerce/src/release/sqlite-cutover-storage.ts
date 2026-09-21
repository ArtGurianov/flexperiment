import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync,
  realpathSync, readFileSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { migrate, openDatabase, readSchemaIdentity } from "../db";
import { classifySchemaLineage } from "./schema-identity";
import type { CutoverEnvelope, PredecessorDatabase } from "./cutover-envelope";
import type { DatabaseArchive } from "./bootstrap-rollback";
import {
  RuntimeQuiescenceAuthority,
  type RuntimeLeaseBinding,
  type RuntimeLeaseRevalidation,
  type RuntimeQuiescenceLease,
} from "./runtime-quiescence-authority";

/** A named refusal is safer than letting an fs error choose a recovery path. */
export class SqliteCutoverStorageError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

export type OnlineBackupEvidence = { readonly path: string; readonly sha256: string };

export type SqliteCutoverStorageOptions = {
  /** Existing live SQLite file, inside the namespace that is about to be replaced. */
  readonly databasePath: string;
  /** Existing directory whose contents are allowed to be replaced at launch. */
  readonly replacementRoot: string;
  /** Existing runner-owned root, outside replacementRoot but on the same device. */
  readonly stateDirectory: string;
  readonly archiveDirectory: string;
  readonly envelopeDirectory: string;
  readonly journalPath: string;
  readonly lockPath: string;
  /** Shared process-local capability authority; there is no construction path without it. */
  readonly authority: RuntimeQuiescenceAuthority;
  readonly revalidation: RuntimeLeaseRevalidation;
};

type Layout = {
  readonly database: string;
  readonly databaseDirectory: string;
  readonly replacementRoot: string;
  readonly stateDirectory: string;
  readonly archiveDirectory: string;
  readonly envelopeDirectory: string;
  readonly journalPath: string;
  readonly lockPath: string;
};

const cutoverId = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes("..")) {
    throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ID_INVALID");
  }
  return value;
};

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const fsyncDirectory = (path: string) => {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

const fsyncFile = (path: string) => {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

const inside = (path: string, root: string) => {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("..") && !value.includes(`..${sep}`) && !isAbsolute(value));
};

/**
 * Resolving a configured path is not enough: a symlink can make a path look
 * like it belongs to the database volume while naming a different mount. The
 * runner accepts only existing, already-canonical directories and files.
 */
const canonicalDirectory = (path: string, code: string): string => {
  let actual: string;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SYMLINK_REFUSED", path);
    if (!entry.isDirectory()) throw new Error("not a directory");
    actual = realpathSync(path);
  } catch (error) {
    if (error instanceof SqliteCutoverStorageError) throw error;
    throw new SqliteCutoverStorageError(code, path);
  }
  if (resolve(path) !== actual) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SYMLINK_REFUSED", path);
  return actual;
};

const canonicalFile = (path: string, code: string): string => {
  let actual: string;
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SYMLINK_REFUSED", path);
    if (!entry.isFile()) throw new Error("not a file");
    actual = realpathSync(path);
  } catch (error) {
    if (error instanceof SqliteCutoverStorageError) throw error;
    throw new SqliteCutoverStorageError(code, path);
  }
  if (resolve(path) !== actual) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SYMLINK_REFUSED", path);
  return actual;
};

const canonicalPlannedFile = (path: string, code: string): string => {
  const parent = canonicalDirectory(dirname(path), code);
  const name = basename(path);
  if (!name || name === "." || name === "..") throw new SqliteCutoverStorageError(code, path);
  const result = join(parent, name);
  if (resolve(path) !== result) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SYMLINK_REFUSED", path);
  return result;
};

const layout = (options: SqliteCutoverStorageOptions): Layout => {
  const database = canonicalFile(options.databasePath, "CUTOVER_STORAGE_DATABASE_MISSING");
  const databaseDirectory = canonicalDirectory(dirname(database), "CUTOVER_STORAGE_DATABASE_DIRECTORY_MISSING");
  const replacementRoot = canonicalDirectory(options.replacementRoot, "CUTOVER_STORAGE_REPLACEMENT_ROOT_MISSING");
  const stateDirectory = canonicalDirectory(options.stateDirectory, "CUTOVER_STORAGE_STATE_DIRECTORY_MISSING");
  const archiveDirectory = canonicalDirectory(options.archiveDirectory, "CUTOVER_STORAGE_ARCHIVE_DIRECTORY_MISSING");
  const envelopeDirectory = canonicalDirectory(options.envelopeDirectory, "CUTOVER_STORAGE_ENVELOPE_DIRECTORY_MISSING");
  const journalPath = canonicalPlannedFile(options.journalPath, "CUTOVER_STORAGE_JOURNAL_DIRECTORY_MISSING");
  const lockPath = canonicalPlannedFile(options.lockPath, "CUTOVER_STORAGE_LOCK_DIRECTORY_MISSING");

  if (!inside(database, replacementRoot)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_DATABASE_OUTSIDE_REPLACEMENT_ROOT");
  for (const [name, value] of [["state", stateDirectory], ["archive", archiveDirectory], ["envelope", envelopeDirectory], ["journal", journalPath], ["lock", lockPath]] as const) {
    if (!inside(value, stateDirectory) || inside(value, replacementRoot)) {
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_STATE_NAMESPACE_INVALID", name);
    }
  }
  const databaseDevice = statSync(databaseDirectory).dev;
  if (statSync(archiveDirectory).dev !== databaseDevice) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_DIFFERENT_FILESYSTEM");
  return { database, databaseDirectory, replacementRoot, stateDirectory, archiveDirectory, envelopeDirectory, journalPath, lockPath };
};

/**
 * Physical SQLite half of the cross-lineage handoff.
 *
 * It never guesses at a recovery state. Every path is canonicalized before a
 * handle is opened, every archive name is write-once, and the only rename of a
 * live database is within one device. The envelope protocol calls prepare()
 * before its durable write and complete() afterwards; complete() is therefore
 * safe to replay after every crash point in that gap.
 */
export class SqliteCutoverStorage {
  readonly #layout: Layout;
  readonly #authority: RuntimeQuiescenceAuthority;
  readonly #revalidation: RuntimeLeaseRevalidation;

  constructor(options: SqliteCutoverStorageOptions) {
    this.#layout = layout(options);
    this.#authority = options.authority;
    this.#revalidation = options.revalidation;
  }

  async createVerifiedBackups(id: string): Promise<readonly OnlineBackupEvidence[]> {
    const safeId = cutoverId(id);
    const evidence: OnlineBackupEvidence[] = [];
    for (const ordinal of [1, 2]) {
      const target = join(this.#layout.archiveDirectory, `${safeId}.online-${ordinal}.sqlite`);
      if (existsSync(target)) {
        evidence.push(this.verifyBackup(target));
        continue;
      }
      const source = new Database(this.#layout.database, { readonly: true, fileMustExist: true });
      try { await source.backup(target); } catch (error) {
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ONLINE_BACKUP_FAILED", error instanceof Error ? error.message : undefined);
      } finally { source.close(); }
      evidence.push(this.verifyBackup(target));
    }
    return evidence;
  }

  /** Checkpoint only after the caller proved every runtime writer has stopped. */
  async prepareArchive(id: string, lease: RuntimeQuiescenceLease, binding: RuntimeLeaseBinding): Promise<PredecessorDatabase> {
    await this.authorize(id, "PREPARE", lease, binding);
    const safeId = cutoverId(id);
    this.checkpointAndRefuseLiveSidecars();
    const digest = sha256(this.#layout.database);
    const ref = join(this.#layout.archiveDirectory, `${safeId}.predecessor.sqlite`);
    if (existsSync(ref)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_ALREADY_EXISTS", ref);
    return { ref, sha256: digest };
  }

  /**
   * This is intentionally called only after the durable envelope write. It
   * either observes the exact predecessor already archived, atomically moves
   * the exact file named by the envelope, or refuses; it never overwrites an
   * archive or turns a mismatched old database into a new baseline.
   */
  async ensureArchivedAndFresh(
    envelope: CutoverEnvelope,
    lease: RuntimeQuiescenceLease,
    binding: RuntimeLeaseBinding,
    writeEnvelope?: () => void | Promise<void>,
  ): Promise<void> {
    await this.authorize(envelope.cutoverId, "PREPARE", lease, binding);
    await writeEnvelope?.();
    const archive = this.canonicalArchive(envelope.predecessorDatabase);
    if (existsSync(archive)) {
      if (sha256(archive) !== envelope.predecessorDatabase.sha256) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_DIGEST_MISMATCH");
      if (existsSync(this.#layout.database) && this.lineageAtRest() === "LEGACY") {
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_AND_LEGACY_PRESENT");
      }
    } else {
      if (!existsSync(this.#layout.database)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_DATABASE_MISSING_AFTER_ENVELOPE");
      this.checkpointAndRefuseLiveSidecars();
      if (sha256(this.#layout.database) !== envelope.predecessorDatabase.sha256) {
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_DIGEST_CHANGED");
      }
      renameSync(this.#layout.database, archive);
      fsyncDirectory(this.#layout.archiveDirectory);
      fsyncDirectory(this.#layout.databaseDirectory);
    }
    this.ensureFreshLaunchDatabase();
  }

  /** Archives the launch database before a reverse handoff, never overwriting a prior attempt. */
  async archiveSuccessor(rollbackId: string, lease: RuntimeQuiescenceLease, binding: RuntimeLeaseBinding): Promise<DatabaseArchive> {
    await this.authorize(rollbackId, "RESTORE", lease, binding);
    const safeId = cutoverId(rollbackId);
    const target = join(this.#layout.archiveDirectory, `${safeId}.successor.sqlite`);
    if (existsSync(target)) return { ref: target, sha256: sha256(target) };
    if (!existsSync(this.#layout.database)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SUCCESSOR_DATABASE_MISSING");
    this.checkpointAndRefuseLiveSidecars();
    const digest = sha256(this.#layout.database);
    renameSync(this.#layout.database, target);
    fsyncDirectory(this.#layout.archiveDirectory);
    fsyncDirectory(this.#layout.databaseDirectory);
    return { ref: target, sha256: digest };
  }

  /**
   * The predecessor archive remains immutable. Restoration copies it to a
   * same-device temporary file, verifies the digest, then atomically renames
   * that file into an absent database path. A hard link would share mutable
   * SQLite pages with the archive, so it is explicitly not used.
   */
  async restorePredecessor(rollbackId: string, archive: DatabaseArchive, lease: RuntimeQuiescenceLease, binding: RuntimeLeaseBinding): Promise<void> {
    await this.authorize(rollbackId, "RESTORE", lease, binding);
    const source = this.canonicalArchive(archive);
    if (!existsSync(source)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_MISSING", source);
    if (sha256(source) !== archive.sha256) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_DIGEST_MISMATCH");
    if (existsSync(this.#layout.database)) {
      if (sha256(this.#layout.database) === archive.sha256) return;
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORE_TARGET_EXISTS");
    }
    const temporary = `${this.#layout.database}.restore-${process.pid}.tmp`;
    if (existsSync(temporary)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORE_TEMP_EXISTS");
    copyFileSync(source, temporary, 0);
    fsyncFile(temporary);
    if (sha256(temporary) !== archive.sha256) {
      unlinkSync(temporary);
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORE_DIGEST_MISMATCH");
    }
    renameSync(temporary, this.#layout.database);
    fsyncDirectory(this.#layout.databaseDirectory);
  }

  restedFileSha256(): string {
    if (!existsSync(this.#layout.database)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_DATABASE_MISSING");
    return sha256(this.#layout.database);
  }

  private verifyBackup(path: string): OnlineBackupEvidence {
    let backup: Database.Database | undefined;
    try {
      backup = new Database(path, { readonly: true, fileMustExist: true });
      const row = backup.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
      if (row?.integrity_check !== "ok") throw new SqliteCutoverStorageError("CUTOVER_STORAGE_BACKUP_INTEGRITY_FAILED", path);
      return { path: canonicalFile(path, "CUTOVER_STORAGE_BACKUP_MISSING"), sha256: sha256(path) };
    } finally { backup?.close(); }
  }

  private checkpointAndRefuseLiveSidecars(): void {
    const db = new Database(this.#layout.database, { fileMustExist: true });
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${this.#layout.database}${suffix}`;
      if (!existsSync(sidecar)) continue;
      if (statSync(sidecar).size !== 0) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_WAL_STILL_ACTIVE", suffix);
      // A zero-byte sidecar is not a live WAL. Removing it prevents a fresh
      // main database from being paired with a stale SQLite sidecar.
      unlinkSync(sidecar);
      fsyncDirectory(this.#layout.databaseDirectory);
    }
  }

  private ensureFreshLaunchDatabase(): void {
    if (existsSync(this.#layout.database)) {
      const lineage = this.lineageAtRest();
      if (lineage === "SUPPORTED") return;
      if (lineage !== "EMPTY_BOOTSTRAPPABLE") throw new SqliteCutoverStorageError("CUTOVER_STORAGE_FRESH_DATABASE_INVALID", lineage);
    }
    const db = openDatabase(this.#layout.database, { testSchemaSnapshot: false });
    try { migrate(db); } finally { db.close(); }
    if (this.lineageAtRest() !== "SUPPORTED") throw new SqliteCutoverStorageError("CUTOVER_STORAGE_FRESH_DATABASE_NOT_SUPPORTED");
    fsyncFile(this.#layout.database);
    fsyncDirectory(this.#layout.databaseDirectory);
  }

  private lineageAtRest() {
    const db = new Database(this.#layout.database, { readonly: true, fileMustExist: true });
    try { return classifySchemaLineage(readSchemaIdentity(db)); } finally { db.close(); }
  }

  private canonicalArchive(archive: DatabaseArchive): string {
    const planned = canonicalPlannedFile(archive.ref, "CUTOVER_STORAGE_ARCHIVE_DIRECTORY_MISSING");
    if (!inside(planned, this.#layout.archiveDirectory)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_PATH_ESCAPE");
    if (statSync(dirname(planned)).dev !== statSync(this.#layout.databaseDirectory).dev) {
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_ARCHIVE_DIFFERENT_FILESYSTEM");
    }
    return planned;
  }

  private async authorize(operationId: string, operation: RuntimeLeaseBinding["operation"], lease: RuntimeQuiescenceLease, binding: RuntimeLeaseBinding): Promise<void> {
    if (binding.sessionId !== operationId) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_QUIESCENCE_OPERATION_MISMATCH");
    if (binding.operation !== operation) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_QUIESCENCE_DIRECTION_MISMATCH");
    if (binding.databasePath !== this.#layout.database || binding.databaseIdentity.canonicalPath !== this.#layout.database) {
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_QUIESCENCE_DATABASE_MISMATCH");
    }
    await this.#authority.consume(lease, binding, this.#revalidation);
  }
}
