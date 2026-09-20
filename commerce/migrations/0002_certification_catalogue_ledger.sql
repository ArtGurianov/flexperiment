-- What a certification's catalogue command already did.
--
-- The launch baseline materialized the certification run and its capability but
-- not this: the catalogue authority's ledger existed only as an in-memory
-- reference. Without it, a run whose creation response was lost does not know
-- the occurrence it may have made, and leaves one nobody can find - in the
-- production catalogue, during a cutover, with sales about to reopen.
--
-- The identity is `(run_id, command_kind)`, not a key the caller chose. A
-- client-supplied idempotency key only makes a *repeated* request safe; it says
-- nothing about a *fresh* key asking for the same operation again, which would
-- create a second certification occurrence in the production catalogue and
-- leave the first one orphaned. One run creates one occurrence, publishes it
-- once and opens it once, and that is a fact the database holds rather than a
-- discipline the caller is trusted with.
CREATE TABLE certification_catalogue_mutations (
  run_id TEXT NOT NULL REFERENCES certification_runs(run_id),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('CREATE_OCCURRENCE', 'PUBLISH_OCCURRENCE', 'OPEN_SALES')),
  -- Kept for the audit trail and for matching the armed command, but never the
  -- identity: see above.
  command_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  occurrence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, command_kind)
);

CREATE INDEX certification_catalogue_mutations_occurrence_idx
  ON certification_catalogue_mutations(occurrence_id);

-- One run touches one occurrence. A second occurrence under the same run would
-- mean the first is unaccounted for.
CREATE TRIGGER certification_catalogue_mutations_one_occurrence_per_run
BEFORE INSERT ON certification_catalogue_mutations
WHEN EXISTS (
  SELECT 1 FROM certification_catalogue_mutations
  WHERE run_id = NEW.run_id AND occurrence_id <> NEW.occurrence_id
)
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_OCCURRENCE_DIVERGED');
END;

-- Publication follows creation, and opening follows publication. Out of order
-- is not a slower path to the same place: an occurrence opened before it was
-- created is one this run never made.
CREATE TRIGGER certification_catalogue_mutations_publish_after_create
BEFORE INSERT ON certification_catalogue_mutations
WHEN NEW.command_kind = 'PUBLISH_OCCURRENCE'
  AND NOT EXISTS (SELECT 1 FROM certification_catalogue_mutations WHERE run_id = NEW.run_id AND command_kind = 'CREATE_OCCURRENCE')
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_OUT_OF_ORDER');
END;

CREATE TRIGGER certification_catalogue_mutations_open_after_publish
BEFORE INSERT ON certification_catalogue_mutations
WHEN NEW.command_kind = 'OPEN_SALES'
  AND NOT EXISTS (SELECT 1 FROM certification_catalogue_mutations WHERE run_id = NEW.run_id AND command_kind = 'PUBLISH_OCCURRENCE')
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_OUT_OF_ORDER');
END;

-- A recorded mutation is evidence of something that already happened. Rewriting
-- it would let a replay be answered with a different past than the one the run
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
