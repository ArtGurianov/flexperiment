-- Checkout retirement and qualified-payment identity read immutable audit evidence on hot paths.
-- Nonunique indexes preserve all historical records, including evidence requiring manual review.
CREATE INDEX audit_checkout_action_subject ON audit_log(action,subject_ref);
CREATE INDEX audit_purchase_provider_identity ON audit_log(json_extract(evidence_json,'$.providerPaymentIdentity'),subject_ref)
  WHERE action='PURCHASE_QUALIFIED';
