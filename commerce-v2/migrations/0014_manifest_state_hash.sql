-- The content hash covers the manifest's operation list, which shrinks as the platform
-- acknowledges operations while the committed course state and its version stay put. The state
-- hash covers only that committed state, so a re-push after acknowledgement is recognised as the
-- same version (a lease-renewing no-op) instead of being rejected as same-version drift.
ALTER TABLE catalog_course_projection ADD COLUMN state_hash TEXT CHECK (state_hash IS NULL OR length(state_hash) = 64);
