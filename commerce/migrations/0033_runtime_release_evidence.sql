CREATE TABLE runtime_release_evidence (
  unit TEXT PRIMARY KEY CHECK (unit IN ('COMMERCE', 'WORKER')),
  source_commit TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
