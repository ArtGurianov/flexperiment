-- Keep Event Dump capacity/list probes durable and bounded across worker
-- restarts. A new migration preserves the already-versioned 0029 schema.
ALTER TABLE unisender_event_dump_control ADD COLUMN next_create_probe_at TEXT;
ALTER TABLE unisender_event_dump_control ADD COLUMN create_probe_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE unisender_event_dump_control ADD COLUMN last_create_probe_error TEXT;

-- A saturated batch cannot prove an unmatched job absent. Such a target is
-- retried through the documented job_id filter instead of repeating its broad
-- time window. requested_limit makes saturation detection durable per run.
ALTER TABLE unisender_event_dump_runs ADD COLUMN requested_limit INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE unisender_event_dump_runs ADD COLUMN job_id_filter TEXT;
ALTER TABLE unisender_event_dump_targets ADD COLUMN recovery_mode TEXT NOT NULL DEFAULT 'BATCH'
  CHECK (recovery_mode IN ('BATCH', 'TARGETED_JOB'));
