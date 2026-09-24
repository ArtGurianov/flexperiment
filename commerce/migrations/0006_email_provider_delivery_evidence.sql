-- A provider event records what the provider said about delivery, not only the
-- status word.
--
-- 2026-09-24: the certification's cancellation and refund emails stayed `sent`
-- for hours. Every stored event said `accepted` or `sent` and nothing else, so
-- nothing could tell a receiver deferring the message from a provider that
-- never tried again. Unisender reports the difference - its delivery
-- classification and the receiving SMTP server's answer - and we discarded it.
--
--   evidence_source        WEBHOOK or EVENT_DUMP. NULL on rows written before
--                          this migration.
--   delivery_status        Unisender's classification (`err_will_retry`, ...).
--   destination_response   the receiver's answer, already sanitized by the
--                          application: no addresses, URLs or opaque tokens,
--                          at most 300 characters.
--   sender_ip              the address we sent from, when reported.
--   provider_event_time    when the provider says it happened.
--
-- Nothing that identifies the recipient is stored here: Unisender's
-- delivery_info also carries their IP, user agent and location for opens, and
-- none of that is read.
--
-- Predeploy-compatible: nullable columns. The running target keeps inserting
-- rows without them.
ALTER TABLE email_provider_events ADD COLUMN evidence_source TEXT
  CHECK (evidence_source IS NULL OR evidence_source IN ('WEBHOOK', 'EVENT_DUMP'));
ALTER TABLE email_provider_events ADD COLUMN delivery_status TEXT
  CHECK (delivery_status IS NULL OR (length(delivery_status) BETWEEN 1 AND 48 AND delivery_status NOT GLOB '*[^a-z0-9_]*'));
ALTER TABLE email_provider_events ADD COLUMN destination_response TEXT
  CHECK (destination_response IS NULL OR (length(destination_response) BETWEEN 1 AND 300 AND instr(destination_response, '@') = 0));
ALTER TABLE email_provider_events ADD COLUMN sender_ip TEXT
  CHECK (sender_ip IS NULL OR length(sender_ip) BETWEEN 2 AND 45);
ALTER TABLE email_provider_events ADD COLUMN provider_event_time TEXT;
