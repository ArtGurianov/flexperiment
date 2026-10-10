# ART-166 / ART-41 — Commerce V2 regular backups

Status: engineering candidate. No timers installed by this PR.

## Admission / installation

Keep the already qualified data and backup volumes; do not recreate them.
Install only after this PR is reviewed/merged and both admitted images contain
`commerce-v2/src/backup-cli.ts`. The CLI works in foundation and normal mode,
opens the existing database read-only and cannot bootstrap an empty database.
Installing a timer before the CLI is deployed will fail, not create a database.

Owner prerequisites:

- The owner host's existing Python 3.10 is supported. Local SHA256 is computed
  incrementally in 1 MiB chunks using `hashlib.sha256`, not Python 3.11-only
  `hashlib.file_digest`. No host Python upgrade or checksum bypass is required.
  The CI-wired regression removes that newer API and checks empty, small and
  multi-chunk files; restoring the old implementation makes it fail.

- `/root/flexperiment-v2-owner/deploy-config.json`: existing separate app UUIDs,
  root-owned `0600` (canary and production, never V1).
- `/etc/flexperiment/recovery/age-recipient.txt`: existing public recipient
  matching the owner Mac private key and each app's backup recipient.
- Existing `/etc/flexperiment/recovery/s3-access-key` and `s3-secret-key`:
  root-owned `0600`, never print their contents or copy them into app images.
- Each app retains distinct writable mounts at `/var/lib/flexperiment-v2` and
  `/var/lib/flexperiment-v2-backups`, baked `/app/.identity/identity.json` and
  the fixed database path `/var/lib/flexperiment-v2/commerce.sqlite`.

From a checkout of the admitted exact merge SHA, on the owner VPS:

```sh
install -d -m 0755 /usr/local/lib/flexperiment-v2
install -m 0644 scripts/v2/scheduled-backup.py /usr/local/lib/flexperiment-v2/scheduled-backup.py
install -m 0644 deploy/host/flexperiment-commerce-v2-backup@.service /etc/systemd/system/
install -m 0644 deploy/host/flexperiment-commerce-v2-backup@.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start flexperiment-commerce-v2-backup@canary.service
systemctl start flexperiment-commerce-v2-backup@production.service
python3 /usr/local/lib/flexperiment-v2/scheduled-backup.py canary check
python3 /usr/local/lib/flexperiment-v2/scheduled-backup.py production check
```

STOP on failure. These commands do not change application configuration or
restart a runtime. Review the safe fixed-enum failure and retained ciphertext;
never treat a previous upload as the result of a failed attempt.

## Independent restore before timer admission / F9

For each environment, use `status.json` to identify the exact verified object:

`s3://art-backups/flexperiment/commerce-v2/<environment>/sqlite/<filename>`

1. Fetch **that uploaded object**, not a different local snapshot. Verify its
   size and SHA-256 against `/var/backups/flexperiment-commerce-v2/<environment>/status.json`.
2. Move the age ciphertext into private owner custody off VPS. Decrypt on the
   owner Mac in Russia, using the existing recovery private key (`0600`).
   Never install this key on the VPS or expose it in a command/report.
3. Open the isolated SQLite restore read-only (`mode=ro&immutable=1` for a
   detached WAL-mode snapshot). Require `PRAGMA quick_check = ok`, exact
   `flexperiment-v2` lineage and migration ledger; independently compare
   catalogue, legal releases and auth/order/outbox state against the source
   snapshot facts. Do not log customer rows or token payloads.
4. Verify required auth/outbox/session key generations are recoverable from
   separate encrypted owner escrow; SQLite does not contain those env keys.
5. Retain safe evidence and ciphertext, remove only the specific temporary
   decrypted restore. A manual upload without this proof is not recovery PASS.

Only after both independent restores pass:

```sh
systemctl enable --now flexperiment-commerce-v2-backup@canary.timer
systemctl enable --now flexperiment-commerce-v2-backup@production.timer
systemctl list-timers 'flexperiment-commerce-v2-backup@*.timer'
```

Six-hourly execution; `check` must be used by the owner monitoring integration.
It exits nonzero for a failed run, missing status or verified upload older than
eight hours. Systemd failures are visible via `systemctl --failed` and journal.
External alert delivery remains an independently verified installation step;
the PR does not claim monitoring is live. Check a deliberately stale private
fixture, not the live database, to prove failure detection.

## Retention / isolation

7 local / 100 remote encrypted snapshots per environment. Retention starts only
after an upload has passed byte-for-byte read-back and remote listing succeeds.
Only generated exact-pattern filenames in that environment's fixed namespace
are removed. No recursive prefix deletion. On failure ciphertext remains for
diagnosis; no plaintext snapshot is intentionally retained by the CLI.

The legacy `flexperiment-recovery-backup` is a separate V1 runtime-secret job.
It is neither replaced nor counted as V2 protection. This PR also corrects its
container selector for the observed `20261008T043419` suffix, with a real
timestamp-container regression and ambiguous-two-container refusal. Installing
that reviewed script does not require a V1 restart. Retain V1 data/routes until
the authorized F9 cutover.
