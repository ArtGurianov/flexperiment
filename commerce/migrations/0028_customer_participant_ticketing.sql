-- New orders snapshot contracting Customer and attending Participant separately.
-- All columns are nullable so pre-existing customer=self orders remain readable.
ALTER TABLE orders ADD COLUMN customer_adult_confirmed_at TEXT;
ALTER TABLE orders ADD COLUMN customer_acceptance_ip TEXT;
ALTER TABLE orders ADD COLUMN customer_acceptance_user_agent TEXT;
ALTER TABLE orders ADD COLUMN participant_name TEXT;
ALTER TABLE orders ADD COLUMN participant_date_of_birth TEXT;
ALTER TABLE orders ADD COLUMN participant_age_at_occurrence INTEGER CHECK (participant_age_at_occurrence >= 0);
ALTER TABLE orders ADD COLUMN participant_is_minor INTEGER CHECK (participant_is_minor IN (0, 1));
ALTER TABLE orders ADD COLUMN participant_requires_adult_accompaniment INTEGER CHECK (participant_requires_adult_accompaniment IN (0, 1));
ALTER TABLE orders ADD COLUMN participant_is_customer INTEGER CHECK (participant_is_customer IN (0, 1));
ALTER TABLE orders ADD COLUMN minor_legal_representative_confirmed_at TEXT;
ALTER TABLE orders ADD COLUMN minor_legal_representative_confirmation_text TEXT;
ALTER TABLE orders ADD COLUMN under_14_accompaniment_confirmed_at TEXT;
ALTER TABLE orders ADD COLUMN under_14_accompaniment_confirmation_text TEXT;
