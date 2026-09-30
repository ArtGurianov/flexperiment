CREATE TABLE course_access_starts (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  course_ref TEXT NOT NULL,
  first_lesson_ref TEXT NOT NULL,
  first_accessed_at TEXT NOT NULL,
  PRIMARY KEY(customer_id, course_ref)
);

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  order_line_id TEXT NOT NULL REFERENCES order_lines(id),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('CUSTOMER_REQUEST', 'PRODUCT_WITHDRAWN', 'OCCURRENCE_CHANGED', 'OTHER')),
  customer_note TEXT,
  policy_facts_json TEXT NOT NULL CHECK (json_valid(policy_facts_json)),
  state TEXT NOT NULL CHECK (state IN ('REQUESTED', 'APPROVED', 'REJECTED', 'EXECUTING', 'REFUNDED', 'REVIEW_REQUIRED')),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (customer_note IS NULL OR (length(trim(customer_note)) BETWEEN 1 AND 2000))
);
CREATE UNIQUE INDEX one_open_refund_request_per_line
  ON refund_requests(order_line_id)
  WHERE state IN ('REQUESTED', 'APPROVED', 'EXECUTING', 'REVIEW_REQUIRED');

CREATE TABLE refund_decisions (
  id TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('APPROVE', 'REJECT')),
  amount_kopecks INTEGER,
  policy_basis TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  CHECK (length(trim(policy_basis)) > 0),
  CHECK (length(trim(rationale)) > 0),
  CHECK (length(trim(decided_by)) > 0),
  CHECK ((outcome = 'APPROVE' AND amount_kopecks > 0)
      OR (outcome = 'REJECT' AND amount_kopecks IS NULL))
);

CREATE TABLE refund_executions (
  id TEXT PRIMARY KEY,
  refund_request_id TEXT NOT NULL UNIQUE REFERENCES refund_requests(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('READY', 'PROCESSING', 'SUCCEEDED', 'REVIEW_REQUIRED')),
  provider_execution_id TEXT,
  support_reference TEXT,
  observed_projection_json TEXT CHECK (observed_projection_json IS NULL OR json_valid(observed_projection_json)),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pending_refund_executions
  ON refund_executions(updated_at)
  WHERE state IN ('READY', 'PROCESSING');
