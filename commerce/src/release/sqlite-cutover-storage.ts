import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  chmodSync, chownSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fsyncSync,
  lstatSync, openSync, realpathSync, readFileSync, renameSync, statSync, unlinkSync,
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
export type RestoredDatabaseEvidence = {
  readonly successorDatabase: DatabaseArchive;
  readonly predecessorDatabase: DatabaseArchive;
};

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
  /**
   * Everything a launch database needs beyond its schema.
   *
   * `migrate` alone produces a structurally valid database that the runtime
   * cannot serve from: no cities, and `legal_releases` deliberately empty, so
   * readiness stops at LEGAL_RELEASE_EVIDENCE_MISSING. Supplied by the
   * composition root because seeding and legal publication are domain
   * operations, not storage ones.
   */
  readonly initializeLaunchDatabase?: (db: Database.Database) => void;
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
  readonly #initializeLaunchDatabase?: (db: Database.Database) => void;
  readonly #authority: RuntimeQuiescenceAuthority;
  readonly #revalidation: RuntimeLeaseRevalidation;

  constructor(options: SqliteCutoverStorageOptions) {
    this.#layout = layout(options);
    this.#authority = options.authority;
    this.#revalidation = options.revalidation;
    this.#initializeLaunchDatabase = options.initializeLaunchDatabase;
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
    // The archive is the predecessor file itself, moved: its uid/gid/mode are
    // exactly what the runtime was able to open before this cutover began.
    this.ensureLaunchDatabaseInitialized(archive);
  }

  /** Read-only admission for rollback. It must pass before recovery reserves a session or touches the live DB/ref. */
  inspectPredecessorArchive(archive: DatabaseArchive): DatabaseArchive {
    const source = this.canonicalArchive(archive);
    if (!existsSync(source)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_MISSING", source);
    if (sha256(source) !== archive.sha256) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_DIGEST_MISMATCH");
    this.assertHealthyLegacyDatabase(source, "CUTOVER_STORAGE_PREDECESSOR_ARCHIVE");
    return { ref: source, sha256: archive.sha256 };
  }

  /**
   * One RESTORE lease covers the first storage mutation through the durable
   * predecessor restore. It is consumed before checkpointing. The launch DB is
   * archived write-once, the predecessor archive is copied rather than moved,
   * and a replay recognizes the already-restored state without overwriting it.
   */
  async restore(
    rollbackId: string,
    archive: DatabaseArchive,
    lease: RuntimeQuiescenceLease,
    binding: RuntimeLeaseBinding,
  ): Promise<RestoredDatabaseEvidence> {
    await this.authorize(rollbackId, "RESTORE", lease, binding);
    const predecessor = this.inspectPredecessorArchive(archive);
    const safeId = cutoverId(rollbackId);
    const successorPath = join(this.#layout.archiveDirectory, `${safeId}.successor.sqlite`);

    if (existsSync(successorPath)) {
      this.assertHealthyLaunchDatabase(successorPath);
    } else {
      if (!existsSync(this.#layout.database)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SUCCESSOR_DATABASE_MISSING");
      this.assertHealthyLaunchDatabase(this.#layout.database);
      this.checkpointAndRefuseLiveSidecars();
      const launchDigest = sha256(this.#layout.database);
      copyFileSync(this.#layout.database, successorPath, fsConstants.COPYFILE_EXCL);
      fsyncFile(successorPath);
      if (sha256(successorPath) !== launchDigest) {
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SUCCESSOR_ARCHIVE_DIGEST_MISMATCH");
      }
      fsyncDirectory(this.#layout.archiveDirectory);
    }
    this.restorePredecessorCopy(predecessor);

    if (sha256(predecessor.ref) !== predecessor.sha256) {
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_PREDECESSOR_ARCHIVE_CHANGED");
    }
    if (sha256(this.#layout.database) !== predecessor.sha256) {
      throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORED_DATABASE_DIGEST_MISMATCH");
    }
    this.assertHealthyLegacyDatabase(this.#layout.database, "CUTOVER_STORAGE_RESTORED_DATABASE");
    return {
      successorDatabase: { ref: successorPath, sha256: sha256(successorPath) },
      predecessorDatabase: predecessor,
    };
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

  /**
   * Brings the launch database all the way to something the runtime can serve.
   *
   * Deliberately an ENSURE, not a create-once. The previous version returned
   * early on a SUPPORTED database, so a retry after a crash between `migrate`
   * and the rest would see a schema and declare the job finished - leaving a
   * database with no cities and no legal release, which readiness refuses and
   * certification cannot use. Both steps below are idempotent for an exact
   * replay, so running them again is the safe direction.
   *
   * Ownership is handed over last, after every root-side write. Doing it
   * earlier would let seeding and legal publication recreate root-owned
   * sidecars beside a correctly-owned main file.
   */
  private ensureLaunchDatabaseInitialized(runtimeOwnership: string): void {
    if (existsSync(this.#layout.database)) {
      const lineage = this.lineageAtRest();
      if (lineage !== "SUPPORTED" && lineage !== "EMPTY_BOOTSTRAPPABLE") {
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_FRESH_DATABASE_INVALID", lineage);
      }
    }
    const db = openDatabase(this.#layout.database, { testSchemaSnapshot: false });
    try {
      migrate(db);
      this.#initializeLaunchDatabase?.(db);
    } finally { db.close(); }
    if (this.lineageAtRest() !== "SUPPORTED") throw new SqliteCutoverStorageError("CUTOVER_STORAGE_FRESH_DATABASE_NOT_SUPPORTED");
    this.checkpointAndRefuseLiveSidecars();
    this.handOwnershipToRuntime(runtimeOwnership);
    fsyncFile(this.#layout.database);
    fsyncDirectory(this.#layout.databaseDirectory);
  }

  /**
   * The successor inherits the predecessor's uid, gid and mode.
   *
   * The runner is root; the runtime is not. A database created here is
   * root-owned and unreadable to the container, which then crash-loops and the
   * cutover can never converge - and because the runtime is what topology is
   * read from, the recovery path stalls with it. The predecessor archive is the
   * file the runtime demonstrably could open, so its metadata is the contract
   * rather than a hardcoded uid.
   */
  private handOwnershipToRuntime(source: string): void {
    const wanted = statSync(source);
    const mode = wanted.mode & 0o7777;
    // Sidecars too: SQLite recreates them, but one left behind owned by root
    // beside a handed-over main file is a writer the runtime cannot open.
    for (const path of [this.#layout.database, `${this.#layout.database}-wal`, `${this.#layout.database}-shm`]) {
      if (!existsSync(path)) continue;
      chownSync(path, wanted.uid, wanted.gid);
      chmodSync(path, mode);
      const applied = statSync(path);
      if (applied.uid !== wanted.uid || applied.gid !== wanted.gid || (applied.mode & 0o7777) !== mode) {
        throw new SqliteCutoverStorageError(
          "CUTOVER_STORAGE_RUNTIME_OWNERSHIP_NOT_APPLIED",
          `${basename(path)}: wanted ${wanted.uid}:${wanted.gid} ${mode.toString(8)}, found ${applied.uid}:${applied.gid} ${(applied.mode & 0o7777).toString(8)}`,
        );
      }
    }
  }

  private lineageAtRest() {
    const db = new Database(this.#layout.database, { readonly: true, fileMustExist: true });
    try { return classifySchemaLineage(readSchemaIdentity(db)); } finally { db.close(); }
  }

  private assertHealthyLaunchDatabase(path: string): void {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const lineage = classifySchemaLineage(readSchemaIdentity(db));
      if (lineage !== "SUPPORTED") throw new SqliteCutoverStorageError("CUTOVER_STORAGE_SUCCESSOR_LINEAGE_INVALID", lineage);
      this.assertIntegrity(db, "CUTOVER_STORAGE_SUCCESSOR");
    } finally { db.close(); }
  }

  private assertHealthyLegacyDatabase(path: string, prefix: string): void {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const lineage = classifySchemaLineage(readSchemaIdentity(db));
      if (lineage !== "LEGACY") throw new SqliteCutoverStorageError(`${prefix}_LINEAGE_INVALID`, lineage);
      this.assertIntegrity(db, prefix);
    } finally { db.close(); }
  }

  private assertIntegrity(db: Database.Database, prefix: string): void {
    const integrity = db.pragma("integrity_check") as { integrity_check?: unknown }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new SqliteCutoverStorageError(`${prefix}_INTEGRITY_FAILED`);
    }
    const foreignKeys = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length !== 0) throw new SqliteCutoverStorageError(`${prefix}_FOREIGN_KEY_FAILED`);
  }

  private restorePredecessorCopy(predecessor: DatabaseArchive): void {
    if (!existsSync(this.#layout.database)) throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORE_TARGET_MISSING");
    if (sha256(this.#layout.database) === predecessor.sha256) return;
    this.assertHealthyLaunchDatabase(this.#layout.database);
    const temporary = `${this.#layout.database}.restore-${process.pid}.tmp`;
    if (existsSync(temporary) && sha256(temporary) !== predecessor.sha256) {
      // A torn private temp is not evidence and is safe to recreate from the
      // still-immutable predecessor archive. Neither canonical DB is touched.
      unlinkSync(temporary);
    }
    if (!existsSync(temporary)) {
      copyFileSync(predecessor.ref, temporary, fsConstants.COPYFILE_EXCL);
      fsyncFile(temporary);
      if (sha256(temporary) !== predecessor.sha256) {
        unlinkSync(temporary);
        throw new SqliteCutoverStorageError("CUTOVER_STORAGE_RESTORE_DIGEST_MISMATCH");
      }
    }
    // POSIX rename replaces the stopped launch inode atomically: the canonical
    // path is never absent, so a killed runner can always build and resume.
    renameSync(temporary, this.#layout.database);
    fsyncDirectory(this.#layout.databaseDirectory);
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
