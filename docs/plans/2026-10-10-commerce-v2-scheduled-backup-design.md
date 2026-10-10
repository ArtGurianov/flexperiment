# ART-166 / ART-41 — scheduled Commerce V2 recovery

## Decision

Reuse the existing SQLite online-backup + age primitive and the existing
Cloud.ru recovery recipient/S3 credential files. Add a read-only backup CLI
that works in both foundation and normal application mode, and separate
systemd instances for canary and production. Do not attach V2 to the legacy
runtime-secret backup: that job has a different payload and lifecycle.

Alternatives considered: copying the live SQLite file loses uncheckpointed
WAL; extending the foundation CLI keeps normal-mode recovery dependent on a
diagnostic mode; a new backup service adds an unnecessary deployment.

## Contract

- Open the existing fixed database read-only; never migrate, seed or write a
  marker. Verify V2 lineage/schema and baked build identity before backup.
- Encrypt the online snapshot before it leaves its application's volume.
- Resolve exactly one container belonging to the configured V2 app UUID.
  Require separate data/backup mounts and the correct environment/path.
- Use separate `flexperiment/commerce-v2/{canary,production}/sqlite` object
  namespaces, with encrypted ciphertext only. Reuse the Russia-based Cloud.ru
  storage and public recovery recipient, never put the private age key on VPS.
- Upload and independently read back SHA-256 before retention or success.
  Keep 7 local / 100 remote exact-pattern artifacts per environment, leaving
  unrelated files and the other environment untouched.
- Run every six hours. An error is a failed systemd unit and a fixed-enum
  status; `check` refuses a failure or last verified upload older than eight
  hours. This is backup monitoring, not a claim that an external alert is wired.
- A verified upload is not a restore proof. Before F9, download the actual
  uploaded ciphertext, decrypt on the owner Mac in Russia, and compare
  quick_check, lineage, migration ledger and current catalogue/identity facts.
  Escrow authentication/outbox key generations independently; SQLite alone
  cannot recover encrypted outbox data or signed sessions.

## Boundaries

No application restart, deploy ref changes, V1 runtime modification, public routing,
Refref writes or payment activation. New host code/timers are installed only
after review/merge and an admitted runtime containing the backup CLI. Existing
qualified volumes are retained (ART-236).

One adjacent legacy backup-only correction is included: its numeric suffix
selector does not match the actual frozen V1 container suffix `20261008T043419`.
Accept both historical numeric and current timestamp suffixes, requiring
exactly one Commerce candidate (never worker/V2). This does not change V1
runtime, credentials, database or routes; installation awaits the same review.

Tests cover actual WAL + age restore, read-only opening, failure cleanup,
namespace isolation, SHA read-back failure, exact-name retention, failure and
freshness checks, and systemd wiring. CI runs the host contract explicitly.
