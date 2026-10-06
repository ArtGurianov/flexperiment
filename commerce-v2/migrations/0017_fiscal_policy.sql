-- Product-specific fiscal authority (Linear ART-233, plan v2 F2).
--
-- What a receipt says about a line — its item name, tax system, VAT, payment method and payment
-- object — was chosen by the rail's global configuration (REFREF_RECEIPT_PAYMENT_METHOD and constants)
-- and the item name was the product ref. It is now a versioned policy per offer, qualified on its own
-- legal basis, and frozen into each order line's fiscal snapshot at checkout.
--
--   DRAFT      written, not yet backed by the offer and refund terms (ART-231) and the counsel's
--              framing of the service (ART-234). Sells nothing.
--   QUALIFIED  the one policy checkout uses for its offer. At most one per offer.
--   RETIRED    no longer used for new checkouts. Orders already made keep the snapshot they froze.
--
-- A policy's content never changes: a different receipt is a new version. Qualification names the
-- legal basis — held here, not only by the Control Room command — and is final. A policy belongs to one offer of one product kind and is qualified only
-- against an offer of that kind that exists: an ONLINE_COURSE qualification says nothing about a LAB
-- or the bundle, and a policy cannot be qualified for an offer no release has published.
-- The provenance (policy id and version) is kept on the order line, beside the snapshot, and is not
-- part of the commercial legal hash.

CREATE TABLE fiscal_policy_versions (
  id TEXT PRIMARY KEY,
  offer_ref TEXT NOT NULL,
  product_kind TEXT NOT NULL CHECK (product_kind IN ('ONLINE_COURSE', 'COURSE_BUNDLE', 'LAB')),
  version INTEGER NOT NULL CHECK (version >= 1),
  item_name TEXT NOT NULL CHECK (length(item_name) BETWEEN 1 AND 128 AND item_name = trim(item_name)),
  tax_system TEXT NOT NULL CHECK (tax_system IN ('USN_INCOME', 'USN_INCOME_OUTCOME')),
  vat_code TEXT NOT NULL CHECK (vat_code = 'NONE'),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('FULL_PREPAYMENT', 'PREPAYMENT', 'ADVANCE', 'FULL_PAYMENT')),
  payment_object TEXT NOT NULL CHECK (payment_object = 'SERVICE'),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'QUALIFIED', 'RETIRED')),
  legal_basis_json TEXT CHECK (legal_basis_json IS NULL OR json_valid(legal_basis_json)),
  qualified_by TEXT,
  qualified_at TEXT,
  retired_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (offer_ref, version),
  CHECK ((legal_basis_json IS NULL) = (qualified_at IS NULL) AND (qualified_at IS NULL) = (qualified_by IS NULL)),
  CHECK (status <> 'QUALIFIED' OR qualified_at IS NOT NULL),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_qualified_fiscal_policy_per_offer ON fiscal_policy_versions(offer_ref) WHERE status = 'QUALIFIED';

CREATE TRIGGER fiscal_policy_content_immutable
BEFORE UPDATE OF id, offer_ref, product_kind, version, item_name, tax_system, vat_code, payment_method, payment_object,
  created_by, created_at ON fiscal_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_IMMUTABLE');
END;

-- Born a draft: qualification is a decision made after, never a row written already qualified.
CREATE TRIGGER fiscal_policy_born_draft
BEFORE INSERT ON fiscal_policy_versions
WHEN NEW.status <> 'DRAFT' OR NEW.qualified_at IS NOT NULL OR NEW.retired_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_BORN_DRAFT');
END;

-- DRAFT → QUALIFIED, DRAFT → RETIRED, QUALIFIED → RETIRED; the qualification, once made, is final.
CREATE TRIGGER fiscal_policy_status_transition
BEFORE UPDATE OF status, legal_basis_json, qualified_by, qualified_at, retired_at ON fiscal_policy_versions
WHEN NOT (
     (OLD.status = 'DRAFT' AND NEW.status IN ('QUALIFIED', 'RETIRED'))
  OR (OLD.status = 'QUALIFIED' AND NEW.status = 'RETIRED'))
  OR (OLD.qualified_at IS NOT NULL AND (NEW.qualified_at IS NOT OLD.qualified_at
      OR NEW.qualified_by IS NOT OLD.qualified_by OR NEW.legal_basis_json IS NOT OLD.legal_basis_json))
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_TRANSITION_INVALID');
END;

-- Qualification is the legal basis, whoever writes it: the offer and refund terms (ART-231) and the
-- counsel's framing (ART-234), each named, the sha256 of the evidence reviewed, and who decided.
CREATE TRIGGER fiscal_policy_qualification_basis
BEFORE UPDATE OF status ON fiscal_policy_versions
-- Every term is strictly true or false (IS, coalesce): a NULL from a missing key must refuse, not pass.
WHEN NEW.status = 'QUALIFIED' AND NOT (
      coalesce(length(trim(NEW.qualified_by)), 0) > 0
  AND coalesce(json_valid(NEW.legal_basis_json), 0) = 1
  AND json_type(NEW.legal_basis_json, '$.offerTermsRef') IS 'text'
  AND coalesce(length(trim(json_extract(NEW.legal_basis_json, '$.offerTermsRef'))), 0) > 0
  AND json_type(NEW.legal_basis_json, '$.counselRef') IS 'text'
  AND coalesce(length(trim(json_extract(NEW.legal_basis_json, '$.counselRef'))), 0) > 0
  AND json_type(NEW.legal_basis_json, '$.evidenceSha256') IS 'text'
  AND coalesce(length(json_extract(NEW.legal_basis_json, '$.evidenceSha256')), 0) = 64
  AND coalesce(json_extract(NEW.legal_basis_json, '$.evidenceSha256') NOT GLOB '*[^0-9a-f]*', 0) = 1)
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_LEGAL_BASIS_REQUIRED');
END;

-- Qualified only against a published offer of the policy's own kind.
CREATE TRIGGER fiscal_policy_qualified_for_its_offer
BEFORE UPDATE OF status ON fiscal_policy_versions
WHEN NEW.status = 'QUALIFIED' AND NOT EXISTS (
  SELECT 1 FROM offers offer JOIN products product ON product.id = offer.product_id
   WHERE offer.offer_ref = NEW.offer_ref AND product.kind = NEW.product_kind)
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_OFFER_MISMATCH');
END;

CREATE TRIGGER fiscal_policy_no_delete
BEFORE DELETE ON fiscal_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'FISCAL_POLICY_APPEND_ONLY');
END;

ALTER TABLE order_lines ADD COLUMN fiscal_policy_id TEXT REFERENCES fiscal_policy_versions(id);
