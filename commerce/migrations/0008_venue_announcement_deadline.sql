-- The public disclosure deadline is a catalog invariant, not merely a form
-- hint. These triggers also protect direct SQLite maintenance from creating a
-- TO_BE_ANNOUNCED occurrence whose promise is made after the workshop starts.
CREATE TRIGGER IF NOT EXISTS occurrences_venue_announce_before_insert
BEFORE INSERT ON occurrences
WHEN NEW.venue_status = 'TO_BE_ANNOUNCED'
  AND NEW.venue_announce_by IS NOT NULL
  AND julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
BEGIN
  SELECT RAISE(ABORT, 'VENUE_ANNOUNCEMENT_TOO_LATE');
END;

CREATE TRIGGER IF NOT EXISTS occurrences_venue_announce_before_update
BEFORE UPDATE OF venue_status, venue_announce_by, starts_at ON occurrences
WHEN NEW.venue_status = 'TO_BE_ANNOUNCED'
  AND NEW.venue_announce_by IS NOT NULL
  AND julianday(NEW.venue_announce_by) >= julianday(NEW.starts_at)
BEGIN
  SELECT RAISE(ABORT, 'VENUE_ANNOUNCEMENT_TOO_LATE');
END;
