import Database from "better-sqlite3";
import { ForwardDeploy } from "./forward-deploy";
import { ForwardAdmissionError, ForwardSupersessionAdmissionGuard, GitHubCheckRunsAttestation, type CiAttestation, type InstalledRunner } from "./forward-admission";
import { currentBindingIn } from "./forward-target";
import { liveCapabilityBlocking, supersessionDefect } from "./supersession-safety";
import { revisionRunId } from "../certification/no-effect-retry";
import { unknownAppliedMigrations } from "../outbox-authority";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoolifyClient } from "./coolify";
import { CoolifyDeploymentDriver, CoolifyRecoveryDriver } from "./coolify-deployment";
import { PRODUCTION_CONVERGENCE, type ConvergencePolicy } from "./convergence";
import { FileCutoverEnvelopeStore } from "./cutover-envelope-file-store";
import type { CutoverEnvelope } from "./cutover-envelope";
import { adoptCutover } from "./cutover-handoff";
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
import { migrate, readSchemaIdentity } from "../db";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../certification/store-sqlite";
import { DatabaseRuntimeEvidenceReader, ProductionTopologyReader } from "./topology-reader";
import { SqliteCutoverStorage } from "./sqlite-cutover-storage";
import { BootstrapCutoverPreparation, type PreparationRequest, type PreparationResult } from "./cutover-preparation";
import { RuntimeQuiescenceAuthority } from "./runtime-quiescence-authority";
import { RuntimeQuiescer, type DatabaseIdentityProbe, type OpenHandleProbe, type RuntimeLifecycle } from "./runtime-quiescer";
import { BootstrapRollback } from "./bootstrap-rollback";
import { FileBootstrapRollbackReceiptStore } from "./bootstrap-rollback-file-store";
import { classifySchemaLineage } from "./schema-identity";
import { applyLaunchSeed, readLaunchCatalogue } from "../launch-seed";
import { loadCanonicalLegalRelease, publishLegalRelease } from "../legal-release";
import { LaunchBaselineAdmissionGuard, remoteMainTipRefresh, type LaunchBaselineAdmission } from "./launch-baseline-admission";

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
  #owner: string | undefined;

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
    const owner = randomUUID();
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now().toISOString(), owner }));
    } finally {
      closeSync(fd);
    }
    this.#held = true;
    this.#owner = owner;
    return true;
  }

  private holder(): { pid: number; acquiredAt: string; owner?: string } | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: unknown; acquiredAt?: unknown; owner?: unknown };
      if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return undefined;
      return { pid: parsed.pid, acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "unknown", owner: typeof parsed.owner === "string" ? parsed.owner : undefined };
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
    this.#owner = undefined;
    try { unlinkSync(this.path); } catch { /* already gone */ }
  }

  get ownerId(): string {
    if (!this.#held || !this.#owner) throw new ReleaseRunnerError("RELEASE_RUNNER_LOCK_NOT_HELD");
    return this.#owner;
  }

  async assertHeld(owner: string): Promise<void> {
    const current = this.holder();
    if (!this.#held || !this.#owner || owner !== this.#owner || current?.owner !== owner || current.pid !== process.pid) {
      throw new ReleaseRunnerError("RELEASE_RUNNER_LOCK_OWNERSHIP_LOST");
    }
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
  readonly topology: ReleasePorts["topology"];
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
    const deployRef = new ProductionDeployRefViewer({
      remote: config.deployRef.remote, ref: config.deployRef.ref,
      cwd: config.deployRef.worktree, git: options.git,
    });
    const lineage = classifySchemaLineage(readSchemaIdentity(db));
    const topology = lineage === "LEGACY"
      ? config.predecessor
        ? new LegacyPredecessorTopologyReader({
          frontendReleaseUrl: config.topology.frontendReleaseUrl,
          adminReleaseUrl: config.topology.adminReleaseUrl,
          commerceReadyUrl: config.predecessor.commerceReadyUrl,
          db, deployRef, now, fetch: options.fetch,
          expectedPredecessorSha: config.predecessor.expectedSha,
          expectedLedgerLength: config.predecessor.expectedLedgerLength,
        })
        : (() => { throw new ReleaseConfigError("READ_ONLY_PREDECESSOR_CONFIGURATION_MISSING"); })()
      : lineage === "SUPPORTED"
        ? new ProductionTopologyReader({
          frontendReleaseUrl: config.topology.frontendReleaseUrl,
          adminReleaseUrl: config.topology.adminReleaseUrl,
          db, now, fetch: options.fetch, deployRef,
        })
        : (() => { throw new ReleaseConfigError("READ_ONLY_SCHEMA_LINEAGE_UNOBSERVABLE", lineage); })();
    return {
      // A viewer, not the store: this composition has no object that can move
      // the pointer, and no credential that would let one.
      topology,
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
  /** Present only when the one trusted predecessor is configured. */
  readonly bootstrapRollback?: BootstrapRollback;
  readonly deployRef: ProductionDeployRefStore;
  readonly deployment: CoolifyDeploymentDriver;
  readonly candidates: FileReleaseCandidateStore;
  /** Consumption-time proof that a launch candidate is still current main. */
  readonly launchBaselineAdmission: LaunchBaselineAdmission;
  /** Carries an armed, stuck cutover session forward to a newer release. */
  readonly forwardDeploy: ForwardDeploy;
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
  /** Test seams for host observation; production uses the bounded real adapters. */
  readonly runtimeControl?: RuntimeLifecycle;
  readonly databaseIdentity?: DatabaseIdentityProbe;
  readonly openHandles?: OpenHandleProbe;
  readonly monotonicNow?: () => number;
  /**
   * The bounded wait for deployed and restored applications to become
   * observable. Production always waits; the suite injects a sleep that moves
   * its fixture forward instead of time.
   */
  readonly convergence?: ConvergencePolicy;
  /** Test seams for forward admission: the runner's own checkout, and CI. */
  readonly installedRunner?: InstalledRunner;
  readonly ciAttestation?: CiAttestation;
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
  const convergence = options.convergence ?? PRODUCTION_CONVERGENCE;

  for (const [label, path] of [["database", config.databasePath], ["deploy ref worktree", config.deployRef.worktree]] as const) {
    if (!existsSync(path)) throw new ReleaseConfigError("RELEASE_RUNNER_PATH_MISSING", `${label}: ${path}`);
  }
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
      // The trusted local repositories, so a prepared launch can prove its
      // predecessor artifacts without a running container to read them off.
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
    const admissionTree = new GitCommitTreeReader(config.deployRef.worktree, options.git ?? defaultGit);
    const launchBaselineAdmission = new LaunchBaselineAdmissionGuard(
      admissionTree,
      remoteMainTipRefresh({
        remote: config.deployRef.remote,
        cwd: config.deployRef.worktree,
        tree: admissionTree,
        git: options.git ?? defaultGit,
      }),
    );
    /** The release a session is for, read back from the session rather than restated. */
    /**
     * One driver per session for the life of this process.
     *
     * `preflight` proves an operator is present and opens their terminal;
     * `certify` then speaks on it. A fresh driver per call would open a second
     * terminal after arming, so what attendance proved and what the operator
     * answers on would be different channels.
     */
    const certificationDrivers = new Map<string, ProductionCertificationDriver>();
    const certificationForSession = (sessionId: string): ProductionCertificationDriver => {
      const cached = certificationDrivers.get(sessionId);
      if (cached) return cached;
      // The current binding's candidate: a session carried forward certifies
      // the release it was carried to.
      const binding = currentBindingIn(opened, sessionId);
      const candidate = binding?.candidateId ? candidatesStore.get(binding.candidateId) : undefined;
      if (!candidate) throw new Error(`RELEASE_CANDIDATE_NOT_PUBLISHED: ${binding?.candidateId ?? sessionId}`);
      const driver = certificationFor(candidate);
      certificationDrivers.set(sessionId, driver);
      return driver;
    };
    const sessions = new DeploySessions(authority, now);
    // Read, never written, by a deploy. Publication is a separate composition
    // with no database and no credential, so a deploy cannot mint the candidate
    // it is about to deploy.
    const candidates = candidatesStore;
    // One store, shared by the preparation that writes the envelope and the
    // deploy that adopts it. Two instances over the same directory would be two
    // things that could disagree about whether a handoff was consumed.
    const envelopes = new FileCutoverEnvelopeStore(config.envelopeDirectory);
    const requireEnvelope = (cutoverId: string): CutoverEnvelope => {
      const envelope = envelopes.read(cutoverId);
      if (!envelope) throw new ReleaseRunnerError("CUTOVER_ENVELOPE_NOT_FOUND", cutoverId);
      return envelope;
    };
    const ports: ReleasePorts = {
      sessions,
      candidates,
      clock: now,
      convergence,
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
      // The other half of that handoff. Once the launch database is in place
      // the bridge above is gone, and this is how a prepared cutover still
      // knows what production was before it started.
      cutoverAdoption: {
        preDeployTopology: (cutoverId) => requireEnvelope(cutoverId).preDeployTopology,
        adopt: (cutoverId, ownerId, candidate) => {
          const { session, reconciled } = adoptCutover(sessions, authority, envelopes, cutoverId, {
            ownerId,
            candidateId: candidate.id,
            // The candidate's commit, not the envelope's: this is the assertion
            // that the release being deployed is the one that was prepared, and
            // taking it from the envelope would compare it with itself.
            sourceCommit: candidate.sha,
            schemaLineage: classifySchemaLineage(readSchemaIdentity(opened)),
            adoptionNonce: requireEnvelope(cutoverId).adoptionNonce,
            now: now(),
          });
          return { session, reconciled };
        },
      },
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
    const runtimeQuiescenceAuthority = new RuntimeQuiescenceAuthority(options.monotonicNow ?? (() => performance.now()));
    /**
     * Coolify owns the containers, completely.
     *
     * "Stopped" is what the control plane says and what the runtime stops
     * answering - never a container listing. "Started" is a deploy of whatever
     * the tracked ref names, which is why recovery moves the pointer first.
     */
    const coolifyLifecycle: RuntimeLifecycle = {
      async stop(applicationUuid) { await client.stopApplication(applicationUuid); },
      // Polls for a positive `exited`, and refuses everything else. A single
      // read after an asynchronous stop is not evidence, and an unreadable
      // status is not evidence of absence.
      async assertStopped(applicationUuid) { await client.awaitApplicationStopped(applicationUuid); },
      async start(applicationUuid) {
        const deployment = await client.awaitDeployment(await client.startDeployment(applicationUuid));
        if (deployment.status !== "finished") throw new ReleaseRunnerError("RUNTIME_NOT_STARTED", `${applicationUuid}: ${deployment.status}`);
      },
    };
    const runtimeQuiescer = new RuntimeQuiescer({
      authority: runtimeQuiescenceAuthority,
      runtime: options.runtimeControl ?? coolifyLifecycle,
      database: options.databaseIdentity,
      handles: options.openHandles,
      lock,
      closeControllerDatabase: closeDatabaseForStorage,
    });
    // This performs no mutation. The same authority instance is the issuer in
    // runtimeQuiescer and the consumer in storage; a second registry cannot be
    // constructed by this composition.
    const storage = new SqliteCutoverStorage({
      databasePath: config.databasePath, replacementRoot: config.replacementRoot,
      stateDirectory: config.stateDirectory, archiveDirectory: config.archiveDirectory,
      envelopeDirectory: config.envelopeDirectory, journalPath: config.journalPath,
      lockPath: config.lockPath, authority: runtimeQuiescenceAuthority, revalidation: runtimeQuiescer,
      // A migrated database is not yet a servable one. The catalogue and the
      // legal release come from this release's own checkout, so what is
      // installed is exactly what the candidate carries. Both are idempotent
      // for an exact replay, which is what lets the caller re-run them.
      initializeLaunchDatabase: (launch) => {
        applyLaunchSeed(launch, readLaunchCatalogue());
        publishLegalRelease(launch, loadCanonicalLegalRelease());
      },
    });
    const gateAtRestIsClosed = () => {
      const inspection = new Database(config.databasePath, { readonly: true, fileMustExist: true });
      try {
        const row = inspection.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get() as { sales_paused?: unknown } | undefined;
        return Number(row?.sales_paused ?? 1) === 1;
      } finally { inspection.close(); }
    };
    const openGateAtRest = () => {
      const predecessor = new Database(config.databasePath, { fileMustExist: true });
      try {
        const result = predecessor.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1 AND sales_paused = 1").run();
        if (result.changes === 0 && gateAtRestIsClosed()) throw new ReleaseRunnerError("BOOTSTRAP_EMERGENCY_GATE_UNAVAILABLE");
      } finally { predecessor.close(); }
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
        async acquire(cutoverId) {
          const id = await (ports.deployment as CoolifyDeploymentDriver).composeResourceId(commerce.uuid);
          return runtimeQuiescer.acquire({
            sessionId: cutoverId,
            operation: "PREPARE",
            databasePath: config.databasePath,
            lockOwner: lock.ownerId,
            applicationUuid: commerce.uuid,
            applicationResourceId: id,
          });
        },
        async abortBeforeArchive(grant) { await runtimeQuiescer.resume(grant); },
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
        async createVerifiedBackups(cutoverId) { await storage.createVerifiedBackups(cutoverId); },
        async prepareArchive(cutoverId, grant) { return storage.prepareArchive(cutoverId, grant.lease, grant.binding); },
        async ensureArchivedAndFresh(envelope, grant, writeEnvelope) {
          await storage.ensureArchivedAndFresh(envelope, grant.lease, grant.binding, writeEnvelope);
        },
      },
      topology: predecessorTopology,
      envelopes: {
        async read(cutoverId) { return envelopes.read(cutoverId); },
        async writeOnce(envelope) { envelopes.write(envelope); },
      },
      clock: now,
    }) : undefined;

    const recovery = ports.recovery as CoolifyRecoveryDriver;
    const freshPredecessorObservation = async () => {
      if (!config.predecessor) throw new ReleaseRunnerError("BOOTSTRAP_PREDECESSOR_CONFIGURATION_MISSING");
      const inspection = new Database(config.databasePath, { readonly: true, fileMustExist: true });
      try {
        const integrity = inspection.pragma("integrity_check") as { integrity_check?: unknown }[];
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new ReleaseRunnerError("BOOTSTRAP_ROLLBACK_INTEGRITY_FAILED");
        if ((inspection.pragma("foreign_key_check") as unknown[]).length !== 0) throw new ReleaseRunnerError("BOOTSTRAP_ROLLBACK_FOREIGN_KEY_FAILED");
        const lineage = classifySchemaLineage(readSchemaIdentity(inspection));
        const topology = await new LegacyPredecessorTopologyReader({
          frontendReleaseUrl: config.topology.frontendReleaseUrl,
          adminReleaseUrl: config.topology.adminReleaseUrl,
          commerceReadyUrl: config.predecessor.commerceReadyUrl,
          db: inspection, deployRef, now, fetch: options.fetch,
          expectedPredecessorSha: config.predecessor.expectedSha,
          expectedLedgerLength: config.predecessor.expectedLedgerLength,
        }).observe();
        return { topology, lineage };
      } finally { inspection.close(); }
    };
    const surfaceAt = async (name: "frontend" | "admin", sha: string) => {
      const url = name === "frontend" ? config.topology.frontendReleaseUrl : config.topology.adminReleaseUrl;
      try {
        const response = await (options.fetch ?? globalThis.fetch)(url, { headers: { Accept: "application/json" } });
        if (!response.ok) return false;
        const body = JSON.parse(await response.text()) as { source_commit?: unknown };
        return body.source_commit === sha;
      } catch { return false; }
    };
    const bootstrapRollback = config.predecessor && commerce ? new BootstrapRollback({
      authority,
      envelopes,
      // Read fresh on each call: a prepared restore asks this before it starts
      // and the database underneath it is the thing being replaced.
      lineage: () => classifySchemaLineage(readSchemaIdentity(opened)),
      receipts: new FileBootstrapRollbackReceiptStore(join(config.envelopeDirectory, "rollback")),
      storage: {
        inspectPredecessorArchive(archive) { return storage.inspectPredecessorArchive(archive); },
        async restore(rollbackId, archive, grant) {
          return storage.restore(rollbackId, archive, grant.lease, grant.binding);
        },
      },
      runtime: {
        async acquire(rollbackId) {
          const resourceId = await (ports.deployment as CoolifyDeploymentDriver).composeResourceId(commerce.uuid);
          // Stopping an already-stopped application is idempotent through the
          // control plane, so a prepared restore and a session restore ask for
          // exactly the same thing. The distinction that existed here was a
          // distinction between Docker primitives, and it is gone with them.
          return runtimeQuiescer.acquire({
            sessionId: rollbackId,
            operation: "RESTORE",
            databasePath: config.databasePath,
            lockOwner: lock.ownerId,
            applicationUuid: commerce.uuid,
            applicationResourceId: resourceId,
          });
        },
        async applicationIsAt(name, sha) {
          if (name === "frontend" || name === "admin") return surfaceAt(name, sha);
          try {
            const observed = await freshPredecessorObservation();
            return observed.lineage === "LEGACY"
              && observed.topology.runtime.commerce === sha
              && observed.topology.runtime.worker === sha;
          } catch { return false; }
        },
        async restoreApplication(name, sha) { await recovery.restoreApplication(name, sha); },
      },
      refs: deployRef,
      verification: { observe: freshPredecessorObservation },
      predecessorGate: {
        async isClosed() { return gateAtRestIsClosed(); },
        async open() { openGateAtRest(); },
      },
      clock: now,
      convergence,
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
      // The function, not a channel: opening it here would put the attendance
      // requirement before AWAITING_OPERATOR, where nothing attended happens.
      terminal: openControllingTerminal,
      fetch: options.fetch,
    });

    const orchestrator = new ReleaseOrchestrator(ports);
    const git = options.git ?? defaultGit;
    const forwardDeploy = new ForwardDeploy({
      sessions,
      gate: () => authority.deploymentGate(),
      candidates,
      admission: new ForwardSupersessionAdmissionGuard(
        admissionTree,
        remoteMainTipRefresh({ remote: config.deployRef.remote, cwd: config.deployRef.worktree, tree: admissionTree, git }),
        options.installedRunner ?? (async (candidateSha) => {
          const cwd = process.cwd();
          return {
            sha: (await git(["rev-parse", "HEAD"], cwd)).trim(),
            tree: (await git(["rev-parse", "HEAD^{tree}"], cwd)).trim(),
            candidateTree: (await git(["rev-parse", `${candidateSha}^{tree}`], cwd)).trim(),
            clean: (await git(["status", "--porcelain"], cwd)).trim() === "",
          };
        }),
        options.ciAttestation ?? (config.ciAttestation
          ? new GitHubCheckRunsAttestation({ repository: config.ciAttestation.repository, tokenFile: config.ciAttestation.tokenFile, fetch: options.fetch, now })
          : { async attest() { throw new ForwardAdmissionError("FORWARD_DEPLOY_ADMISSION_REFUSED", "FLEXPERIMENT_CI_REPOSITORY is not configured"); } }),
      ),
      supersessionDefect: (sessionId, releaseSha) => supersessionDefect(opened, sessionId, releaseSha),
      liveCapability: (sessionId) => liveCapabilityBlocking(opened, sessionId, now()),
      revokeCapability: (capabilityId, sessionId) => new SqliteCertificationCapabilityStore(opened).revokeForForwardSupersession(capabilityId, sessionId),
      // The runner's own checkout is the candidate (admission proved it), so
      // its migrations are the candidate's.
      migrate: () => migrate(opened),
      unknownMigrations: () => unknownAppliedMigrations(opened),
      refs: deployRef,
      deployment: ports.deployment as CoolifyDeploymentDriver,
      topology: ports.topology,
      revisionRunExists: (sessionId, revision) => Boolean(new SqliteCertificationRunStore(opened).load(revisionRunId(sessionId, revision))),
      finishForward: (sessionId, request) => orchestrator.finishForward(sessionId, request),
      journal,
    });

    return {
      ports, sessions, journal, lock, deployRef, authority, candidates, launchBaselineAdmission, forwardDeploy, certificationFor, database: opened,
      deployment: ports.deployment as CoolifyDeploymentDriver,
      envelopes, storage, bootstrapPreparation, bootstrapRollback,
      orchestrator,
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
