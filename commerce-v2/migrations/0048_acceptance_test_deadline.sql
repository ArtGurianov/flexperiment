ALTER TABLE offers ADD COLUMN acceptance_expires_at TEXT;

-- Existing test offers have no qualified deadline. Close them and detach the
-- old list; a new test must be configured with an explicit deadline.
UPDATE products SET version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id IN (SELECT product_id FROM offers
    WHERE sale_mode='ACCEPTANCE_ONLY' OR acceptance_allowlist_json<>'[]');
UPDATE offers SET sale_mode=CASE sale_mode WHEN 'ACCEPTANCE_ONLY' THEN 'CLOSED' ELSE sale_mode END,
    acceptance_allowlist_json='[]', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE sale_mode='ACCEPTANCE_ONLY' OR acceptance_allowlist_json<>'[]';
