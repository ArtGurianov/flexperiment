-- ART-234: owner-approved legal evidence replaces mandatory external counsel.
-- Append only: preserve every existing fiscal policy / raw counselRef / order line.
CREATE TABLE owner_legal_decisions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  fiscal_policy_id TEXT NOT NULL REFERENCES fiscal_policy_versions(id),
  product_ref TEXT NOT NULL,
  offer_ref TEXT NOT NULL,
  legal_release_id TEXT NOT NULL REFERENCES legal_releases(id),
  legal_release_version TEXT NOT NULL CHECK (length(trim(legal_release_version))>0),
  legal_manifest_json TEXT NOT NULL CHECK (json_valid(legal_manifest_json)),
  offer_terms_ref TEXT NOT NULL CHECK (length(trim(offer_terms_ref)) > 0),
  offer_terms_sha256 TEXT NOT NULL CHECK (length(offer_terms_sha256)=64 AND offer_terms_sha256 NOT GLOB '*[^0-9a-f]*'),
  refund_terms_ref TEXT NOT NULL CHECK (length(trim(refund_terms_ref)) > 0),
  refund_terms_sha256 TEXT NOT NULL CHECK (length(refund_terms_sha256)=64 AND refund_terms_sha256 NOT GLOB '*[^0-9a-f]*'),
  norms_json TEXT NOT NULL CHECK (json_valid(norms_json) AND json_type(norms_json)='array' AND json_array_length(norms_json)>0),
  facts TEXT NOT NULL CHECK (length(trim(facts)) > 0),
  reasoning TEXT NOT NULL CHECK (length(trim(reasoning)) > 0),
  risk_assessment TEXT NOT NULL CHECK (length(trim(risk_assessment)) > 0),
  approval_ref TEXT NOT NULL CHECK (length(trim(approval_ref)) > 0),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
  decided_by TEXT NOT NULL CHECK (length(trim(decided_by)) > 0),
  decided_at TEXT NOT NULL CHECK (julianday(decided_at) IS NOT NULL),
  recorded_by TEXT NOT NULL CHECK (length(trim(recorded_by)) > 0),
  recorded_at TEXT NOT NULL CHECK (julianday(recorded_at) IS NOT NULL AND julianday(decided_at)<=julianday(recorded_at)),
  UNIQUE(offer_ref,version)
);
CREATE TRIGGER owner_legal_decision_binding
BEFORE INSERT ON owner_legal_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM fiscal_policy_versions f JOIN offers o ON o.offer_ref=f.offer_ref
    JOIN products p ON p.id=o.product_id JOIN legal_releases l ON l.id=NEW.legal_release_id
  WHERE f.id=NEW.fiscal_policy_id AND f.status='DRAFT'
    AND f.offer_ref=NEW.offer_ref AND p.product_ref=NEW.product_ref AND p.kind=f.product_kind
    AND l.storefront=CASE WHEN p.kind='LAB' THEN 'LAB' ELSE 'COURSES' END
    AND l.active=1 AND l.version=NEW.legal_release_version AND l.manifest_json=NEW.legal_manifest_json
    AND NOT EXISTS (SELECT 1 FROM json_each(l.manifest_json,'$.documents') doc
      WHERE (json_extract(doc.value,'$.kind')='course_offer' AND
        (json_extract(doc.value,'$.url') IS NOT NEW.offer_terms_ref OR json_extract(doc.value,'$.sha256') IS NOT NEW.offer_terms_sha256))
      OR (json_extract(doc.value,'$.kind')='refund_terms' AND
        (json_extract(doc.value,'$.url') IS NOT NEW.refund_terms_ref OR json_extract(doc.value,'$.sha256') IS NOT NEW.refund_terms_sha256)))
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.norms_json) n WHERE n.type<>'object'
    OR json_type(n.value,'$.reference') IS NOT 'text'
    OR coalesce(length(trim(json_extract(n.value,'$.reference'))),0)=0
    OR json_type(n.value,'$.url') IS NOT 'text'
    OR coalesce(json_extract(n.value,'$.url') LIKE 'https://_%',0)=0
) OR NEW.recorded_by<>NEW.decided_by
BEGIN SELECT RAISE(ABORT,'OWNER_LEGAL_DECISION_INVALID'); END;
CREATE TRIGGER owner_legal_decision_no_update BEFORE UPDATE ON owner_legal_decisions
BEGIN SELECT RAISE(ABORT,'OWNER_LEGAL_DECISION_IMMUTABLE'); END;
CREATE TRIGGER owner_legal_decision_no_delete BEFORE DELETE ON owner_legal_decisions
BEGIN SELECT RAISE(ABORT,'OWNER_LEGAL_DECISION_APPEND_ONLY'); END;

-- Only new qualification writes use this authority. Historical rows remain untouched,
-- readable and retirable under the unchanged finality / order snapshot triggers.
DROP TRIGGER fiscal_policy_qualification_basis;
CREATE TRIGGER fiscal_policy_qualification_basis
BEFORE UPDATE OF status ON fiscal_policy_versions
WHEN NEW.status='QUALIFIED' AND NOT EXISTS (
  SELECT 1 FROM owner_legal_decisions d JOIN legal_releases l ON l.id=d.legal_release_id
    JOIN offers o ON o.offer_ref=d.offer_ref JOIN products p ON p.id=o.product_id
  WHERE json_extract(NEW.legal_basis_json,'$.type')='OWNER_LEGAL_DECISION'
    AND json_extract(NEW.legal_basis_json,'$.ownerLegalDecisionId')=d.id
    AND json_extract(NEW.legal_basis_json,'$.offerTermsRef')=d.offer_terms_ref
    AND json_extract(NEW.legal_basis_json,'$.evidenceSha256')=d.evidence_sha256
    AND d.fiscal_policy_id=NEW.id AND d.offer_ref=NEW.offer_ref AND d.product_ref=p.product_ref
    AND p.kind=NEW.product_kind AND NEW.qualified_by=d.decided_by
    AND l.active=1 AND l.version=d.legal_release_version AND l.manifest_json=d.legal_manifest_json
    AND julianday(NEW.qualified_at)>=julianday(d.recorded_at)
)
BEGIN SELECT RAISE(ABORT,'FISCAL_POLICY_LEGAL_BASIS_REQUIRED'); END;

