-- PUBLIC checkout trusts an active sales_activation row, so the row itself must carry the
-- acceptance evidence the approved contract names for its kind: courses and the bundle reopen
-- on the ART-240 acceptance run, LAB on ART-243.
CREATE TRIGGER sales_activation_evidence_guard
BEFORE INSERT ON sales_activation
WHEN NOT ((NEW.product_kind IN ('ONLINE_COURSE', 'COURSE_BUNDLE') AND NEW.evidence_issue = 'ART-240')
  OR (NEW.product_kind = 'LAB' AND NEW.evidence_issue = 'ART-243'))
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_EVIDENCE_INVALID');
END;

CREATE TRIGGER sales_activation_evidence_immutable
BEFORE UPDATE OF product_kind, evidence_issue, evidence_sha256 ON sales_activation
WHEN NEW.product_kind IS NOT OLD.product_kind
  OR NEW.evidence_issue IS NOT OLD.evidence_issue
  OR NEW.evidence_sha256 IS NOT OLD.evidence_sha256
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_EVIDENCE_IMMUTABLE');
END;
