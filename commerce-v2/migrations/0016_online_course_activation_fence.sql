-- ONLINE_COURSE activation fence (Linear ART-240 / ART-242, plan v2 F1).
--
-- ART-240 is the production acceptance of ONE recorded ONLINE_COURSE: one line, quantity 1, full-only
-- refund. It proves nothing about COURSE_BUNDLE (an ALL_COURSES grant over courses published later,
-- line-level revocation across a bundle), so its evidence may no longer open bundle sales. A bundle
-- needs an acceptance of its own; until one exists, no evidence qualifies it.
--
-- 1. An activation is inserted only with the evidence named for its kind: ONLINE_COURSE on ART-240,
--    LAB on ART-243, COURSE_BUNDLE on nothing.
-- 2. A COURSE_BUNDLE activation still active from before is revoked here, with its reason. The row
--    stays: it is history, not an error to erase. Entitlements already granted are untouched.
-- 3. A revoked activation stays revoked, whatever its kind: un-revoking a row would reopen sales on
--    evidence someone already withdrew. A new activation is a new row, under rule 1.

DROP TRIGGER sales_activation_evidence_guard;
CREATE TRIGGER sales_activation_evidence_guard
BEFORE INSERT ON sales_activation
WHEN NOT ((NEW.product_kind = 'ONLINE_COURSE' AND NEW.evidence_issue = 'ART-240')
  OR (NEW.product_kind = 'LAB' AND NEW.evidence_issue = 'ART-243'))
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_EVIDENCE_INVALID');
END;

UPDATE sales_activation
   SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       revocation_reason = 'ONLINE_COURSE_FENCE: ART-240 evidence does not qualify COURSE_BUNDLE (migration 0016)'
 WHERE product_kind = 'COURSE_BUNDLE' AND revoked_at IS NULL;

CREATE TRIGGER sales_activation_revocation_final
BEFORE UPDATE OF revoked_at, revocation_reason ON sales_activation
WHEN OLD.revoked_at IS NOT NULL
  AND (NEW.revoked_at IS NOT OLD.revoked_at OR NEW.revocation_reason IS NOT OLD.revocation_reason)
BEGIN
  SELECT RAISE(ABORT, 'SALES_ACTIVATION_REVOCATION_FINAL');
END;
