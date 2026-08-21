ALTER TABLE refund_obligation_events RENAME TO refund_obligation_events_legacy;
ALTER TABLE refund_obligations RENAME TO refund_obligations_legacy;

CREATE TABLE refund_obligations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  initial_source TEXT NOT NULL CHECK (initial_source IN ('OCCURRENCE_CANCELLED', 'LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE', 'CUSTOMER_CANCELLATION_PARTIAL', 'LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION', 'LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT')),
  target_refunded_amount_kopecks INTEGER NOT NULL CHECK (target_refunded_amount_kopecks >= 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULFILLING', 'FULFILLED', 'REVIEW_REQUIRED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at TEXT
);

INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status, created_at, fulfilled_at)
  SELECT id, payment_id, initial_source, target_refunded_amount_kopecks, status, created_at, fulfilled_at
  FROM refund_obligations_legacy;

CREATE TABLE refund_obligation_events (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES refund_obligations(id),
  source TEXT NOT NULL,
  provider_event_id TEXT,
  admin_action_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO refund_obligation_events(id, obligation_id, source, provider_event_id, admin_action_id, created_at)
  SELECT id, obligation_id, source, provider_event_id, admin_action_id, created_at
  FROM refund_obligation_events_legacy;

DROP TABLE refund_obligation_events_legacy;
DROP TABLE refund_obligations_legacy;

CREATE TABLE reservation_abandonments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ABANDONED', 'LATE_PAYMENT_REVIEW_REQUIRED', 'LATE_PAYMENT_REFUNDED')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);
