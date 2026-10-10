-- Technical probes only. No customer, order or financial evidence.
CREATE TABLE deployment_durability (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK(environment IN ('canary','production')),
  source_commit TEXT NOT NULL CHECK(length(source_commit)=40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
