ALTER TABLE occurrences
  ADD COLUMN admin_reserved_seats INTEGER NOT NULL DEFAULT 0
  CHECK (admin_reserved_seats >= 0);
