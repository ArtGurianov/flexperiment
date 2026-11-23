-- FLEX-57–62 / FLEX-85 (D): LAB purchase acceptance on a confirmed account, occurrence cancellation
-- with committed seats, the authoritative SERVICE_RENDERED fact and the account-owned ticket QR
-- generation. Executor of record and the closing-receipt outbox belong to C (FLEX-119, #289).
-- Every row hangs off an order or its line: financial/legal evidence retained with the order. No
-- email, IP or free text. A customer with an order is already not erasable here (financial review).

-- Minimum purchase acceptance: document versions/hashes, the explicit choices, time, link to the
-- order and its snapshot. Written in the order-confirmation transaction; independent of guest rows.
CREATE TABLE lab_purchase_acceptances (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  quote_id TEXT NOT NULL,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  release_version TEXT NOT NULL CHECK (length(release_version) BETWEEN 1 AND 128),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
  consents_json TEXT NOT NULL CHECK (json_valid(consents_json)),
  order_snapshot_hash TEXT NOT NULL CHECK (length(order_snapshot_hash) = 64),
  occurrence_snapshot_sha256 TEXT NOT NULL CHECK (length(occurrence_snapshot_sha256) = 64),
  accepted_at TEXT NOT NULL CHECK (julianday(accepted_at) IS NOT NULL),
  source TEXT NOT NULL CHECK (source = 'CONFIRMED_ACCOUNT_ORDER_CONFIRM'),
  evidence_status TEXT NOT NULL CHECK (evidence_status = 'VERIFIED_ACCOUNT')
);
CREATE TRIGGER lab_purchase_acceptance_immutable BEFORE UPDATE ON lab_purchase_acceptances
BEGIN SELECT RAISE(ABORT, 'LAB_ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER lab_purchase_acceptance_no_delete BEFORE DELETE ON lab_purchase_acceptances
BEGIN SELECT RAISE(ABORT, 'LAB_ACCEPTANCE_IMMUTABLE'); END;

-- Occurrence cancellation with committed seats: REQUESTED closes sales at once; COMPLETED only
-- after no started payment can still settle (FLEX-59 / owner decision I-1 invariant 3).
CREATE TABLE lab_occurrence_cancellations (
  occurrence_ref TEXT PRIMARY KEY REFERENCES lab_occurrences(occurrence_ref),
  state TEXT NOT NULL CHECK (state IN ('REQUESTED', 'COMPLETED')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  obligations_json TEXT CHECK (obligations_json IS NULL OR json_valid(obligations_json)),
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL AND obligations_json IS NOT NULL))
);
CREATE TRIGGER lab_occurrence_cancellation_forward_only BEFORE UPDATE ON lab_occurrence_cancellations
WHEN OLD.state = 'COMPLETED' OR NEW.occurrence_ref IS NOT OLD.occurrence_ref OR NEW.requested_at IS NOT OLD.requested_at
BEGIN SELECT RAISE(ABORT, 'LAB_CANCELLATION_FORWARD_ONLY'); END;
CREATE TRIGGER lab_occurrence_cancellation_no_delete BEFORE DELETE ON lab_occurrence_cancellations
BEGIN SELECT RAISE(ABORT, 'LAB_CANCELLATION_FORWARD_ONLY'); END;

-- The one authoritative SERVICE_RENDERED fact per order line (flexperiment.service-rendered/1),
-- read by C's FINAL_SETTLEMENT issuance. Append-only; CHECKED_IN is the primary basis, an attendance
-- attestation is a single-line admin action with a reason from a closed list.
CREATE TABLE lab_service_renditions (
  order_line_id TEXT PRIMARY KEY REFERENCES order_lines(id),
  occurrence_ref TEXT NOT NULL REFERENCES lab_occurrences(occurrence_ref),
  basis TEXT NOT NULL CHECK (basis IN ('CHECKED_IN', 'ATTENDED_ATTESTED')),
  attestation_reason TEXT CHECK (attestation_reason IS NULL
    OR attestation_reason IN ('QR_SCAN_FAILED', 'SCANNER_UNAVAILABLE', 'ATTENDANCE_LIST_CONFIRMED')),
  rendered_at TEXT NOT NULL CHECK (julianday(rendered_at) IS NOT NULL),
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL),
  CHECK ((basis = 'ATTENDED_ATTESTED') = (attestation_reason IS NOT NULL))
);
CREATE INDEX lab_service_renditions_recorded ON lab_service_renditions(recorded_at, order_line_id);
CREATE TRIGGER lab_service_rendition_immutable BEFORE UPDATE ON lab_service_renditions
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_IMMUTABLE'); END;
CREATE TRIGGER lab_service_rendition_no_delete BEFORE DELETE ON lab_service_renditions
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_IMMUTABLE'); END;

-- Account-owned tickets (FLEX-60/123): the QR is derived from a server secret and this generation;
-- a normal view keeps it, only an explicit reissue moves the generation and revokes the old QR.
ALTER TABLE lab_tickets ADD COLUMN qr_generation INTEGER NOT NULL DEFAULT 0 CHECK (qr_generation >= 0);
