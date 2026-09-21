import type Database from "better-sqlite3";
import { isSourceCommit, type RuntimeEvidence, type RuntimeUnit } from "./runtime-identity";

/**
 * What a running instance says about itself, kept per instance rather than per
 * unit.
 *
 * The singleton it replaces could not tell a converged runtime from an old one
 * that had not stopped: one row per unit, overwritten on conflict, so the
 * newest writer erased the evidence that anything else was still alive. A
 * second row for the same unit is the point, not a conflict.
 *
 * Identity is written once at start. Only the heartbeat and the sweep move, and
 * the schema freezes the rest - so an instance cannot quietly restate which
 * commit it has been serving all along.
 */

export type RuntimeInstanceEvidence = RuntimeEvidence & {
  readonly instanceId: string;
  readonly unit: RuntimeUnit;
};

export class RuntimeInstanceEvidenceRecorder {
  constructor(
    private readonly db: Database.Database,
    private readonly instanceId: string,
    private readonly unit: RuntimeUnit,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Fails closed on a source commit it cannot vouch for. An instance that
   * cannot say what it is serving must not be able to record that it is
   * serving something - readiness reads these rows to decide convergence.
   */
  start(sourceCommit: string): RuntimeInstanceEvidence {
    if (!isSourceCommit(sourceCommit)) throw new Error("RUNTIME_EVIDENCE_SOURCE_COMMIT_INVALID");
    const now = this.clock().toISOString();
    // Restarting the same instance id resumes its row rather than creating a
    // second. The conflict clause only moves the heartbeat when the commit and
    // the unit still agree, so a restart claiming to serve something else is
    // refused rather than silently ignored - the frozen columns would never
    // have noticed, because such a write never reaches them.
    const recorded = this.db.prepare(`INSERT INTO runtime_instance_evidence(instance_id, unit, source_commit, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at
        WHERE runtime_instance_evidence.source_commit = excluded.source_commit
          AND runtime_instance_evidence.unit = excluded.unit`)
      .run(this.instanceId, this.unit, sourceCommit, now, now);
    if (recorded.changes !== 1) throw new Error("RUNTIME_INSTANCE_EVIDENCE_IDENTITY_IMMUTABLE");
    return this.read();
  }

  /** Moves only the heartbeat, and only for a row this instance already owns. */
  heartbeat(): RuntimeInstanceEvidence {
    this.moved("UPDATE runtime_instance_evidence SET heartbeat_at = ? WHERE instance_id = ?", this.clock().toISOString());
    return this.read();
  }

  /** A sweep that finished. Absent means "never", which readiness reads as not converged. */
  recordSuccessfulSweep(): RuntimeInstanceEvidence {
    const now = this.clock().toISOString();
    this.moved("UPDATE runtime_instance_evidence SET heartbeat_at = ?, last_successful_sweep_at = ? WHERE instance_id = ?", now, now);
    return this.read();
  }

  private moved(sql: string, ...values: string[]): void {
    const changed = this.db.prepare(sql).run(...values, this.instanceId);
    if (changed.changes !== 1) throw new Error("RUNTIME_INSTANCE_EVIDENCE_NOT_STARTED");
  }

  private read(): RuntimeInstanceEvidence {
    const row = this.db.prepare(`SELECT instance_id, unit, source_commit, started_at, heartbeat_at, last_successful_sweep_at
      FROM runtime_instance_evidence WHERE instance_id = ?`).get(this.instanceId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("RUNTIME_INSTANCE_EVIDENCE_NOT_STARTED");
    return {
      instanceId: String(row.instance_id),
      unit: String(row.unit) as RuntimeUnit,
      sourceCommit: String(row.source_commit),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
      lastSuccessfulSweepAt: row.last_successful_sweep_at === null ? null : String(row.last_successful_sweep_at),
    };
  }
}

/** Every instance that has ever reported, so readiness can see the ones that have not stopped. */
export const runtimeInstances = (db: Database.Database, unit?: RuntimeUnit): readonly RuntimeInstanceEvidence[] =>
  (db.prepare(`SELECT instance_id, unit, source_commit, started_at, heartbeat_at, last_successful_sweep_at
    FROM runtime_instance_evidence ${unit ? "WHERE unit = ?" : ""} ORDER BY started_at, instance_id`)
    .all(...(unit ? [unit] : [])) as Record<string, unknown>[])
    .map((row) => ({
      instanceId: String(row.instance_id),
      unit: String(row.unit) as RuntimeUnit,
      sourceCommit: String(row.source_commit),
      startedAt: String(row.started_at),
      heartbeatAt: String(row.heartbeat_at),
      lastSuccessfulSweepAt: row.last_successful_sweep_at === null ? null : String(row.last_successful_sweep_at),
    }));
