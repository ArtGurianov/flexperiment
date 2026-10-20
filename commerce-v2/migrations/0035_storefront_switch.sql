-- ART-319: the storefront switch (COURSES, LAB) is an owner-controlled host file mounted read-only
-- into Commerce (storefront-switch.ts). It is the first-sale gate and the emergency stop for new
-- paid money, and it replaces sales_activation. Nothing in this database can open a storefront:
-- the rows below only record what the runtime observed, so a file restored to an older generation,
-- or a generation reused for other content, is refused (fail closed) even after a restart.

CREATE TABLE storefront_switch_observations (
  generation INTEGER PRIMARY KEY CHECK (generation >= 1),
  document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'),
  scope TEXT NOT NULL CHECK (scope IN ('local', 'canary', 'production')),
  courses_state TEXT NOT NULL CHECK (courses_state IN ('OPEN', 'CLOSED')),
  courses_open_since INTEGER CHECK ((courses_state = 'OPEN') = (courses_open_since IS NOT NULL)),
  lab_state TEXT NOT NULL CHECK (lab_state IN ('OPEN', 'CLOSED')),
  lab_open_since INTEGER CHECK ((lab_state = 'OPEN') = (lab_open_since IS NOT NULL)),
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_issue TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  first_observed_at TEXT NOT NULL
);

CREATE TRIGGER storefront_switch_observations_append_only
BEFORE UPDATE ON storefront_switch_observations
BEGIN
  SELECT RAISE(ABORT, 'STOREFRONT_SWITCH_OBSERVATION_IMMUTABLE');
END;

CREATE TRIGGER storefront_switch_observations_no_delete
BEFORE DELETE ON storefront_switch_observations
BEGIN
  SELECT RAISE(ABORT, 'STOREFRONT_SWITCH_OBSERVATION_IMMUTABLE');
END;

-- The generation at which the quote's storefront was last opened. A quote is payable only while the
-- same opening lasts: a stop followed by a reopen ends every quote issued before the stop.
ALTER TABLE checkout_quotes ADD COLUMN storefront_open_since INTEGER
  CHECK (storefront_open_since IS NULL OR storefront_open_since >= 1);

-- Unconfirmed quotes from before the switch carry no opening: they ask for a fresh preview. A
-- consumed intent is never touched; its payment stays read-back governed.
UPDATE checkout_quotes SET state='EXPIRED',failure_code='CHECKOUT_QUOTE_STALE',updated_at=CURRENT_TIMESTAMP
WHERE consumed_at IS NULL AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW');

-- sales_activation stays as immutable history (no insert, update or delete); it authorizes nothing any more.
CREATE TRIGGER sales_activation_retired_insert
BEFORE INSERT ON sales_activation
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_RETIRED');
END;

CREATE TRIGGER sales_activation_retired_update
BEFORE UPDATE ON sales_activation
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_RETIRED');
END;

CREATE TRIGGER sales_activation_retired_delete
BEFORE DELETE ON sales_activation
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_RETIRED');
END;
