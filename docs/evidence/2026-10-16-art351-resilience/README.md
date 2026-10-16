# ART-351 — transport diagnosis, isolated outage and alert qualification

**ART351_CANARY_RESILIENCE_SLICE_PASS / F9_HOLD.** This record separates
present workstation transport, historical missing diagnostics, tested reader
behavior and installed operational changes. ART-39/83/224/338 remain complete;
this work introduces no payment, refund, public launch or application release.

## TLS and the historical evidence limit

The exact Mac probes were repeated after the owner changed networks. Before the
change, both S3 addresses `176.109.98.30` and `176.109.98.31`, with SNI
`s3.cloud.ru`, failed before certificate/HTTP for default, TLS1.2 and TLS1.3.
The same six VPS probes succeeded. Canary HTTPS still verified and returned403;
the retired root returned410. The Mac route used `utun6`; this is localization
to a workstation network path, not identification of a particular VPN component.

After the network change, all six Mac probes succeeded, with the same certificate
as the VPS: SHA-256
`16292157dce5496d28e135a4f2e96d7ca2c411be299588e0a31359c1a7bb13fa`,
expiry20December2026. No trust/hostname check was disabled. Diagnostic protocol
pinning did not change client/server runtime TLS configuration. See
[timestamped matrix](tls-network-readback.json).

The previously approximate 10:43 backup failure is actually
15October2026 10:42:09.638773–10:42:11.445030UTC. The retained journal has five
entries and only generic `FAST_CUT_HOLD` from the application. The initial raw `journalctl` JSON export
SHA-256 is `c024204286d5e7e0d3c588d00c6099637538d98c9398dd17e9d5e39a3f020e41`.
JSON field ordering can change between exports; the five sanitized entries were
identical on independent reread. No error stage or underlying exception survives. The current Commerce container
has no historical erasure event log from those removed predecessors. Neither
successful later restores nor this Mac network repair proves the cause of older
VPS closures or that backup failure. It remains **undetermined**; it is not
reported as an established Cloud.ru outage.

## Direct provider retrieval and independent owner recovery

At16:03UTC, encrypted object bytes were downloaded **S3→Mac directly over HTTPS**
with normal TLS verification. SSH supplied only a single exact signed GET
capability in memory; it did not relay object bytes or export the secret key.
The capability was not retained. Archive SHA-256
`fd841a42393512a94cc0db7f07937d58dbc6466b9f8670c0601da1bf5b5df364`,
942504bytes, source `80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`.

Decryption used the owner's existing Mac age identity. Isolated SQLite checks
passed integrity, foreign keys and schema27. Review.5 is active, all paid offers
CLOSED, three zero-value fulfilled fixtures and the one refunded100-kopeck
purchase are retained. Plaintext was removed. The proof is in
[direct-mac-restore.json](direct-mac-restore.json); ciphertext and receipts remain
in private owner custody. This is a newly verified retrieval of the existing
final ART-224 snapshot, not a claim that its creation timestamp changed.

## Reader behavior with the actual installed image and S3

Both experiments used exact installed Commerce digest
`sha256:c928ef2a9e33e2e2bcb7e646e89fe8b239489395539d9eb9094350a683433e4c`,
verified native source and full RootFS. Each used fresh online SQLite/fence
copies and read-only installation/key/reader/mirror authority. There was no
live database/fence mount for writes, published port, financial credential,
HTTP application, mail sender or background worker. Only signed read-only
GET requests to actual Cloud.ru were permitted.

| Experiment | Observed result |
| --- | --- |
| One injected transport failure in isolated SDK handler | Two complete verification attempts; second fresh signed proof succeeds, copied admission stays OPEN |
| Two injected failures | Exactly two attempts, copied admission CLOSED |
| Fresh S3 proof after CLOSED | Verification succeeds; admission stays CLOSED and protected callback never enters |
| Actual egress removed from disposable container | Only remaining network is Docker `internal=true`; two real SDK timeouts, closure after20011ms |
| Egress restored | Actual fresh proof succeeds, but CLOSED remains enforced |
| Native qualified preparation on the copy | OPEN, owner absent, no ACTIVE/UNKNOWN leases |

The network-loss experiment injected no handler errors. Its two timeout
diagnostics are at10002ms and20008ms, followed by
`ERASURE_ADMISSION_CLOSED` at20009ms with
`ERASURE_LIBRARY_READ_UNAVAILABLE`. It reproduces loss of this isolated client's
network, not a failure of the Cloud.ru service itself. The original reused
harness counted handler delegations as “successfulTransportCalls”; the exported
[network receipt](isolated-network-outage.json) explicitly corrects that label
and retains the original receipt hash. No successful HTTP count is inferred from
that counter. The separate [handler receipt](actual-provider-reader.json)
identifies its different fault mechanism.

Ten financial/legal history tables remained byte-equivalent by canonical row
hash. Both copies passed schema27/integrity checks; all disposable containers,
networks and plaintext were removed. Live fence/owner/lease snapshots were equal
before and after. No live disconnect/restart or manual fence open was executed.

## Exact diagnostic controller installation

[PR250](https://github.com/ArtGurianov/flexperiment/pull/250) merged as
`be4d8e8243f0b03e9696f565853c0cd48a2fca2d`. Its exact head851a71a passed
[CI38928678324](https://github.com/ArtGurianov/flexperiment/actions/runs/38928678324),
and the exact merged source separately passed
[CI38930349685](https://github.com/ArtGurianov/flexperiment/actions/runs/38930349685),
both test/docker-build. Local qualification included19 fast-cut tests with real
Docker/nginx and11 alert tests. This delivery changes only host backup refusal
diagnostics, with bounded stage/reason/code/latency/UTC and no error strings.

At16:25UTC the host helper was atomically replaced with the exact merged file,
SHA-256 `8121ac1678288976dc947c79e3a6165a38d6232847238258d8489cfeaaa9b5ae`.
Its predecessor `cd58ad2589332606302616fbd272eab8cd5ddea1bcaea885301640632e970c85`
is retained root-only. The **application** source remains
`80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`; controller and application identities
are deliberately separate. No replacement images were installed.

Native readiness/artifact/RootFS/schema/signed-remote checks and backup freshness
passed before and after with equal results. Container IDs/start times/images,
DB device/inode, ten historical table hashes, persistent fence/leases,
configuration hashes, retained backup status and active timer identities were
unchanged. A diagnostic refusal was exercised only against an empty temporary
backup directory in an imported helper instance: exit1, freshness_status,
MISSING_FILE, FAST_CUT_HOLD. No real backup/fence failure was induced. The
[installation receipt](host-helper-install.json) includes the exact live vector.

## Alert wiring and owner-authorized key rotation

The active fast-cut backup/freshness units had no OnFailure, despite the older
canary handler/template/config already existing. Two syntax-qualified drop-ins
now connect exactly those services:

| Unit | OnFailure instance | Drop-in SHA-256 |
| --- | --- | --- |
| flexperiment-fast-cut-canary-backup.service | commerce-backup | `e5b0326630714c840bb54cbbaeeaf95a8e2e0c8c22c06dddf29381c0bd0dca01` |
| flexperiment-fast-cut-canary-freshness.service | commerce-freshness | `62391d4b74d46c687360b8ea19e39c78702b5c644f7b9897448ce14219cfbf88` |

Handler SHA-256 remains
`259f53547108541741505ef2da4cbdf5f681b21dc1f79d31a045264e5f928e89`;
template SHA-256 remains
`f988138e7e4630a919e619862a857c1f3388b0aa6fa7c757950bd1b8686e6c16`.
No real backup was failed for testing. One authorized `/bin/false` systemd probe
triggered the existing alert: NotiSend accepted201 and the owner confirmed email
delivery; Telebuzzy refused404. A collector timestamp-format error was resolved
by reading that same journal invocation, without a resend.

The owner then supplied a new Telebuzzy credential through a hidden-input zsh
script and SSH stdin. Read-only discovery found two active custody files:
`/root/flexperiment-v2-owner/canary-alerts.json` and
`/etc/refref-monitor/telebuzzy.env`. Only the Telebuzzy field changed, both files
remain root-owned0600, and no running application had a Telebuzzy environment
consumer requiring a restart. The host monitor covers configured Refref
production/canary; no Mikluha Telebuzzy consumer was found or invented. This does
not enroll Mikluha into a monitor that was not previously configured for it.

Old and new configurations were encrypted before replacement; the ciphertext
was independently retrieved/decrypted on Mac and both configuration deltas
verified. Only the encrypted bundle persists in owner custody; staging plaintext
was removed. Application identities/start times were unchanged. The separate
GitHub dead-man credential is outside the owner's VPS rotation request and was
not silently updated or declared qualified by this operation.

A separately authorized **single Telebuzzy-only** test returned200. The owner
pasted the delivered Telegram message with matching reference
`b4245743-b210-4483-a4f4-3a510f930d10`, UTC16:18:06. No second email was sent.
Both delivery channels are therefore evidenced, with separate acceptance and
delivery facts. Older failed alert units remain retained; only failures created
by this probe were cleared after preserving receipts. See
[alert and rotation read-back](alerts-and-rotation.json).

## Operational envelope and remaining production gate

| Mechanism | Current finite qualification | Limit |
| --- | --- | --- |
| Scheduled encrypted backup | Existing six-hour calendar, source-matching SUCCESS and direct verified restore | Cadence is not a guaranteed production RPO |
| Freshness check | Hourly; refuses negative age, age>8h, source mismatch, missing/changed ciphertext | Age-only detection can occur at the next hourly tick, approaching9h plus scheduler delay |
| Backup/freshness failure | Actual units now invoke existing two-channel handler; harmless systemd path and both deliveries verified | Provider acceptance alone never proves delivery; handler failure remains visible |
| Reader transient | At most one additional complete signed current verification | No integrity/freshness/prefix retry or stale-authority fallback |
| Reader network loss | Actual disposable-network loss closes after two10s timeouts | Finite measurement, not a production latency/SLO guarantee |
| Recovery | Native qualified copy recovery with current signed authority and drained leases | Successful GET never auto-opens CLOSED; ACTIVE/UNKNOWN cannot expire away |

ART-351 remains In Progress before F9/ART240 production acceptance. Outstanding
production criteria are an explicitly accepted availability/RPO/RTO envelope and
continuous independent monitoring/recovery evidence in that deployment scope.
The existing desktop read-only monitor is not a host-independent production
monitor. This execution does not broaden its reach, manufacture a historical
root cause or claim multi-day availability from a short canary qualification.


## Final independent read-back

After helper installation, separate read-only collection again found the same
three healthy role IDs/start times, restart counts0, OPEN/sequence1, no owner and
no leases. The retained backup remained source-matching SUCCESS,4382seconds old
at16:25UTC. Backup/freshness timers were active with next triggers18:15/17:00UTC.
All four external canary hosts returned403 with verified TLS. The retired root,
LAB and Admin hosts returned410. Retired partner has no DNS answer; a fixed-IP
probe refused the default untrusted certificate (verification stayed enabled).
No public partner HTTPS410 is claimed from this reread, and no retired surface
was re-enabled. Current identities and the historical failure reread
are in [final-canary-readback.json](final-canary-readback.json); ingress and exact
helper reread are in [final-boundary-readback.json](final-boundary-readback.json).
No financial operation or new real backup was created for these checks.
