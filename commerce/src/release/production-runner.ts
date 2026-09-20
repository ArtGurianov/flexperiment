import Database from "better-sqlite3";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CoolifyClient } from "./coolify";
import { CoolifyDeploymentDriver, CoolifyRecoveryDriver } from "./coolify-deployment";
import { FileCutoverEnvelopeStore } from "./cutover-envelope-file-store";
import { ProductionDeployRefStore } from "./deploy-ref";
import { DeploySessions } from "./deploy-session";
import { SqliteReleaseAuthorityStore } from "./deploy-session-store";
import { ReleaseOrchestrator, type CertificationDriver, type ReleasePorts } from "./orchestrator";
import { describeConfig, ReleaseConfigError, type ProductionReleaseConfig } from "./production-config";
import { activeLegalBinding } from "./legal-binding";
import { DatabaseRuntimeEvidenceReader, ProductionTopologyReader } from "./topology-reader";

/**
 * The production composition root.
 *
 * It runs as a one-shot process on the VPS, outside the three Coolify
 * applications. That placement is not a deployment preference: a controller
 * living inside `commerce` would be replaced by the very deploy it is driving,
 * and a successful deploy would sever it between mutating the topology and
 * recording the terminal transition - leaving a durable session that owns a
 * closed sales gate with nothing left alive to release it.
 */

export class ReleaseRunnerError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * One cutover at a time, enforced by the filesystem.
 *
 * The lock guards concurrency only. It is deliberately NOT the authority on who
 * owns a release - the deploy session's lease and its compare-and-set are, and
 * they survive this process dying. So a lock whose holder is gone may be
 * claimed: refusing forever would mean a killed runner can only be recovered by
 * an operator deleting a file, at the moment the fence is up and sales are
 * shut.
 */
export class ReleaseRunnerLock {
  #held = false;

  private constructor(private readonly path: string) {}

  static acquire(path: string, now: () => Date = () => new Date()): ReleaseRunnerLock {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = new ReleaseRunnerLock(path);
    if (!lock.claim(now)) {
      const holder = lock.holder();
      if (holder && ReleaseRunnerLock.alive(holder.pid)) {
        throw new ReleaseRunnerError("RELEASE_RUNNER_LOCKED", `held by pid ${holder.pid} since ${holder.acquiredAt}`);
      }
      // Stale. Remove it and try once more: whoever wins the exclusive create
      // wins, so a second claimer racing on the same conclusion still loses.
      try { unlinkSync(path); } catch { /* another claimer removed it first */ }
      if (!lock.claim(now)) throw new ReleaseRunnerError("RELEASE_RUNNER_LOCKED", "another runner claimed the lock first");
    }
    return lock;
  }

  private claim(now: () => Date): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now().toISOString() }));
    } finally {
      closeSync(fd);
    }
    this.#held = true;
    return true;
  }

  private holder(): { pid: number; acquiredAt: string } | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: unknown; acquiredAt?: unknown };
      if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return undefined;
      return { pid: parsed.pid, acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "unknown" };
    } catch {
      // An unreadable lock is treated as held by something unknown, which is
      // the safe reading: it is not evidence that nothing is running.
      return { pid: -1, acquiredAt: "unknown" };
    }
  }

  private static alive(pid: number): boolean {
    if (pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means a process with that id exists and belongs to someone else.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    try { unlinkSync(this.path); } catch { /* already gone */ }
  }
}

/**
 * Append-only, one JSON object per line, 0600.
 *
 * It records what the run did, never what it was given: no token, no
 * credentialed remote, no envelope contents beyond identifiers. A journal is
 * read after a failure and pasted into tickets, so a secret that reaches it has
 * been published.
 */
export class ReleaseJournal {
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  record(event: string, detail: Record<string, unknown> = {}): void {
    appendFileSync(this.path, `${JSON.stringify({ at: this.now().toISOString(), event, ...detail })}\n`, { mode: 0o600 });
  }
}

export type ProductionRelease = {
  readonly ports: ReleasePorts;
  /** The durable authority itself, for the gate and for resuming a session by id. */
  readonly authority: SqliteReleaseAuthorityStore;
  readonly orchestrator: ReleaseOrchestrator;
  readonly sessions: DeploySessions;
  readonly envelopes: FileCutoverEnvelopeStore;
  readonly deployRef: ProductionDeployRefStore;
  readonly deployment: CoolifyDeploymentDriver;
  readonly journal: ReleaseJournal;
  readonly lock: ReleaseRunnerLock;
  close(): void;
};

export type BuildOptions = {
  readonly now?: () => Date;
  readonly fetch?: typeof globalThis.fetch;
  /** Injected only so the integration suite can drive a temporary repository. */
  readonly git?: (args: readonly string[], cwd: string) => Promise<string>;
  /**
   * The remaining port with no production adapter.
   *
   * Certification is irreducibly attended - someone opens a mailbox and says
   * the ticket arrived - so its driver needs both an HTTP client for the admin
   * and public surfaces and an operator at a terminal. Neither exists yet, and
   * none is improvised here: `runMaintenanceCutover` refuses on its first line
   * when this is absent, before the topology is even read, so the absence costs
   * a refusal rather than a half-run cutover.
   */
  readonly certification?: CertificationDriver;
};

/**
 * Builds every adapter, or builds none.
 *
 * Each precondition below is checked before the first one that could mutate
 * anything: the lock is taken before the database is opened, and the database
 * is opened before any Coolify client exists. A root that wired half its ports
 * and discovered the rest missing would already hold the lock and a session.
 */
export const buildProductionRelease = (config: ProductionReleaseConfig, options: BuildOptions = {}): ProductionRelease => {
  const now = options.now ?? (() => new Date());

  for (const [label, path] of [["database", config.databasePath], ["deploy ref worktree", config.deployRef.worktree]] as const) {
    if (!existsSync(path)) throw new ReleaseConfigError("RELEASE_RUNNER_PATH_MISSING", `${label}: ${path}`);
  }
  mkdirSync(config.archiveDirectory, { recursive: true, mode: 0o700 });

  const lock = ReleaseRunnerLock.acquire(config.lockPath, now);
  let db: Database.Database | undefined;
  try {
    const journal = new ReleaseJournal(config.journalPath, now);
    journal.record("runner.configured", describeConfig(config));

    db = new Database(config.databasePath);
    db.pragma("foreign_keys = ON");

    const deployRef = new ProductionDeployRefStore({
      remote: config.deployRef.remote, ref: config.deployRef.ref,
      cwd: config.deployRef.worktree, git: options.git,
    });
    const client = new CoolifyClient({ apiUrl: config.coolify.apiUrl, token: config.coolify.token, fetch: options.fetch });
    const coolify = {
      client, refs: deployRef,
      applications: config.applications,
      onProgress: (message: string) => journal.record("deployment.progress", { message }),
    };

    const opened = db;
    const authority = new SqliteReleaseAuthorityStore(opened);
    const sessions = new DeploySessions(authority, now);
    const ports: ReleasePorts = {
      sessions,
      clock: now,
      topology: new ProductionTopologyReader({
        frontendReleaseUrl: config.topology.frontendReleaseUrl,
        adminReleaseUrl: config.topology.adminReleaseUrl,
        db, deployRef, now, fetch: options.fetch,
      }),
      evidence: new DatabaseRuntimeEvidenceReader({ db, now, legal: () => activeLegalBinding(opened) }),
      deployment: new CoolifyDeploymentDriver(coolify),
      recovery: new CoolifyRecoveryDriver(coolify),
      certification: options.certification,
    };

    return {
      ports, sessions, journal, lock, deployRef, authority,
      deployment: ports.deployment as CoolifyDeploymentDriver,
      envelopes: new FileCutoverEnvelopeStore(config.envelopeDirectory),
      orchestrator: new ReleaseOrchestrator(ports),
      close() {
        opened.close();
        lock.release();
      },
    };
  } catch (error) {
    db?.close();
    lock.release();
    throw error;
  }
};

/**
 * A signal must never be a way to open sales.
 *
 * The handler records the interruption and lets go of the lock so a resume can
 * run, and does nothing else. It does not abort the session, does not release
 * the fence and does not decide anything about topology: an interrupted runner
 * has no idea whether production was mid-move, and the whole point of the
 * durable session is that the next runner finds out by looking.
 */
export const holdSalesOnSignal = (release: ProductionRelease, exit: (code: number) => never = process.exit as (code: number) => never) => {
  let interrupted = false;
  const handler = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    release.journal.record("runner.interrupted", { signal, note: "sales gate left as the session holds it" });
    release.close();
    exit(130);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  return handler;
};
