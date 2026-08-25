-- New checkout rows store a Customer declaration made at booking time.
-- Existing DOB-era rows remain untouched and keep their occurrence-date evidence.
ALTER TABLE orders ADD COLUMN participant_age_band TEXT CHECK (participant_age_band IN ('ADULT', 'MINOR_14_17', 'MINOR_UNDER_14'));
