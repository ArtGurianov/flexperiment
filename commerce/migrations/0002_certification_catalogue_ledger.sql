-- What a certification's catalogue command already did.
--
-- The launch baseline materialized the certification run and its capability but
-- not this: the catalogue authority's ledger existed only as an in-memory
-- reference. Without it, a run whose creation response was lost does not know
-- the occurrence it may have made, and leaves one nobody can find - in the
-- production catalogue, during a cutover, with sales about to reopen.
--
-- Keyed by the command's own idempotency key, so re-issuing the exact command
-- returns what it did rather than doing it again. The stored view is the
-- occurrence as the command left it, which is what a replaying run compares
-- against; it is deliberately a snapshot and not a live read, because the
-- question is "what did this key do", not "what is true now".
CREATE TABLE certification_catalogue_mutations (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES certification_runs(run_id),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('CREATE_OCCURRENCE', 'PUBLISH_OCCURRENCE', 'OPEN_SALES')),
  occurrence_id TEXT NOT NULL,
  occurrence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX certification_catalogue_mutations_run_idx
  ON certification_catalogue_mutations(run_id);

-- A recorded mutation is evidence of something that already happened. Rewriting
-- it would let a replay be answered with a different past than the one the key
-- actually produced.
CREATE TRIGGER certification_catalogue_mutations_immutable
BEFORE UPDATE ON certification_catalogue_mutations
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE');
END;

CREATE TRIGGER certification_catalogue_mutations_undeletable
BEFORE DELETE ON certification_catalogue_mutations
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_MUTATION_IMMUTABLE');
END;
