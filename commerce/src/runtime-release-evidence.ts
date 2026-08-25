import type Database from "better-sqlite3";

export type RuntimeUnit = "COMMERCE" | "WORKER";

const supportsSweepEvidence = (db: Database.Database) => db.prepare("PRAGMA table_info(runtime_release_evidence)").all()
  .some((column) => (column as { name: string }).name === "last_successful_sweep_at");

/** Returns false during the one-time pre-0033 bootstrap window without killing a worker. */
export const writeRuntimeReleaseEvidence = (db: Database.Database, unit: RuntimeUnit, sourceCommit: string, restart = false): boolean => {
  const available = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_release_evidence'").get();
  if (!available) return false;
  if (!supportsSweepEvidence(db)) {
    db.prepare(`INSERT INTO runtime_release_evidence(unit, source_commit, started_at, observed_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT(unit) DO UPDATE SET source_commit = excluded.source_commit,
        started_at = CASE WHEN ? THEN excluded.started_at ELSE runtime_release_evidence.started_at END,
        observed_at = excluded.observed_at`)
      .run(unit, sourceCommit, restart ? 1 : 0);
    return true;
  }
  db.prepare(`INSERT INTO runtime_release_evidence(unit, source_commit, started_at, observed_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(unit) DO UPDATE SET source_commit = excluded.source_commit,
      started_at = CASE WHEN ? OR runtime_release_evidence.source_commit <> excluded.source_commit THEN excluded.started_at ELSE runtime_release_evidence.started_at END,
      observed_at = excluded.observed_at,
      last_successful_sweep_at = CASE WHEN ? OR runtime_release_evidence.source_commit <> excluded.source_commit THEN NULL ELSE runtime_release_evidence.last_successful_sweep_at END`)
    .run(unit, sourceCommit, restart ? 1 : 0, restart ? 1 : 0);
  return true;
};

/** Records work completion separately from process liveness for release gates. */
export const recordSuccessfulWorkerSweep = (db: Database.Database, sourceCommit: string): boolean => {
  const available = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_release_evidence'").get();
  if (!available || !supportsSweepEvidence(db)) return false;
  const updated = db.prepare(`UPDATE runtime_release_evidence
    SET last_successful_sweep_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE unit = 'WORKER' AND source_commit = ?`).run(sourceCommit);
  return updated.changes === 1;
};
