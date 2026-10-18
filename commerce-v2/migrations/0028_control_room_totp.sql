-- ART-31: the Control Room second factor. One row per admin; the seed only encrypted.
-- last_accepted_step makes every accepted code single-use. No recovery codes: reset is an
-- owner command over SSH.
CREATE TABLE control_room_totp (
  admin_id TEXT PRIMARY KEY,
  seed_ciphertext TEXT NOT NULL CHECK (seed_ciphertext GLOB 'v1.*'),
  last_accepted_step INTEGER CHECK (last_accepted_step IS NULL OR last_accepted_step >= 0),
  enrolled_at TEXT NOT NULL,
  confirmed_at TEXT,
  CHECK (confirmed_at IS NULL OR last_accepted_step IS NOT NULL)
);
