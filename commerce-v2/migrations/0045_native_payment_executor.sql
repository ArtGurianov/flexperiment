-- Keep native operations tied to the executor selected before the first dispatch.
-- Existing native rows in the source base can only have been created by the local fake.
ALTER TABLE native_payments ADD COLUMN executor_key TEXT NOT NULL DEFAULT 'fake-bank';
ALTER TABLE native_payments ADD COLUMN fiscalization_mode TEXT
  CHECK (fiscalization_mode IN ('PROVIDER', 'MERCHANT'));

UPDATE native_payments
SET fiscalization_mode = CASE (
  SELECT json_extract(orders.checkout_snapshot_json, '$.paymentObligations[0].fiscalizationMode')
  FROM orders WHERE orders.id = native_payments.order_id
) WHEN 'PROVIDER' THEN 'PROVIDER' ELSE 'MERCHANT' END;

CREATE TRIGGER native_payment_executor_immutable
BEFORE UPDATE OF executor_key, fiscalization_mode ON native_payments
WHEN NEW.executor_key IS NOT OLD.executor_key OR NEW.fiscalization_mode IS NOT OLD.fiscalization_mode
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_PAYMENT_EXECUTOR_IMMUTABLE');
END;

-- A refund on an upgraded database may already be in flight.
ALTER TABLE native_refunds ADD COLUMN dispatch_started INTEGER NOT NULL DEFAULT 1
  CHECK (dispatch_started IN (0, 1));

CREATE TRIGGER native_refund_dispatch_irreversible
BEFORE UPDATE OF dispatch_started ON native_refunds
WHEN OLD.dispatch_started = 1 AND NEW.dispatch_started = 0
BEGIN
  SELECT RAISE(ABORT, 'NATIVE_REFUND_DISPATCH_ALREADY_STARTED');
END;
