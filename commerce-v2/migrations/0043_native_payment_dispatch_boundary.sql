-- Older rows may already have reached the provider. Only the new writer inserts 0.
ALTER TABLE native_payments ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 1
  CHECK (dispatch_started IN (0, 1));

CREATE TRIGGER native_payment_dispatch_irreversible
BEFORE UPDATE OF dispatch_started ON native_payments
WHEN OLD.dispatch_started = 1 AND NEW.dispatch_started = 0
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_PAYMENT_DISPATCH_ALREADY_STARTED');
END;
