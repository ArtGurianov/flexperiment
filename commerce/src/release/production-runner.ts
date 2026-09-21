import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { CoolifyClient } from "./coolify";
import { CoolifyDeploymentDriver, CoolifyRecoveryDriver } from "./coolify-deployment";
import { FileCutoverEnvelopeStore } from "./cutover-envelope-file-store";
import { defaultGit, ProductionDeployRefStore, ProductionDeployRefViewer } from "./deploy-ref";
import { DeploySessions } from "./deploy-session";
import { SqliteReleaseAuthorityStore } from "./deploy-session-store";
import { ReleaseOrchestrator, type CertificationDriver, type ReleasePorts } from "./orchestrator";
import { describeConfig, ReleaseConfigError, type CandidatePublicationConfig, type ProductionReleaseConfig, type ReadOnlyReleaseConfig } from "./production-config";
import { FileReleaseCandidateStore } from "./candidate-store";
import type { ReleaseCandidate } from "./candidate";
import { ProductionCertificationDriver } from "../certification/driver";
import { openControllingTerminal } from "../certification/operator-terminal";
import { readOperatorOccurrence } from "../certification/operator-scope";
import { GitCommitTreeReader, type CommitTreeReader } from "./candidate-publication";
import { activeLegalBinding } from "./legal-binding";
import { LegacyPredecessorTopologyReader } from "./legacy-predecessor-topology";
import { readSchemaIdentity } from "../db";
import { DatabaseRuntimeEvidenceReader, ProductionTopologyReader } from "./topology-reader";
import { SqliteCutoverStorage } from "./sqlite-cutover-storage";
import { BootstrapCutoverPreparation, type PreparationRequest, type PreparationResult } from "./cutover-preparation";
import { DockerComposeRuntimeControl } from "./docker-compose-runtime";

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

/**
 * Everything needed to look at production, and nothing that could change it.
 *
 * There is no lock, no journal and no orchestrator here - not because they are
 * unnecessary for a read, but because a composition that holds none of them
 * cannot be talked into a write by any argument. The `observe` command is safe
 * because of what this object does not contain.
 */
export type ReadOnlyRelease = {
  readonly topology: ProductionTopologyReader;
  readonly evidence: DatabaseRuntimeEvidenceReader;
  close(): void;
};

export const buildReadOnlyRelease = (config: ReadOnlyReleaseConfig, options: BuildOptions = {}): ReadOnlyRelease => {
  const now = options.now ?? (() => new Date());
  if (!existsSync(config.databasePath)) throw new ReleaseConfigError("RELEASE_RUNNER_PATH_MISSING", `database: ${config.databasePath}`);

  // Opened read-only, so even a defect in a reader cannot write to the file the
  // release authority lives in.
  const db = new Database(config.databasePath, { readonly: true });
  try {
    return {
      topology: new ProductionTopologyReader({
        frontendReleaseUrl: config.topology.frontendReleaseUrl,
        adminReleaseUrl: config.topology.adminReleaseUrl,
        db, now, fetch: options.fetch,
        // A viewer, not the store: this composition has no object that can move
        // the pointer, and no credential that would let one.
        deployRef: new ProductionDeployRefViewer({
          remote: config.deployRef.remote, ref: config.deployRef.ref,
          cwd: config.deployRef.worktree, git: options.git,
        }),
      }),
      evidence: new DatabaseRuntimeEvidenceReader({ db, now, legal: () => activeLegalBinding(db) }),
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
};

/**
 * Publishing a candidate deploys nothing, and this composition is why.
 *
 * It holds a reader for the commit's tree and a write-once directory, and
 * nothing else: no database, no Coolify client, no deploy-ref writer. The
 * expectation it records is derived from the commit rather than accepted from
 * whoever asked for the publication.
 */
export type CandidatePublisher = {
  readonly tree: CommitTreeReader;
  readonly candidates: FileReleaseCandidateStore;
  /** Makes the commit locally resolvable before its tree is read. */
  fetch(sha: string): Promise<void>;
};

export const buildCandidatePublisher = (config: CandidatePublicationConfig, options: BuildOptions = {}): CandidatePublisher => {
  if (!existsSync(config.deployRef.worktree)) {
    throw new ReleaseConfigError("RELEASE_RUNNER_PATH_MISSING", `deploy ref worktree: ${config.deployRef.worktree}`);
  }
  const git = options.git ?? defaultGit;
  return {
    tree: new GitCommitTreeReader(config.deployRef.worktree, git),
    candidates: new FileReleaseCandidateStore(config.candidateDirectory),
    async fetch(sha: string) {
      await git(["fetch", "--no-tags", config.deployRef.remote, sha], config.deployRef.worktree);
      await git(["fetch", "--no-tags", config.deployRef.remote, "main:refs/remotes/origin/main"], config.deployRef.worktree);
    },
  };
};

export type ProductionRelease = {
  readonly ports: ReleasePorts;
  /** The durable authority itself, for the gate and for resuming a session by id. */
  readonly authority: SqliteReleaseAuthorityStore;
  /** The open database, for the read-only questions verification asks of it. */
  readonly database: Database.Database;
  readonly orchestrator: ReleaseOrchestrator;
  readonly sessions: DeploySessions;
  readonly envelopes: FileCutoverEnvelopeStore;
  /** Physical namespace guard; bootstrap commands use this rather than path instructions. */
  readonly storage: SqliteCutoverStorage;
  /** Present only while the configured database is the verified legacy predecessor. */
  readonly bootstrapPreparation?: { prepare(request: PreparationRequest): Promise<PreparationResult> };
  readonly deployRef: ProductionDeployRefStore;
  readonly deployment: CoolifyDeploymentDriver;
  readonly candidates: FileReleaseCandidateStore;
  /**
   * The certification driver for a candidate.
   *
   * Built on demand rather than at composition time: it needs the release it is
   * certifying, and only the command that resolved a candidate knows which one
   * that is. The terminal is opened here too, so a composition used by a
   * command that never certifies never asks for one.
   */
  certificationFor(candidate: ReleaseCandidate): ProductionCertificationDriver;
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
   * The certification driver.
   *
   * Supplied by the caller rather than built here, because building it needs a
   * candidate - and only the command that resolved one knows which. A
   * composition without it refuses a maintenance cutover on the orchestrator's
   * first line, before the topology is even read.
   */
  readonly certification?: CertificationDriver;
  /** Test seam for the host adapter; production always controls the real Compose pair. */
  readonly runtimeControl?: Pick<DockerComposeRuntimeControl, "ensureStopped">;
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
  // This performs no mutation. A release runner must not create a plausible
  // looking state layout on whatever filesystem it happened to be pointed at.
  const storage = new SqliteCutoverStorage({
    databasePath: config.databasePath, replacementRoot: config.replacementRoot,
    stateDirectory: config.stateDirectory, archiveDirectory: config.archiveDirectory,
    envelopeDirectory: config.envelopeDirectory, journalPath: config.journalPath,
    lockPath: config.lockPath,
  });

  const lock = ReleaseRunnerLock.acquire(config.lockPath, now);
  let db: Database.Database | undefined;
  let databaseClosed = false;
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
    /**
     * The predecessor bridge, or nothing.
     *
     * Built only against a database that is still pre-launch. After the cutover
     * the launch lineage exists, this answers undefined, and a launch cutover
     * against an already-launched database refuses for want of a reader rather
     * than reading one lineage with the other's assumptions.
     */
    const predecessorReader = (): LegacyPredecessorTopologyReader | undefined => {
      if (!config.predecessor) return undefined;
      const identity = readSchemaIdentity(opened);
      if (identity.tableNames.includes("schema_identity")) return undefined;
      return new LegacyPredecessorTopologyReader({
        frontendReleaseUrl: config.topology.frontendReleaseUrl,
        adminReleaseUrl: config.topology.adminReleaseUrl,
        commerceReadyUrl: config.predecessor.commerceReadyUrl,
        db: opened, deployRef, now, fetch: options.fetch,
        expectedPredecessorSha: config.predecessor.expectedSha,
        expectedLedgerLength: config.predecessor.expectedLedgerLength,
      });
    };
    const authority = new SqliteReleaseAuthorityStore(opened);
    const candidatesStore = new FileReleaseCandidateStore(config.candidateDirectory);
    /** The release a session is for, read back from the session rather than restated. */
    const certificationForSession = (sessionId: string): ProductionCertificationDriver => {
      const session = authority.get(sessionId);
      const candidate = session?.candidateId ? candidatesStore.get(session.candidateId) : undefined;
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${session?.candidateId ?? sessionId}`);
      return certificationFor(candidate);
    };
    const sessions = new DeploySessions(authority, now);
    // Read, never written, by a deploy. Publication is a separate composition
    // with no database and no credential, so a deploy cannot mint the candidate
    // it is about to deploy.
    const candidates = candidatesStore;
    const ports: ReleasePorts = {
      sessions,
      candidates,
      clock: now,
      topology: new ProductionTopologyReader({
        frontendReleaseUrl: config.topology.frontendReleaseUrl,
        adminReleaseUrl: config.topology.adminReleaseUrl,
        db, deployRef, now, fetch: options.fetch,
      }),
      evidence: new DatabaseRuntimeEvidenceReader({ db, now, legal: () => activeLegalBinding(opened) }),
      // Present only while the database is still the predecessor's. Once the
      // cutover has run, the launch lineage is there and this is undefined, so
      // the bridge is not something a later release could reach for - it is
      // absent from the composition entirely.
      predecessor: predecessorReader(),
      deployment: new CoolifyDeploymentDriver(coolify),
      recovery: new CoolifyRecoveryDriver(coolify),
      // Built lazily, because it needs the candidate this deploy is for. The
      // orchestrator is handed a driver that resolves it from the session's own
      // candidate, so a cutover cannot be certified against a different release
      // than it deployed.
      // Declared async so a refusal while resolving the driver rejects like
      // every other failure here, rather than throwing synchronously out of a
      // call the caller is awaiting.
      certification: options.certification ?? {
        async issueCapability(sessionId) { return certificationForSession(sessionId).issueCapability(sessionId); },
        async preflight(capability) { return certificationForSession(capability.deploymentSessionId).preflight(capability); },
        async certify(capability) { return certificationForSession(capability.deploymentSessionId).certify(capability); },
      },
    };

    const predecessorTopology = ports.predecessor;
    const commerce = config.applications.find((application) => application.name === "commerce");
    const closeDatabaseForStorage = () => {
      if (databaseClosed) return;
      databaseClosed = true;
      opened.close();
    };
    const gateAtRestIsClosed = () => {
      const inspection = new Database(config.databasePath, { readonly: true, fileMustExist: true });
      try {
        const row = inspection.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get() as { sales_paused?: unknown } | undefined;
        return Number(row?.sales_paused ?? 1) === 1;
      } finally { inspection.close(); }
    };
    const bootstrapPreparation = predecessorTopology && commerce ? new BootstrapCutoverPreparation({
      fence: {
        async ensureClosed() {
          const result = opened.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1 AND sales_paused = 0").run();
          if (result.changes === 0 && !gateAtRestIsClosed()) throw new ReleaseRunnerError("BOOTSTRAP_EMERGENCY_GATE_UNAVAILABLE");
        },
        async isClosed() { return gateAtRestIsClosed(); },
      },
      quiescer: {
        async ensureQuiesced() {
          const id = await (ports.deployment as CoolifyDeploymentDriver).composeResourceId(commerce.uuid);
          await (options.runtimeControl ?? new DockerComposeRuntimeControl()).ensureStopped(id);
        },
      },
      census: {
        async inspect() {
          const integrity = opened.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
          const closed = gateAtRestIsClosed();
          const blockers = [
            ...(integrity?.integrity_check === "ok" ? [] : ["sqlite_integrity"]),
            ...(closed ? [] : ["emergency_sales_gate"]),
          ];
          return {
            admitted: blockers.length === 0, blockers,
            evidenceDigest: createHash("sha256").update(JSON.stringify({ integrity: integrity?.integrity_check, closed })).digest("hex"),
          };
        },
      },
      archiver: {
        async verifyOnlineBackups(cutoverId) { await storage.verifyOnlineBackups(cutoverId); },
        async prepareArchive(cutoverId) { closeDatabaseForStorage(); return storage.prepareArchive(cutoverId); },
        async ensureArchivedAndFresh(envelope) { await storage.ensureArchivedAndFresh(envelope); },
      },
      topology: predecessorTopology,
      envelopes: {
        async read(cutoverId) { return new FileCutoverEnvelopeStore(config.envelopeDirectory).read(cutoverId); },
        async writeOnce(envelope) { new FileCutoverEnvelopeStore(config.envelopeDirectory).write(envelope); },
      },
      clock: now,
    }) : undefined;

    const certificationFor = (candidate: ReleaseCandidate): ProductionCertificationDriver => new ProductionCertificationDriver({
      db: opened, candidate, now,
      adminBaseUrl: config.certification.adminBaseUrl,
      publicBaseUrl: config.certification.publicBaseUrl,
      serviceToken: config.certification.serviceToken,
      capabilityKey: config.certification.capabilityKey,
      citySlug: config.certification.citySlug,
      operator: {
        occurrence: readOperatorOccurrence(config.certification.occurrenceScopePath),
        checkoutBodyPath: config.certification.checkoutBodyPath,
      },
      terminal: openControllingTerminal(),
      fetch: options.fetch,
    });

    return {
      ports, sessions, journal, lock, deployRef, authority, candidates, certificationFor, database: opened,
      deployment: ports.deployment as CoolifyDeploymentDriver,
      envelopes: new FileCutoverEnvelopeStore(config.envelopeDirectory), storage, bootstrapPreparation,
      orchestrator: new ReleaseOrchestrator(ports),
      close() {
        closeDatabaseForStorage();
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
