-- ART-200: the merchant owns LAB inventory. The unconfirmed hold is part of the
-- durable intent; consumed_at atomically replaces it with the order's seat.
ALTER TABLE checkout_quotes ADD COLUMN seat_hold_ref TEXT;
ALTER TABLE checkout_quotes ADD COLUMN seat_hold_expires_at TEXT;
CREATE UNIQUE INDEX checkout_quotes_seat_hold_ref_idx ON checkout_quotes(seat_hold_ref);

-- Older unconfirmed LAB quotes never reserved capacity. They cannot be adopted
-- as holds without overselling. Started payments and their order seats stay intact.
UPDATE checkout_quotes SET state='EXPIRED',failure_code='CHECKOUT_QUOTE_EXPIRED',updated_at=CURRENT_TIMESTAMP
WHERE storefront='LAB' AND consumed_at IS NULL
  AND state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW');

CREATE TRIGGER checkout_intent_seat_hold_insert_guard
BEFORE INSERT ON checkout_quotes
WHEN (NEW.storefront='LAB' AND (NEW.seat_hold_ref IS NULL OR NEW.seat_hold_expires_at IS NULL
  OR julianday(NEW.seat_hold_expires_at) IS NULL OR julianday(NEW.seat_hold_expires_at)<=julianday(NEW.created_at)
  OR json_extract(NEW.line_snapshot_json,'$.seatHold.ref') IS NOT NEW.seat_hold_ref
  OR json_extract(NEW.line_snapshot_json,'$.seatHold.expiresAt') IS NOT NEW.seat_hold_expires_at))
  OR (NEW.storefront<>'LAB' AND (NEW.seat_hold_ref IS NOT NULL OR NEW.seat_hold_expires_at IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_SEAT_HOLD_REQUIRED');
END;

CREATE TRIGGER checkout_intent_seat_hold_frozen_guard
BEFORE UPDATE ON checkout_quotes
WHEN NEW.seat_hold_ref IS NOT OLD.seat_hold_ref OR NEW.seat_hold_expires_at IS NOT OLD.seat_hold_expires_at
BEGIN
  SELECT RAISE(ABORT, 'CHECKOUT_SEAT_HOLD_FROZEN');
END;
