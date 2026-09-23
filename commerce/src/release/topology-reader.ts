import type Database from "better-sqlite3";
import { readSchemaIdentity } from "../db";
import { classifySchemaLineage } from "./schema-identity";
import { isFreshTimestamp, isSourceCommit, type RuntimeEvidence } from "./runtime-identity";
import { runtimeInstances } from "./runtime-instance-evidence";
import type { DeploymentObservation, RuntimeTopology } from "./deploy-session";
import type { ReleaseReadinessEvidence } from "./readiness";

/**
 * What production is, in both the layers a cutover moves.
 *
 * Of the four runtime surfaces, two answer over HTTP through the descriptor
 * `pnpm build` writes and two through the evidence they record in the database
 * this reader runs beside. The fifth reading is the deploy pointer, which is
 * not a surface at all: it is where the deployment applications would deploy
 * from next.
 *
 * Every one of the five fails closed: unreachable, malformed, stale and
 * disagreeing all raise, rather than leaving a hole a comparison would skip
 * over. The pointer fails closed for a sharper reason than the rest - a reader
 * that answered "the runtime matched, the pointer was unreadable" would be
 * handing a caller the two thirds of an observation that argue for a safe
 * abort while silently dropping the third that could forbid it.
 */

export class TopologyReadError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * The read failures that are a rollout in progress rather than a fault.
 *
 * A unit with no live heartbeat yet, a surface the proxy has not switched to
 * the new container, two instances of one unit across old and new: each is
 * what production looks like for a few seconds after Coolify says "finished",
 * and each resolves by itself. A malformed descriptor, an invalid commit or an
 * unreadable or invalid deploy pointer does not, and waiting on one would only
 * delay a refusal that is already certain.
 */
const TRANSIENT_TOPOLOGY_READS = new Set(["TOPOLOGY_UNIT_NOT_RUNNING", "TOPOLOGY_SURFACE_UNREACHABLE", "TOPOLOGY_UNIT_DISAGREES"]);

export const isTransientTopologyRead = (error: unknown): boolean =>
  error instanceof TopologyReadError && TRANSIENT_TOPOLOGY_READS.has(error.code);

export type TopologyReaderOptions = {
  readonly frontendReleaseUrl: string;
  readonly adminReleaseUrl: string;
  readonly db: Database.Database;
  /** The deploy pointer's reader, injected so this stays a reader of production rather than a caller of git. */
  readonly deployRef: { read(): Promise<string> };
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** Beyond this, a heartbeat is not evidence that anything is still running. */
  readonly heartbeatMaximumAgeMs?: number;
};

const DEFAULT_HEARTBEAT_MAX_AGE_MS = 90_000;

export class ProductionTopologyReader {
  constructor(private readonly options: TopologyReaderOptions) {}

  /**
   * Both layers, always together.
   *
   * There is deliberately no public call that answers with the runtime alone.
   * A caller holding four surfaces and no pointer has the exact shape a safe
   * abort must never be decided from, and the cheapest way to keep it from
   * existing is to never hand it out.
   */
  async observe(): Promise<DeploymentObservation> {
    const [runtime, productionDeployRefSha] = await Promise.all([this.readRuntime(), this.readDeployRef()]);
    return { runtime, controlPlane: { productionDeployRefSha } };
  }

  private async readDeployRef(): Promise<string> {
    let sha: string;
    try {
      sha = await this.options.deployRef.read();
    } catch (error) {
      throw new TopologyReadError("TOPOLOGY_DEPLOY_REF_UNREADABLE", error instanceof Error ? error.message : "unknown error");
    }
    if (!isSourceCommit(sha)) throw new TopologyReadError("TOPOLOGY_DEPLOY_REF_INVALID", String(sha ?? "absent"));
    return sha;
  }

  private async readRuntime(): Promise<RuntimeTopology> {
    const [frontend, admin] = await Promise.all([
      this.readDescriptor("frontend", this.options.frontendReleaseUrl),
      this.readDescriptor("admin", this.options.adminReleaseUrl),
    ]);
    return {
      frontend,
      admin,
      commerce: this.readUnit("COMMERCE"),
      worker: this.readUnit("WORKER"),
    };
  }

  /**
   * One live instance, or nothing.
   *
   * Two instances of a unit serving different commits is not a surface with a
   * commit - it is a deploy in progress, and answering with either one would
   * let a caller conclude convergence from half of a rollout.
   */
  private readUnit(unit: "COMMERCE" | "WORKER"): string {
    const now = this.options.now?.() ?? new Date();
    const maxAge = this.options.heartbeatMaximumAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS;
    const live = runtimeInstances(this.options.db, unit)
      .filter((instance) => isFreshTimestamp(instance.heartbeatAt, now, maxAge));
    if (!live.length) throw new TopologyReadError("TOPOLOGY_UNIT_NOT_RUNNING", unit);
    const commits = new Set(live.map((instance) => instance.sourceCommit));
    if (commits.size > 1) throw new TopologyReadError("TOPOLOGY_UNIT_DISAGREES", `${unit}: ${[...commits].join(", ")}`);
    const [commit] = commits;
    if (!isSourceCommit(commit)) throw new TopologyReadError("TOPOLOGY_UNIT_COMMIT_INVALID", unit);
    return commit;
  }

  private async readDescriptor(surface: string, url: string): Promise<string> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { headers: { Accept: "application/json" } });
    } catch (error) {
      throw new TopologyReadError("TOPOLOGY_SURFACE_UNREACHABLE", `${surface}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!response.ok) throw new TopologyReadError("TOPOLOGY_SURFACE_UNREACHABLE", `${surface}: HTTP ${response.status}`);
    let descriptor: Record<string, unknown>;
    try {
      descriptor = JSON.parse(await response.text()) as Record<string, unknown>;
    } catch {
      throw new TopologyReadError("TOPOLOGY_SURFACE_MALFORMED", surface);
    }
    const commit = descriptor.source_commit;
    if (!isSourceCommit(commit)) throw new TopologyReadError("TOPOLOGY_SURFACE_COMMIT_INVALID", `${surface}: ${String(commit ?? "absent")}`);
    return commit;
  }
}

export type RuntimeEvidenceReaderOptions = {
  readonly db: Database.Database;
  readonly now?: () => Date;
  readonly heartbeatMaximumAgeMs?: number;
  readonly legal?: () => { readonly version: string; readonly manifestSha256: string } | undefined;
};

/**
 * The durable half of readiness: what the two units recorded about themselves,
 * plus the lineage and legal binding of the database they recorded it in.
 *
 * It reports rather than judges. `evaluateReadiness` owns the verdict, and the
 * distinction matters: a reader that decided would have to answer "converged"
 * or "not", and readiness needs a third answer - converged and inadmissible.
 */
export class DatabaseRuntimeEvidenceReader {
  constructor(private readonly options: RuntimeEvidenceReaderOptions) {}

  async read(): Promise<ReleaseReadinessEvidence> {
    const identity = readSchemaIdentity(this.options.db);
    const versions = identity.tableNames.includes("schema_migrations")
      ? (this.options.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map((row) => row.version)
      : [];
    // Reporting a database of the wrong lineage is part of this reader's job,
    // so it has to survive one. A legacy database has no evidence table at all,
    // and reading the units first would crash exactly where the answer matters.
    const records = identity.tableNames.includes("runtime_instance_evidence");
    return {
      commerce: records ? this.unit("COMMERCE") : undefined,
      worker: records ? this.unit("WORKER") : undefined,
      schema: { lineage: classifySchemaLineage(identity), versions },
      legal: this.options.legal?.(),
    };
  }

  /**
   * The freshest live instance, and undefined when there is none.
   *
   * Undefined is a real answer here - readiness reads it as "not converged" -
   * and it is the honest one for a unit that has recorded nothing this build
   * can vouch for.
   */
  private unit(unit: "COMMERCE" | "WORKER"): RuntimeEvidence | undefined {
    const now = this.options.now?.() ?? new Date();
    const maxAge = this.options.heartbeatMaximumAgeMs ?? DEFAULT_HEARTBEAT_MAX_AGE_MS;
    const live = runtimeInstances(this.options.db, unit)
      .filter((instance) => isFreshTimestamp(instance.heartbeatAt, now, maxAge))
      .sort((left, right) => right.heartbeatAt.localeCompare(left.heartbeatAt));
    if (!live.length) return undefined;
    // Disagreement is withheld rather than resolved: answering with one commit
    // while another instance serves a different one is how half a rollout reads
    // as a converged runtime.
    if (new Set(live.map((instance) => instance.sourceCommit)).size > 1) return undefined;
    const [freshest] = live;
    return {
      sourceCommit: freshest.sourceCommit,
      startedAt: freshest.startedAt,
      heartbeatAt: freshest.heartbeatAt,
      lastSuccessfulSweepAt: freshest.lastSuccessfulSweepAt ?? null,
    };
  }
}

