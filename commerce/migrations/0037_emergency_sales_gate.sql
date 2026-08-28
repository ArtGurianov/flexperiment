-- An operator-owned absolute emergency stop. It never participates in release
-- ownership or event replay; the two gates compose only at read/enforcement.
CREATE TABLE emergency_sales_gate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  sales_paused INTEGER NOT NULL DEFAULT 0 CHECK (sales_paused IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  paused_at TEXT,
  paused_reason TEXT,
  paused_by_admin_id TEXT,
  reopened_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO emergency_sales_gate(singleton) VALUES (1);

CREATE TABLE emergency_sales_gate_events (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('PAUSED', 'REOPENED')),
  admin_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX emergency_sales_gate_events_created_idx ON emergency_sales_gate_events(created_at);
