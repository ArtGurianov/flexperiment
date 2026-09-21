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
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'CREATE_OCCURRENCE', 'PUBLISH_OCCURRENCE', 'OPEN_SALES', 'CLOSE_SALES', 'HIDE_OCCURRENCE')),
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

-- Shutting requires something to shut. Cleanup may run from any point after
-- creation - a run that failed before publishing still has an occurrence to
-- close - so this is the only ordering it owes.
CREATE TRIGGER certification_catalogue_mutations_cleanup_after_create
BEFORE INSERT ON certification_catalogue_mutations
WHEN NEW.command_kind IN ('CLOSE_SALES', 'HIDE_OCCURRENCE')
  AND NOT EXISTS (SELECT 1 FROM certification_catalogue_mutations WHERE run_id = NEW.run_id AND command_kind = 'CREATE_OCCURRENCE')
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_OUT_OF_ORDER');
END;

-- A certification occurrence is never an ordinary purchase.
--
-- Being hidden from the catalogue and having an unguessable id are not
-- protections: after the deployment gate reopens, an OPEN occurrence this run
-- created is sellable to anyone who reaches it. So the ban lives here, below
-- every gate and every route, where no code path can be the one that forgot.
CREATE TRIGGER certification_occurrence_requires_claim
BEFORE INSERT ON orders
WHEN NEW.certification_run_id IS NULL
  AND EXISTS (SELECT 1 FROM certification_catalogue_mutations WHERE occurrence_id = NEW.occurrence_id)
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_OCCURRENCE_REQUIRES_CLAIM');
END;

-- And a certification order belongs to the run whose occurrence it is buying.
-- One run reaching into another's fixture would be a purchase attributed to a
-- certification that did not make it.
CREATE TRIGGER certification_order_matches_occurrence_run
BEFORE INSERT ON orders
WHEN NEW.certification_run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM certification_catalogue_mutations
    WHERE occurrence_id = NEW.occurrence_id AND run_id = NEW.certification_run_id)
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_ORDER_OCCURRENCE_MISMATCH');
END;

-- A release is not successful while its certification fixture is still for
-- sale. `completeTarget` settles the session and reopens public sales in one
-- operation, so an occurrence left OPEN at that moment becomes an ordinary
-- sellable event the instant the fence lifts.
CREATE TRIGGER certification_catalogue_shut_before_release_succeeds
BEFORE UPDATE ON deploy_sessions
WHEN NEW.state = 'SUCCEEDED' AND OLD.state <> 'SUCCEEDED'
  AND EXISTS (
    SELECT 1
      FROM certification_capabilities c
      JOIN certification_catalogue_mutations m ON m.run_id = c.run_id
      JOIN occurrences o ON o.id = m.occurrence_id
     WHERE c.deployment_session_id = NEW.id
       AND (o.sales_status <> 'CLOSED' OR o.visibility <> 'HIDDEN'))
BEGIN
  SELECT RAISE(ABORT, 'CERTIFICATION_CATALOGUE_STILL_OPEN');
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
