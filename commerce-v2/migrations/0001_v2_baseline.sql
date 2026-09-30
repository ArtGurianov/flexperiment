CREATE TABLE schema_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage TEXT NOT NULL CHECK (lineage = 'flexperiment-v2'),
  baseline_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER schema_identity_immutable_update
BEFORE UPDATE ON schema_identity BEGIN
  SELECT RAISE(ABORT, 'SCHEMA_IDENTITY_IMMUTABLE');
END;

CREATE TRIGGER schema_identity_immutable_delete
BEFORE DELETE ON schema_identity BEGIN
  SELECT RAISE(ABORT, 'SCHEMA_IDENTITY_IMMUTABLE');
END;

CREATE TABLE launch_seed (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  catalogue_sha256 TEXT NOT NULL CHECK (length(catalogue_sha256) = 64),
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  image TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "session" (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_id ON "session"(user_id);

CREATE TABLE account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, account_id)
);
CREATE INDEX account_user_id ON account(user_id);

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX verification_identifier ON verification(identifier);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auth_user_id TEXT UNIQUE REFERENCES "user"(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE account_consents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('PERSONAL_DATA', 'ACCOUNT_TERMS')),
  document_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL,
  UNIQUE(customer_id, kind, document_version)
);

CREATE TABLE auth_email_outbox (
  id TEXT PRIMARY KEY,
  recipient_normalized TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'MAGIC_LINK'),
  encrypted_payload TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_email_outbox_pending ON auth_email_outbox(state, created_at);

CREATE TABLE cities (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE legal_releases (
  id TEXT PRIMARY KEY,
  storefront TEXT NOT NULL CHECK (storefront IN ('COURSES', 'LAB')),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  effective_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(storefront, version)
);
CREATE UNIQUE INDEX one_active_legal_release_per_storefront
  ON legal_releases(storefront) WHERE active = 1;

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  product_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ONLINE_COURSE', 'COURSE_BUNDLE', 'LAB')),
  access_model TEXT NOT NULL CHECK (access_model IN ('FREE', 'PAID')),
  course_ref TEXT,
  withdrawn_at TEXT,
  withdrawn_reason TEXT,
  withdrawn_terms_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((kind = 'ONLINE_COURSE' AND course_ref IS NOT NULL) OR (kind <> 'ONLINE_COURSE' AND course_ref IS NULL)),
  CHECK ((withdrawn_at IS NULL AND withdrawn_reason IS NULL AND withdrawn_terms_ref IS NULL)
      OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL AND withdrawn_terms_ref IS NOT NULL))
);
CREATE UNIQUE INDEX one_product_per_course ON products(course_ref) WHERE course_ref IS NOT NULL;

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  offer_ref TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL REFERENCES products(id),
  price_kopecks INTEGER NOT NULL CHECK (price_kopecks >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  sale_mode TEXT NOT NULL DEFAULT 'CLOSED' CHECK (sale_mode IN ('CLOSED', 'ACCEPTANCE_ONLY', 'PUBLIC')),
  acceptance_allowlist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(acceptance_allowlist_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((offer_ref = 'bundle:all-courses') OR (offer_ref GLOB 'course:*') OR (offer_ref GLOB 'lab:*'))
);

CREATE TABLE sales_activation (
  id TEXT PRIMARY KEY,
  product_kind TEXT NOT NULL CHECK (product_kind IN ('ONLINE_COURSE', 'COURSE_BUNDLE', 'LAB')),
  evidence_issue TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  activated_by TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE UNIQUE INDEX one_active_sales_activation_per_kind
  ON sales_activation(product_kind) WHERE revoked_at IS NULL;

CREATE TABLE lab_occurrences (
  id TEXT PRIMARY KEY,
  occurrence_ref TEXT NOT NULL UNIQUE,
  city_id TEXT NOT NULL REFERENCES cities(id),
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity >= 0),
  sales_status TEXT NOT NULL DEFAULT 'CLOSED' CHECK (sales_status IN ('CLOSED', 'ACCEPTANCE_ONLY', 'PUBLIC')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at > starts_at)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'PAYMENT_PENDING', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED', 'REVIEW_REQUIRED')),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  total_kopecks INTEGER NOT NULL CHECK (total_kopecks >= 0),
  checkout_snapshot_json TEXT NOT NULL CHECK (json_valid(checkout_snapshot_json)),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  offer_ref_snapshot TEXT NOT NULL,
  title_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity = 1),
  unit_amount_kopecks INTEGER NOT NULL CHECK (unit_amount_kopecks >= 0),
  legal_terms_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(order_id, product_id)
);

CREATE TABLE checkout_attempts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_payload_json TEXT NOT NULL CHECK (json_valid(request_payload_json)),
  state TEXT NOT NULL CHECK (state IN ('CREATING', 'CREATE_UNKNOWN', 'PENDING', 'CUSTOMER_ACTION_REQUIRED', 'PAID', 'DECLINED', 'EXPIRED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REVIEW_REQUIRED')),
  refref_attempt_id TEXT UNIQUE,
  refref_resolution_id TEXT,
  refref_snapshot_hash TEXT,
  refref_payment_session_id TEXT,
  checkout_url TEXT,
  observed_payment_projection_json TEXT CHECK (observed_payment_projection_json IS NULL OR json_valid(observed_payment_projection_json)),
  fulfillment_acknowledged_at TEXT,
  last_reconciled_at TEXT,
  outcome_unknown_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE course_entitlements (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  scope TEXT NOT NULL CHECK (scope IN ('COURSE', 'ALL_COURSES')),
  course_ref TEXT,
  source_order_line_id TEXT NOT NULL UNIQUE REFERENCES order_lines(id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK ((scope = 'COURSE' AND course_ref IS NOT NULL) OR (scope = 'ALL_COURSES' AND course_ref IS NULL)),
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX active_entitlements_by_customer ON course_entitlements(customer_id, scope, course_ref) WHERE revoked_at IS NULL;

CREATE TABLE catalog_course_projection (
  course_ref TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  visibility TEXT NOT NULL CHECK (visibility IN ('LISTED', 'UNLISTED')),
  last_reconciled_at TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE catalog_section_projection (
  section_ref TEXT PRIMARY KEY,
  course_ref TEXT NOT NULL REFERENCES catalog_course_projection(course_ref) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('LISTED', 'UNLISTED')),
  position INTEGER NOT NULL CHECK (position >= 0)
);

CREATE TABLE catalog_lesson_projection (
  lesson_ref TEXT PRIMARY KEY,
  course_ref TEXT NOT NULL REFERENCES catalog_course_projection(course_ref) ON DELETE CASCADE,
  section_ref TEXT NOT NULL REFERENCES catalog_section_projection(section_ref) ON DELETE CASCADE,
  ever_published INTEGER NOT NULL CHECK (ever_published IN (0, 1)),
  visibility TEXT NOT NULL CHECK (visibility IN ('LISTED', 'UNLISTED')),
  free_preview INTEGER NOT NULL CHECK (free_preview IN (0, 1)),
  withdrawn_at TEXT,
  withdrawn_reason TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  CHECK ((withdrawn_at IS NULL AND withdrawn_reason IS NULL) OR (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL))
);

CREATE TABLE access_overrides (
  operation_id TEXT PRIMARY KEY,
  course_ref TEXT NOT NULL,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('COURSE', 'SECTION', 'LESSON')),
  scope_ref TEXT NOT NULL,
  expected_kind TEXT NOT NULL CHECK (expected_kind IN ('EFFECTIVE_VISIBILITY', 'FREE_PREVIEW')),
  expected_value TEXT NOT NULL CHECK (expected_value IN ('UNLISTED', 'FALSE')),
  effect TEXT NOT NULL DEFAULT 'DENY_NON_ENTITLED' CHECK (effect = 'DENY_NON_ENTITLED'),
  committed_version INTEGER CHECK (committed_version IS NULL OR committed_version >= 1),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'FINALIZED', 'SUPERSEDED', 'RELEASED_ROLLED_BACK')),
  attention_reason TEXT,
  orphaned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deadline_at TEXT NOT NULL,
  platform_epoch TEXT NOT NULL,
  resolved_at TEXT,
  resolving_manifest_version INTEGER,
  resolving_manifest_hash TEXT,
  resolution_evidence_json TEXT CHECK (resolution_evidence_json IS NULL OR json_valid(resolution_evidence_json)),
  CHECK ((state = 'PENDING' AND resolved_at IS NULL)
      OR (state IN ('FINALIZED', 'SUPERSEDED') AND resolved_at IS NOT NULL AND resolving_manifest_version IS NOT NULL AND resolving_manifest_hash IS NOT NULL)
      OR (state = 'RELEASED_ROLLED_BACK' AND resolved_at IS NOT NULL AND resolution_evidence_json IS NOT NULL))
);
CREATE INDEX pending_access_overrides ON access_overrides(course_ref, created_at) WHERE state = 'PENDING';

CREATE TABLE lesson_video_bindings (
  lesson_ref TEXT PRIMARY KEY,
  active_video_id TEXT NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  bound_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE video_upload_sessions (
  id TEXT PRIMARY KEY,
  lesson_ref TEXT NOT NULL,
  video_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('UPLOADING', 'PROCESSING', 'READY', 'FAILED')),
  uploader_endpoint TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status = 'FAILED' AND error_code IS NOT NULL) OR (status <> 'FAILED' AND error_code IS NULL))
);

CREATE TABLE kinescope_webhook_events (
  content_key TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  observed_status TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lesson_resume_positions (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lesson_ref TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  client_seq INTEGER NOT NULL CHECK (client_seq >= 0),
  client_ts TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(customer_id, lesson_ref)
);

CREATE TABLE playback_grant_rate_limits (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  PRIMARY KEY(customer_id, window_start)
);

CREATE TABLE marketing_consents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  document_version TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX marketing_consents_customer_time ON marketing_consents(customer_id, recorded_at DESC);

CREATE TABLE email_suppressions (
  email_normalized TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT
);

CREATE TABLE notification_campaigns (
  id TEXT PRIMARY KEY,
  course_ref TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL CHECK (state IN ('DRAFT', 'CONFIRMED', 'DISPATCHING', 'COMPLETED', 'FAILED')),
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((state = 'DRAFT' AND confirmed_at IS NULL AND confirmed_by IS NULL)
      OR (state <> 'DRAFT' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);

CREATE TABLE notification_campaign_recipients (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENT', 'SKIPPED_NO_CONSENT', 'SKIPPED_SUPPRESSED', 'FAILED')),
  last_error TEXT,
  sent_at TEXT,
  UNIQUE(campaign_id, customer_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_identity(singleton, lineage, baseline_version)
VALUES (1, 'flexperiment-v2', '0001_v2_baseline');
