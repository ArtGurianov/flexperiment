# ART-166 / ART-41: canary backup operator alerts

Owner-approved destinations: accidents@flexperiment.ru through NotiSend and
the existing Telebuzzy operator channel. No customer mail, marketing or runtime
deployment is involved. Canary-only host handler is preferable to adding alert
logic to Commerce or the shared production backup template.

Discovery: current Commerce V1/worker have no Telebuzzy env keys or repository
implementation. Existing integration is the host Refref monitor; its root-only
`/etc/refref-monitor/telebuzzy.env` remains unchanged. Copy only the existing
Telebuzzy credential to separate owner custody. Read current canary NotiSend
sender/key without printing values. Preserve both source configurations.

Install exact merged/CI-admitted `canary-backup-alert.py` and units. Store its
strict five-field configuration at `/root/flexperiment-v2-owner/canary-alerts.json`
(root:root 0600, parent 0700), with encrypted off-host owner escrow. No secrets in
tracked files, arguments, journald, reports, or EnvironmentFile. Fixed HTTPS API
destinations, no redirects, 10-second timeout, bounded response, no automatic
retry. Telebuzzy uses the current official Bearer and Idempotency-Key contract.

Install drop-ins only at:

- `flexperiment-commerce-v2-backup@canary.service.d/canary-alert.conf`
- `platform-canary-backup.service.d/canary-alert.conf`
- `platform-canary-backup-freshness.service.d/canary-alert.conf`

Do not edit the shared Commerce template or production instance. Add hourly
Commerce **canary** freshness service/timer. Both channels are attempted even
when one fails. Fixed event enum/title/time/reference only; no provider bodies,
logs, database rows, customer facts, JWTs, tokens, or IP addresses. Preserve the
backup service's failure: successful notification never turns backup into PASS.

Qualification: validate root custody and unit syntax, then explicitly start
`canary-alert-probe.service` once. Its intentional `/bin/false` tests actual
systemd OnFailure dispatch without failing a real backup or mutating a DB.
Retain the alert outcome/reference; clear only the probe failure afterward.
Provider ACCEPTED is not delivered-notification proof. NotiSend DELIVERED status
or owner mailbox confirmation and actual Telegram receipt are needed before
delivery PASS. Unknown/refused outcome stays HOLD; do not resend blindly.

Keep existing backups ACTIVE/FRESH and four HTTPS guards at 403. Existing
canary runtimes, production, V1, Refref, volumes and release refs remain unchanged.
No new Linear issues; update ART-166/ART-41 with exact observed results.

## Incident state (2026-10-22 follow-up)

On 2026-10-22 one stale canary backup produced a stale-backup alert every
hour (2 backup + 8 freshness messages), and nothing announced when it
recovered. Each event now has one incident in
`/var/lib/flexperiment-v2-canary-alerts/<event>.json`: a systemd
`StateDirectory`, mode 0700, holding only integer timestamps and a counter.

- Tracking is per channel. A channel gets the first failure, then nothing for
  6 h, then one "still failing" reminder carrying the suppressed count. A
  channel that did not acknowledge (refused, unknown) is not recorded, so the
  next failure sends to that channel again, and only to it.
- `OnSuccess=flexperiment-v2-canary-recovery@<event>.service` runs
  `--recovered`. It sends one recovery notice to every channel that
  acknowledged the incident. A channel that refuses the recovery keeps it
  pending, and the next success retries that channel alone. Without an open
  incident it contacts no provider.
- Alert and recovery for the same event hold a per-event `flock` across the
  state read, the provider calls and the state write, so a recovery cannot
  slip in front of an in-flight alert and leave a stale incident behind. Both
  templates use `TimeoutStartSec=60`: two 10 s provider calls of the other
  holder, plus their own.
- Unreadable, foreign or malformed state counts as "no incident", so the
  handler fails toward notifying. `probe` is never suppressed or recorded.
- Suppression never changes the failed backup/freshness unit, which stays
  failed in systemd.

The message still carries no stage/code. The handler keeps its "no
runtime/DB/log access" rule, and systemd 249 on adman-vps does not pass
`MONITOR_*` metadata to OnFailure units. The cause is in the failed unit's
journal line (`FAST_CUT_HOLD` with stage, code and, since the readiness
follow-up, detail).
