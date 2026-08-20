ALTER TABLE provider_webhook_events ADD COLUMN observed_json TEXT NOT NULL DEFAULT '{}';
