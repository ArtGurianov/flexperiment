-- An event dump that has been read is given back to UniSender, durably.
--
-- UniSender stores at most ten dumps, each for eight hours, and the create path
-- refuses while nine exist. Deleting a dump once it has been read frees its
-- slot. That delete is a network call after the run has already finished, so
-- it can fail or be ambiguous, and a process can die before making it. The dump
-- to give back is therefore recorded in the same write that finishes the run,
-- and retried from there - never inferred, and never a reason to create more.
--
--   release_dump_id    the provider dump still to delete; NULL once deleted,
--                      or once it is past UniSender's eight-hour lifetime.
--   release_attempts   bounded: the provider-side count (event-dump/list)
--                      stays the authority on capacity either way.
--
-- Predeploy-compatible: a nullable column and a defaulted counter.
ALTER TABLE unisender_event_dump_runs ADD COLUMN release_dump_id TEXT;
ALTER TABLE unisender_event_dump_runs ADD COLUMN release_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX unisender_event_dump_runs_release_idx
  ON unisender_event_dump_runs(create_started_at) WHERE release_dump_id IS NOT NULL;
