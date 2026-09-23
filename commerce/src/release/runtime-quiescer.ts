import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  RuntimeQuiescenceAuthority,
  type RuntimeLeaseBinding,
  type RuntimeLeaseDatabaseIdentity,
  type RuntimeLeaseOperation,
  type RuntimeLeaseRevalidation,
  type RuntimeQuiescenceLease,
} from "./runtime-quiescence-authority";

/**
 * Who owns the containers.
 *
 * Coolify does, completely. This used to drive Docker directly - discovering
 * containers by label, capturing their ids, stopping them and starting those
 * exact ids again - which was a second deployment control plane underneath the
 * one we already run. It produced both production incidents of 2026-09-23 and
 * nothing else. The runner now asks Coolify to stop and to deploy, and proves
 * the outcome through readiness and the release descriptors, the same evidence
 * every other part of the system uses.
 */
export interface RuntimeLifecycle {
  /** Ask the control plane to take the application down. */
  stop(applicationUuid: string): Promise<void>;
  /** Prove it is down. Never inspects containers; asks the control plane. */
  assertStopped(applicationUuid: string): Promise<void>;
  /** Bring it back on whatever commit the tracked ref now names. */
  start(applicationUuid: string): Promise<void>;
}

export class RuntimeQuiescenceError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

export type SqliteHandleCommandResult = { readonly stdout: string; readonly exitCode: number };
export type SqliteHandleCommand = (args: readonly string[]) => Promise<SqliteHandleCommandResult>;

const lsof: SqliteHandleCommand = (args) => new Promise((resolvePromise, reject) => {
  execFile("lsof", args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
    if (!error) return resolvePromise({ stdout, exitCode: 0 });
    if ((error as { code?: unknown }).code === 1) return resolvePromise({ stdout, exitCode: 1 });
    reject(error);
  });
});

export interface OpenHandleProbe {
  assertNoOpenHandles(databasePath: string): Promise<void>;
}

export class LsofSqliteHandleProbe implements OpenHandleProbe {
  constructor(private readonly command: SqliteHandleCommand = lsof) {}

  async assertNoOpenHandles(databasePath: string): Promise<void> {
    const paths = [databasePath, ...["-wal", "-shm"].map((suffix) => `${databasePath}${suffix}`).filter(existsSync)];
    let result: SqliteHandleCommandResult;
    try { result = await this.command(["-t", "--", ...paths]); }
    catch { throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_HANDLE_INSPECTION_FAILED"); }
    if (result.exitCode === 1 && !result.stdout.trim()) return;
    if (result.exitCode !== 0) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_HANDLE_INSPECTION_FAILED", `lsof exit ${result.exitCode}`);
    const pids = result.stdout.split("\n").map((value) => value.trim()).filter(Boolean);
    if (!pids.length) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_HANDLE_INSPECTION_FAILED", "lsof exit 0 without handles");
    throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_SQLITE_HANDLES_OPEN", pids.join(","));
  }
}

export interface DatabaseIdentityProbe {
  identity(databasePath: string): Promise<RuntimeLeaseDatabaseIdentity>;
}

export class HostDatabaseIdentityProbe implements DatabaseIdentityProbe {
  async identity(databasePath: string): Promise<RuntimeLeaseDatabaseIdentity> {
    let canonicalPath: string;
    try {
      if (lstatSync(databasePath).isSymbolicLink()) throw new Error("symlink");
      canonicalPath = realpathSync(databasePath);
    } catch {
      throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_DATABASE_IDENTITY_FAILED");
    }
    if (resolve(databasePath) !== canonicalPath) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_DATABASE_PATH_NOT_CANONICAL");
    const stat = statSync(canonicalPath);
    if (!stat.isFile()) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_DATABASE_IDENTITY_FAILED");
    return { canonicalPath, dev: stat.dev, ino: stat.ino };
  }
}

export interface ReleaseLockReader {
  assertHeld(owner: string): Promise<void>;
}

export type RuntimeLeaseGrant = Readonly<{
  lease: RuntimeQuiescenceLease;
  binding: RuntimeLeaseBinding;
}>;

export type RuntimeQuiescerAcquireRequest = Readonly<{
  sessionId: string;
  operation: RuntimeLeaseOperation;
  databasePath: string;
  lockOwner: string;
  /** The Coolify application to take down. No commit, and no container ids. */
  applicationUuid: string;
  applicationResourceId: string;
}>;

export type RuntimeQuiescerOptions = Readonly<{
  authority: RuntimeQuiescenceAuthority;
  runtime: RuntimeLifecycle;
  database?: DatabaseIdentityProbe;
  handles?: OpenHandleProbe;
  lock: ReleaseLockReader;
  closeControllerDatabase?: () => void | Promise<void>;
}>;

const sameIdentity = (left: RuntimeLeaseDatabaseIdentity, right: RuntimeLeaseDatabaseIdentity) =>
  left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino;

/** Issues and revalidates process-local storage capabilities; it never mutates SQLite. */
export class RuntimeQuiescer implements RuntimeLeaseRevalidation {
  readonly #runtime: RuntimeLifecycle;
  readonly #database: DatabaseIdentityProbe;
  readonly #handles: OpenHandleProbe;

  constructor(private readonly options: RuntimeQuiescerOptions) {
    this.#runtime = options.runtime;
    this.#database = options.database ?? new HostDatabaseIdentityProbe();
    this.#handles = options.handles ?? new LsofSqliteHandleProbe();
  }

  /**
   * Takes the runtime down and proves the database is nobody's to write.
   *
   * The identity re-read and the handle probe are the parts that actually make
   * a database swap safe, and neither knows what a container is. That is the
   * whole remaining job: the control plane stops the application, and the host
   * proves no writer is left holding the file.
   */
  async acquire(input: RuntimeQuiescerAcquireRequest): Promise<RuntimeLeaseGrant> {
    await this.options.closeControllerDatabase?.();
    const before = await this.#database.identity(input.databasePath);
    await this.options.lock.assertHeld(input.lockOwner);
    await this.#runtime.stop(input.applicationUuid);
    await this.#runtime.assertStopped(input.applicationUuid);
    const after = await this.#database.identity(input.databasePath);
    if (!sameIdentity(before, after)) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_DATABASE_IDENTITY_DRIFT");
    await this.#handles.assertNoOpenHandles(input.databasePath);
    await this.options.lock.assertHeld(input.lockOwner);
    const binding: RuntimeLeaseBinding = Object.freeze({
      sessionId: input.sessionId,
      operation: input.operation,
      databasePath: input.databasePath,
      databaseIdentity: before,
      applicationUuid: input.applicationUuid,
      applicationResourceId: input.applicationResourceId,
      lockOwner: input.lockOwner,
    });
    return Object.freeze({ lease: this.options.authority.acquire(binding), binding });
  }

  /** Puts the runtime back, on whatever commit the tracked ref now names. */
  async resume(grant: RuntimeLeaseGrant): Promise<void> {
    await this.options.lock.assertHeld(grant.binding.lockOwner);
    await this.#runtime.assertStopped(grant.binding.applicationUuid);
    await this.#runtime.start(grant.binding.applicationUuid);
    await this.options.lock.assertHeld(grant.binding.lockOwner);
  }

  async assertLockHeld(owner: string): Promise<void> { await this.options.lock.assertHeld(owner); }

  async assertDatabaseIdentity(expected: RuntimeLeaseDatabaseIdentity): Promise<void> {
    const actual = await this.#database.identity(expected.canonicalPath);
    if (!sameIdentity(actual, expected)) throw new RuntimeQuiescenceError("RUNTIME_QUIESCER_DATABASE_IDENTITY_DRIFT");
  }

  async assertUnitsStopped(binding: RuntimeLeaseBinding): Promise<void> {
    await this.#runtime.assertStopped(binding.applicationUuid);
  }

  async assertNoSqliteHandles(databasePath: string): Promise<void> {
    await this.#handles.assertNoOpenHandles(databasePath);
  }

}
