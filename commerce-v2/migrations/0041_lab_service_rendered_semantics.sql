-- FLEX-85 (D), owner directive v4.8 (22.11.2026): rendered_at is the moment rendering was recorded and
-- is never before the occurrence end; a check-in time is kept apart as the CHECKED_IN basis only. An
-- attendance list is cited by protected storage id and content hash, never stored here.
-- 0036 is immutable history (CI protects committed migration bytes), so the table is rebuilt here.
-- Any existing row is carried over: a CHECKED_IN check-in time moves to checked_in_at and rendered_at
-- becomes its recorded_at. A row that cannot satisfy the new checks aborts the migration (fail closed).
CREATE TABLE lab_service_renditions_v2 (
  order_line_id TEXT PRIMARY KEY REFERENCES order_lines(id),
  occurrence_ref TEXT NOT NULL REFERENCES lab_occurrences(occurrence_ref),
  basis TEXT NOT NULL CHECK (basis IN ('CHECKED_IN', 'ATTENDED_ATTESTED')),
  checked_in_at TEXT CHECK (checked_in_at IS NULL OR julianday(checked_in_at) IS NOT NULL),
  attestation_reason TEXT CHECK (attestation_reason IS NULL
    OR attestation_reason IN ('QR_SCAN_FAILED', 'SCANNER_UNAVAILABLE', 'ATTENDANCE_LIST_CONFIRMED')),
  rendered_at TEXT NOT NULL CHECK (julianday(rendered_at) IS NOT NULL),
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 200),
  recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL),
  CHECK ((basis = 'ATTENDED_ATTESTED') = (attestation_reason IS NOT NULL)),
  CHECK ((basis = 'CHECKED_IN') = (checked_in_at IS NOT NULL)),
  CHECK (julianday(rendered_at) <= julianday(recorded_at)),
  CHECK (attestation_reason IS NOT 'ATTENDANCE_LIST_CONFIRMED' OR (evidence_ref GLOB 'attendance-list:?*#sha256:*'
    AND length(substr(evidence_ref, instr(evidence_ref, '#sha256:') + 8)) = 64
    AND substr(evidence_ref, instr(evidence_ref, '#sha256:') + 8) NOT GLOB '*[^a-f0-9]*'))
);
INSERT INTO lab_service_renditions_v2(order_line_id,occurrence_ref,basis,checked_in_at,attestation_reason,rendered_at,
  evidence_ref,recorded_by,recorded_at)
SELECT order_line_id, occurrence_ref, basis, CASE WHEN basis = 'CHECKED_IN' THEN rendered_at END, attestation_reason,
  recorded_at, evidence_ref, recorded_by, recorded_at
FROM lab_service_renditions;
DROP TABLE lab_service_renditions;
ALTER TABLE lab_service_renditions_v2 RENAME TO lab_service_renditions;

CREATE INDEX lab_service_renditions_recorded ON lab_service_renditions(recorded_at, order_line_id);
CREATE TRIGGER lab_service_rendition_after_end BEFORE INSERT ON lab_service_renditions
WHEN julianday(NEW.rendered_at) < (SELECT julianday(ends_at) FROM lab_occurrences WHERE occurrence_ref = NEW.occurrence_ref)
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_BEFORE_END'); END;
CREATE TRIGGER lab_service_rendition_immutable BEFORE UPDATE ON lab_service_renditions
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_IMMUTABLE'); END;
CREATE TRIGGER lab_service_rendition_no_delete BEFORE DELETE ON lab_service_renditions
BEGIN SELECT RAISE(ABORT, 'LAB_SERVICE_RENDERED_IMMUTABLE'); END;
