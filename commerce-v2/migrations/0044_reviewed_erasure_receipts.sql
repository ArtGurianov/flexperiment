-- FLEX-131. A local transaction receipt, never an authority to skip ledger replay.
CREATE TABLE reviewed_erasure_receipts (
  request_id TEXT PRIMARY KEY NOT NULL,
  entry_sha256 TEXT NOT NULL CHECK (length(entry_sha256)=64),
  recorded_at TEXT NOT NULL,
  application_mode TEXT NOT NULL CHECK (application_mode IN ('LIVE', 'RESTORE')),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json) AND json_type(counts_json)='object')
);
CREATE TRIGGER reviewed_erasure_receipts_immutable_update
BEFORE UPDATE ON reviewed_erasure_receipts
BEGIN SELECT RAISE(ABORT, 'ERASURE_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER reviewed_erasure_receipts_immutable_delete
BEFORE DELETE ON reviewed_erasure_receipts
BEGIN SELECT RAISE(ABORT, 'ERASURE_RECEIPT_IMMUTABLE'); END;
