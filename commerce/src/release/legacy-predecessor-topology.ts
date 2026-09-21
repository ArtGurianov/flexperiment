import type Database from "better-sqlite3";
import { readSchemaIdentity } from "../db";
import { classifySchemaLineage } from "./schema-identity";
import { isFreshTimestamp, isSourceCommit } from "./runtime-identity";
import { TopologyReadError } from "./topology-reader";
import type { DeploymentObservation, DeploySurface, RuntimeTopology } from "./deploy-session";

/**
 * The one predecessor this release is allowed to cut over from, read from the
 * only evidence that predecessor produces.
 *
 * It exists because the canonical reader cannot answer for the old lineage at
 * all: `runtime_instance_evidence` arrives with `0001_launch_baseline`, so on
 * the database a cutover starts from, reading it throws. That would stop
 * `runMaintenanceCutover` on its first line - before the fence - and would stop
 * a bootstrap rollback from proving it restored what it said it restored.
 *
 * This is deliberately not a fallback inside the canonical reader. A reader
 * that caught "no such table" and quietly changed source would be a permanent
 * compatibility branch, and the point of the launch baseline is that no such
 * branch survives it. This is a separate object, chosen by the orchestrator for
 * two named phases, refusing everything else - and it is deleted with the
 * predecessor runbook once the cutover is done.
 *
 * It never writes, never migrates, and refuses any legacy database that is not
 * the expected predecessor.
 */

export type LegacyPredecessorOptions = {
  readonly frontendReleaseUrl: string;
  readonly adminReleaseUrl: string;
  /** Unauthenticated, and the only live proof the old commerce process is up. */
  readonly commerceReadyUrl: string;
  readonly db: Database.Database;
  readonly deployRef: { read(): Promise<string> };
  /** The single commit this bridge may report. Anything else is refused. */
  readonly expectedPredecessorSha: string;
  /** The predecessor's migration ledger, exactly. */
  readonly expectedLedgerLength: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** How stale the worker's heartbeat may be before it stops proving anything. */
  readonly workerHeartbeatMaximumAgeMs?: number;
};

const DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS = 15 * 60_000;

type EvidenceRow = { unit: string; source_commit: string; observed_at: string; last_successful_sweep_at: string | null };

export class LegacyPredecessorTopologyReader {
  constructor(private readonly options: LegacyPredecessorOptions) {}

  /**
   * Both layers of the predecessor, or a refusal.
   *
   * Every precondition is checked before any value is reported, and all of them
   * have to hold at once. A legacy database that is merely *a* legacy database
   * is refused: this bridge is bound to one predecessor, so an unexpected one
   * is an operator pointing a cutover at something nobody reviewed.
   */
  async observe(): Promise<DeploymentObservation> {
    this.assertPredecessorDatabase();

    const [frontend, admin] = await Promise.all([
      this.readDescriptor("frontend", this.options.frontendReleaseUrl),
      this.readDescriptor("admin", this.options.adminReleaseUrl),
    ]);
    await this.assertCommerceAnswering();

    const runtime: RuntimeTopology = {
      frontend, admin,
      commerce: this.readUnit("COMMERCE"),
      worker: this.readUnit("WORKER"),
    };

    const productionDeployRefSha = await this.readDeployRef();
    // Everything agrees, and agrees with the one commit this bridge is for.
    // The old recorder keeps one row per unit and overwrites it, so it cannot
    // by itself distinguish a fresh instance from an older one still running.
    // Requiring all five readings to agree with a reviewed commit is what
    // closes that: an overlap can only pass if nothing actually disagrees.
    for (const [surface, sha] of [...Object.entries(runtime), ["deploy ref", productionDeployRefSha]] as [string, string][]) {
      if (sha !== this.options.expectedPredecessorSha) {
        throw new TopologyReadError("LEGACY_PREDECESSOR_TOPOLOGY_DISAGREES", `${surface}: ${sha}`);
      }
    }

    return { runtime, controlPlane: { productionDeployRefSha } };
  }

  /**
   * The database is the expected predecessor, and is still pre-launch.
   *
   * `flexperiment-launch` here means the cutover already happened and something
   * is asking the wrong reader. That is refused rather than answered, because
   * the answer would be a frozen topology for a lineage this bridge knows
   * nothing about.
   */
  private assertPredecessorDatabase(): void {
    const identity = readSchemaIdentity(this.options.db);
    const lineage = classifySchemaLineage(identity);
    if (lineage !== "LEGACY") throw new TopologyReadError("LEGACY_PREDECESSOR_LINEAGE_NOT_LEGACY", lineage);
    if (identity.tableNames.includes("schema_identity")) throw new TopologyReadError("LEGACY_PREDECESSOR_ALREADY_LAUNCHED");
    if (identity.tableNames.includes("runtime_instance_evidence")) {
      // The launch schema's own evidence table. Its presence means the
      // canonical reader is the right one and this bridge is not.
      throw new TopologyReadError("LEGACY_PREDECESSOR_HAS_LAUNCH_EVIDENCE");
    }
    if (!identity.tableNames.includes("runtime_release_evidence")) {
      throw new TopologyReadError("LEGACY_PREDECESSOR_HAS_NO_EVIDENCE");
    }
    const ledger = this.options.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    if (ledger.n !== this.options.expectedLedgerLength) {
      throw new TopologyReadError("LEGACY_PREDECESSOR_LEDGER_UNEXPECTED", `${ledger.n} migrations`);
    }
  }

  /**
   * Commerce is up, proved without a credential.
   *
   * Its evidence row is written once at startup and never refreshed, so the row
   * says which commit started - not that anything is still running. The old
   * runtime has no unauthenticated surface that names its commit, and its
   * `/v1/admin/system/evidence` sits behind a browser session this must not
   * automate. So liveness and identity are proved separately: `/readyz` for
   * one, the row for the other, and the agreement check above for the join.
   */
  private async assertCommerceAnswering(): Promise<void> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(this.options.commerceReadyUrl, { headers: { Accept: "application/json" } });
    } catch (error) {
      throw new TopologyReadError("LEGACY_PREDECESSOR_COMMERCE_UNREACHABLE", error instanceof Error ? error.message : "unknown error");
    }
    if (!response.ok) throw new TopologyReadError("LEGACY_PREDECESSOR_COMMERCE_NOT_READY", `HTTP ${response.status}`);
  }

  private readUnit(unit: "COMMERCE" | "WORKER"): string {
    const row = this.options.db.prepare(`SELECT unit, source_commit, observed_at, last_successful_sweep_at
      FROM runtime_release_evidence WHERE unit = ?`).get(unit) as EvidenceRow | undefined;
    if (!row) throw new TopologyReadError("LEGACY_PREDECESSOR_UNIT_MISSING", unit);
    if (!isSourceCommit(row.source_commit)) throw new TopologyReadError("LEGACY_PREDECESSOR_UNIT_COMMIT_INVALID", unit);

    if (unit === "WORKER") {
      // The worker refreshes this row as it sweeps, so here staleness is real
      // evidence of a stopped worker. Commerce's row is a start record and is
      // deliberately not aged: aging it would refuse a perfectly healthy
      // predecessor for the crime of having been up for a while.
      const now = this.options.now?.() ?? new Date();
      const maxAge = this.options.workerHeartbeatMaximumAgeMs ?? DEFAULT_WORKER_HEARTBEAT_MAX_AGE_MS;
      if (!isFreshTimestamp(row.observed_at, now, maxAge)) {
        throw new TopologyReadError("LEGACY_PREDECESSOR_WORKER_STALE", row.observed_at);
      }
      if (!row.last_successful_sweep_at) throw new TopologyReadError("LEGACY_PREDECESSOR_WORKER_NEVER_SWEPT", unit);
    }
    return row.source_commit;
  }

  private async readDeployRef(): Promise<string> {
    let sha: string;
    try {
      sha = await this.options.deployRef.read();
    } catch (error) {
      throw new TopologyReadError("LEGACY_PREDECESSOR_DEPLOY_REF_UNREADABLE", error instanceof Error ? error.message : "unknown error");
    }
    if (!isSourceCommit(sha)) throw new TopologyReadError("LEGACY_PREDECESSOR_DEPLOY_REF_INVALID", String(sha ?? "absent"));
    return sha;
  }

  private async readDescriptor(surface: DeploySurface, url: string): Promise<string> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { headers: { Accept: "application/json" } });
    } catch (error) {
      throw new TopologyReadError("LEGACY_PREDECESSOR_SURFACE_UNREACHABLE", `${surface}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!response.ok) throw new TopologyReadError("LEGACY_PREDECESSOR_SURFACE_UNREACHABLE", `${surface}: HTTP ${response.status}`);
    let descriptor: Record<string, unknown>;
    try {
      descriptor = JSON.parse(await response.text()) as Record<string, unknown>;
    } catch {
      throw new TopologyReadError("LEGACY_PREDECESSOR_SURFACE_MALFORMED", surface);
    }
    const commit = descriptor.source_commit;
    if (!isSourceCommit(commit)) throw new TopologyReadError("LEGACY_PREDECESSOR_SURFACE_COMMIT_INVALID", `${surface}: ${String(commit ?? "absent")}`);
    return commit;
  }
}
