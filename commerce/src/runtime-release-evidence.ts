import type Database from "better-sqlite3";

export const writeRuntimeReleaseEvidence = (db: Database.Database, unit: "COMMERCE" | "WORKER", sourceCommit: string, restart = false): boolean => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_release_evidence'").get()) return false;
  db.prepare(`INSERT INTO runtime_release_evidence(unit, source_commit, started_at, observed_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(unit) DO UPDATE SET source_commit = excluded.source_commit,
      started_at = CASE WHEN ? THEN excluded.started_at ELSE runtime_release_evidence.started_at END,
      observed_at = excluded.observed_at`).run(unit, sourceCommit, restart ? 1 : 0);
  return true;
};
