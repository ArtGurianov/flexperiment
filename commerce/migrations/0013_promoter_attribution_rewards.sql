-- Preserve the evidence that formed a quote. Historical orders stay untouched;
-- checkout revalidates eligibility but freezes these quoted commercial terms.
ALTER TABLE quotes ADD COLUMN referral_slug TEXT;
ALTER TABLE quotes ADD COLUMN promo_code_snapshot TEXT;
ALTER TABLE quotes ADD COLUMN discount_type_snapshot TEXT CHECK (discount_type_snapshot IN ('NONE', 'PERCENT', 'FIXED'));
ALTER TABLE quotes ADD COLUMN discount_value_snapshot INTEGER;

-- Each adjustment is a durable, idempotent accounting event. Existing rows
-- predate the semantic key and intentionally remain valid historical evidence.
ALTER TABLE reward_adjustments ADD COLUMN semantic_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS reward_adjustments_semantic_key_unique
  ON reward_adjustments(semantic_key)
  WHERE semantic_key IS NOT NULL;
