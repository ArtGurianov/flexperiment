-- Preserve only controlled diagnostic classes/codes for a failed provider
-- create or read. Request payloads, headers, JWTs and provider bodies are
-- deliberately never persisted here.
ALTER TABLE payments ADD COLUMN provider_error_class TEXT;
ALTER TABLE payments ADD COLUMN provider_error_code TEXT;
