-- Capabilities are order scoped, even when an unverified email names an existing customer.
CREATE TABLE lab_guest_access (
  order_public_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
  initial_email_attempted_at TEXT,
  acceptance_json TEXT CHECK(acceptance_json IS NULL OR json_valid(acceptance_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE lab_tickets (
  id TEXT PRIMARY KEY,
  order_line_id TEXT NOT NULL UNIQUE REFERENCES order_lines(id),
  qr_sha256 TEXT UNIQUE CHECK(qr_sha256 IS NULL OR length(qr_sha256)=64),
  issued_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  CHECK ((used_at IS NULL) = (used_by IS NULL))
);
CREATE TRIGGER lab_ticket_use_irreversible BEFORE UPDATE ON lab_tickets
WHEN OLD.used_at IS NOT NULL AND (NEW.used_at IS NOT OLD.used_at OR NEW.used_by IS NOT OLD.used_by)
BEGIN SELECT RAISE(ABORT,'LAB_TICKET_USE_IRREVERSIBLE'); END;
CREATE TRIGGER lab_ticket_used_no_delete BEFORE DELETE ON lab_tickets WHEN OLD.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'LAB_TICKET_USE_IRREVERSIBLE'); END;
CREATE TABLE lab_ticket_recoveries (
  token_sha256 TEXT PRIMARY KEY CHECK(length(token_sha256)=64),
  order_public_id TEXT NOT NULL REFERENCES lab_guest_access(order_public_id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  replacement_sha256 TEXT
);
CREATE TABLE lab_guest_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts>0)
);
