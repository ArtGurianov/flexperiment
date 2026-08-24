-- Event Dump creation is an external, asynchronous command. A singleton
-- durable lease and a record of every pre-dispatch reservation fence concurrent
-- workers. The provider inventory is the authoritative capacity guard; the
-- local history is a defense-in-depth command-rate fence for ambiguous calls.
CREATE TABLE unisender_event_dump_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  create_lease_owner TEXT,
  create_lease_expires_at TEXT
);
INSERT INTO unisender_event_dump_control(singleton) VALUES (1);

CREATE TABLE unisender_event_dump_create_attempts (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL
);
CREATE INDEX unisender_event_dump_create_attempts_window_idx
  ON unisender_event_dump_create_attempts(started_at);

CREATE TABLE unisender_event_dump_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('CREATE_IN_FLIGHT', 'POLL_READY', 'POLL_RETRY', 'CREATE_UNKNOWN', 'CONSUMED', 'EXHAUSTED')),
  dump_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  create_started_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state IN ('POLL_READY', 'POLL_RETRY')) = (dump_id IS NOT NULL))
);
CREATE INDEX unisender_event_dump_runs_due_idx
  ON unisender_event_dump_runs(state, next_attempt_at, created_at);

-- Target rows carry only opaque local/provider identifiers. The partial unique
-- index gives each unresolved outbox exactly one active batch assignment.
CREATE TABLE unisender_event_dump_targets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES unisender_event_dump_runs(id),
  outbox_id TEXT NOT NULL REFERENCES email_outbox(id),
  job_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'CONSUMED', 'RETRY_WAIT', 'NO_LONGER_NEEDED')),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX unisender_event_dump_targets_active_outbox_unique
  ON unisender_event_dump_targets(outbox_id) WHERE state = 'ACTIVE';
CREATE INDEX unisender_event_dump_targets_candidate_idx
  ON unisender_event_dump_targets(outbox_id, state, next_attempt_at);
