-- ART-199: v1's proven occurrence rules on the v2 model (design 2026-10-18 §1.4, §4).
-- The occurrence keeps a lifecycle (SCHEDULED / CANCELLED); finished is derived from
-- ends_at and never stored. Selling is offers.sale_mode alone, so the second sales
-- status goes away. No production occurrence exists (launch catalogue is empty and v2
-- had no writer), so a legacy row only loses a column that never opened a sale.
ALTER TABLE lab_occurrences DROP COLUMN sales_status;

ALTER TABLE lab_occurrences ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
-- Bumped only by a customer-facing change (title, schedule, venue disclosure).
ALTER TABLE lab_occurrences ADD COLUMN material_revision INTEGER NOT NULL DEFAULT 1 CHECK (material_revision >= 1);
ALTER TABLE lab_occurrences ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'SCHEDULED'
  CHECK (lifecycle IN ('SCHEDULED', 'CANCELLED'));
ALTER TABLE lab_occurrences ADD COLUMN cancelled_at TEXT;
ALTER TABLE lab_occurrences ADD COLUMN cancellation_reason TEXT;
ALTER TABLE lab_occurrences ADD COLUMN visibility TEXT NOT NULL DEFAULT 'UNLISTED'
  CHECK (visibility IN ('LISTED', 'UNLISTED'));
ALTER TABLE lab_occurrences ADD COLUMN admin_reserved_seats INTEGER NOT NULL DEFAULT 0 CHECK (admin_reserved_seats >= 0);
-- NULL only on a legacy row: it is never listed or sold until a venue is declared.
ALTER TABLE lab_occurrences ADD COLUMN venue_status TEXT
  CHECK (venue_status IS NULL OR venue_status IN ('CONFIRMED', 'TO_BE_ANNOUNCED'));
ALTER TABLE lab_occurrences ADD COLUMN venue_name TEXT;
ALTER TABLE lab_occurrences ADD COLUMN venue_address TEXT;
-- Whether the confirmed venue appears in the public catalogue; a buyer always receives it.
ALTER TABLE lab_occurrences ADD COLUMN venue_public INTEGER NOT NULL DEFAULT 0 CHECK (venue_public IN (0, 1));
ALTER TABLE lab_occurrences ADD COLUMN venue_disclosure_text TEXT;
ALTER TABLE lab_occurrences ADD COLUMN venue_announce_by TEXT;

CREATE TRIGGER lab_occurrences_insert_guard
BEFORE INSERT ON lab_occurrences
WHEN NEW.venue_status IS NULL
  OR NEW.lifecycle <> 'SCHEDULED' OR NEW.cancelled_at IS NOT NULL OR NEW.cancellation_reason IS NOT NULL
  OR NEW.admin_reserved_seats > NEW.capacity
  OR (NEW.venue_status = 'CONFIRMED' AND (
    length(trim(COALESCE(NEW.venue_name, ''))) = 0 OR length(trim(COALESCE(NEW.venue_address, ''))) = 0
    OR NEW.venue_disclosure_text IS NOT NULL OR NEW.venue_announce_by IS NOT NULL))
  OR (NEW.venue_status = 'TO_BE_ANNOUNCED' AND (
    length(trim(COALESCE(NEW.venue_disclosure_text, ''))) = 0 OR julianday(NEW.venue_announce_by) IS NULL
    OR julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
    OR NEW.venue_name IS NOT NULL OR NEW.venue_address IS NOT NULL OR NEW.venue_public = 1))
BEGIN
  SELECT RAISE(ABORT, 'LAB_OCCURRENCE_CONTRACT_INVALID');
END;

CREATE TRIGGER lab_occurrences_update_guard
BEFORE UPDATE ON lab_occurrences
WHEN OLD.lifecycle = 'CANCELLED'
  OR NEW.id IS NOT OLD.id OR NEW.occurrence_ref IS NOT OLD.occurrence_ref OR NEW.city_id IS NOT OLD.city_id
  OR (NEW.venue_status IS NULL AND OLD.venue_status IS NOT NULL)
  OR NEW.admin_reserved_seats > NEW.capacity
  OR (NEW.lifecycle = 'SCHEDULED' AND (NEW.cancelled_at IS NOT NULL OR NEW.cancellation_reason IS NOT NULL))
  OR (NEW.lifecycle = 'CANCELLED' AND (julianday(NEW.cancelled_at) IS NULL
    OR length(trim(COALESCE(NEW.cancellation_reason, ''))) = 0))
  OR (NEW.venue_status IS NULL AND (NEW.visibility = 'LISTED' OR NEW.venue_public = 1
    OR NEW.venue_name IS NOT NULL OR NEW.venue_address IS NOT NULL
    OR NEW.venue_disclosure_text IS NOT NULL OR NEW.venue_announce_by IS NOT NULL))
  OR (NEW.venue_status = 'CONFIRMED' AND (
    length(trim(COALESCE(NEW.venue_name, ''))) = 0 OR length(trim(COALESCE(NEW.venue_address, ''))) = 0
    OR NEW.venue_disclosure_text IS NOT NULL OR NEW.venue_announce_by IS NOT NULL))
  OR (NEW.venue_status = 'TO_BE_ANNOUNCED' AND (
    length(trim(COALESCE(NEW.venue_disclosure_text, ''))) = 0 OR julianday(NEW.venue_announce_by) IS NULL
    OR julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
    OR NEW.venue_name IS NOT NULL OR NEW.venue_address IS NOT NULL OR NEW.venue_public = 1))
BEGIN
  SELECT RAISE(ABORT, 'LAB_OCCURRENCE_CONTRACT_INVALID');
END;

-- The public URL segment of a city never changes; only its title may.
CREATE TRIGGER cities_slug_immutable
BEFORE UPDATE OF id, slug ON cities
WHEN NEW.id IS NOT OLD.id OR NEW.slug IS NOT OLD.slug
BEGIN
  SELECT RAISE(ABORT, 'CITY_IDENTITY_IMMUTABLE');
END;

-- One immutable row per committed occurrence version: what changed, by whom and why.
CREATE TABLE lab_occurrence_revisions (
  id TEXT PRIMARY KEY,
  occurrence_ref TEXT NOT NULL REFERENCES lab_occurrences(occurrence_ref),
  version INTEGER NOT NULL CHECK (version >= 1),
  material_revision INTEGER NOT NULL CHECK (material_revision >= 1),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('CREATED', 'EDITED', 'CANCELLED')),
  customer_facing INTEGER NOT NULL CHECK (customer_facing IN (0, 1)),
  changed_fields_json TEXT NOT NULL CHECK (json_valid(changed_fields_json) AND json_type(changed_fields_json) = 'array'),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE(occurrence_ref, version),
  CHECK ((change_kind = 'CREATED') = (before_json IS NULL))
);

CREATE TRIGGER lab_occurrence_revisions_immutable
BEFORE UPDATE ON lab_occurrence_revisions
BEGIN
  SELECT RAISE(ABORT, 'LAB_OCCURRENCE_REVISION_IMMUTABLE');
END;

CREATE TRIGGER lab_occurrence_revisions_delete_guard
BEFORE DELETE ON lab_occurrence_revisions
BEGIN
  SELECT RAISE(ABORT, 'LAB_OCCURRENCE_REVISION_IMMUTABLE');
END;
