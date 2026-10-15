# ART-351 — reader diagnostics and bounded recovery

**Prepared, not executed.** Independent review and a new explicit owner GO are
required before installation/restart. ART337 infrastructure remains Done. ART351
is now an immediate availability blocker for live ART338 and a mandatory F9 gate.
Production/V1/Refref/provider/public registration/payments/marketing/F9 stay closed.

## What this patch does (and does not establish)

- Clears only a rejected cold-history Promise, never a confirmed history/prefix.
- Makes at most one complete additional GET-only verification for a typed S3
  transport/timeout/429/5xx failure. SDK retry remains disabled. A failed first
  attempt never authorizes a protected operation; only a fully verified current
  second result can do so. No loop, stale mirror/unsigned fallback, cached success
  or automatic CLOSED→OPEN. Integrity/policy/freshness errors never get a retry.
- Rechecks shared admission after an awaited read, including SEND acquisition.
- Emits redacted failure-stage/reason/allowlisted-code/latency and closure events.

This can tolerate an isolated transient and removes reproducible cold-history
poisoning/concurrent admission defects. It does not prove which request caused
past closures or that Cloud.ru/VPS networking is now reliable. More than one
consecutive transient can still close admission intentionally.

## Read-only classification before a separately approved operation

1. Verify exact reviewed code/CI and immutable qualified target image, registry
   manifest/config, target image ID, full RootFS, platform and baked source. Keep
   controller/source distinct. Retain Platform/Admin unless an explicit release
   vector requires them; check Platform's expected Commerce source and proxied
   Admin readiness semantics. No tag-only identity or inference from main.
2. Identify only the existing fast-cut canary stack/SQLite+WAL/erasure mounts.
   Preserve current database lineage, schema0026/fingerprint/integrity/FKs,
   authored course and existing PROCESSING upload/session/video bindings. Expect
   no real users/orders unless separately accounted for. Unknown rows mean HOLD.
3. Independently read signed current remote ledger. Match scope/head/prefix,
   installation/reader binding and keys against existing persistent fence and
   owner journal. Preserve both; no new ledger/journal or manual fence edit.
4. Require no owner and no ACTIVE/UNKNOWN leases or competing legacy writers.
   Any lease/uncertain operation needs separate evidence reconciliation; never
   delete it or wait for expiry. No duplicate Tus init/upload/provider cleanup.
5. Preserve a fresh WAL-consistent encrypted snapshot of **current** Commerce,
   independent remote GET/hash/decryption/SQLite integrity readback, plus existing
   archives. Admission CLOSED can prevent the regular helper `backup` (its
   readiness gate is intentional). Use only a separately approved read-only
   offline snapshot procedure under writer isolation; do not remove the helper
   gate or relabel an old SUCCESS. The 04:25 backup lacks later course/upload
   writes and is prohibited as a rollback source.

## One bounded candidate install / normal recovery after owner GO

Use the existing Compose upgrade contract with qualified exact artifacts and a
reviewed role/source vector, including Platform expected-Commerce identity.
Stop dependent tester traffic. Isolate only recorded canary backup/freshness
schedules and wait for any active backup operation to settle. Preserve private
config/descriptors and current SQLite/WAL. Do not replay hard-cut setup or old
Coolify/journal requalification, reset/import/backfill or restore an old DB.

Allow only the specifically approved candidate boot, with no restart loop while
boot is unqualified. prepareErasureRuntime must perform REQUIRED installation,
current signed remote verification, drained application on the same SQLite and
latest-proof comparison before OPEN. No direct DB/fence/openQualified invocation
by an operator. If a boot/lease/authority result is uncertain, preserve receipts
and stop; no automatic second start/recovery.

Independently read OPEN/sequence/head, owner absent/leases0; exact actual image
identity, schema0026, course/history/upload continuity, no resurrected synthetic
erased identity, three actual readiness responses, ten retired404, Control Room
smoke, payment disabled and four outside403. Any mismatch or renewed CLOSED is
HOLD. Do not transfer old-image proof to a new artifact automatically.

Run the reviewed helper's new encrypted backup, require the new Commerce source,
independent remote GET/hash/off-runtime decrypt, isolated SQLite restore and
normal copied-fence boot/synthetic suppression in the exact installed image.
Restore only prior timer schedules after these readbacks; require enabled/active,
future triggers and source-matching fresh status. First real calendar backup is
separate evidence. A restore of a copy is never permission to replace live data.

Then resume ART334 using the **existing** upload session. Obtain current provider
status via the normal operator poll, bind only at READY, preserve any prior READY
binding. Continue real magic-link/consent/grant/provider callback/browser tests
only while current admission/backup is qualified. Stop immediately on CLOSED.

## Observability / finite acceptance

The server emits JSON `ERASURE_READ_FAILURE` with `stage`, `reason`, optional
allowlisted `code`/numeric `httpStatus`, `attempt`, `elapsedMs`, `scope`, `observedAt`.
`ERASURE_READ_RECOVERED` means a full current proof succeeded on attempt2, **not**
admission reopen. `ERASURE_ADMISSION_CLOSED` identifies READY/REQUEST/WORKER/SEND;
`ERASURE_BOOT_HOLD` identifies refused startup. No raw error object is logged.

Retain these JSON fields with container/image/source/start time, independent
fence/lease snapshot and backup status when an incident occurs. No env, cookies,
JWT, Basic Auth, email, raw provider error/body or object/version identifiers.
Continue the existing read-only monitor: alert once for HEALTHY→ALERT/UNKNOWN,
CLOSED/unhealthy, new backup failure, or age>8h/source mismatch; suppress unchanged
alerts and notify observed recovery without asserting a root-cause fix. No auto
restart. A GET-only retry logged by the reader is not a second owner recovery.

The existing three-role 15s readiness workload remains enabled. During a bounded
post-install observation plus resumed E2E, correlate failure/recovered-read logs,
actual OPEN/CLOSED and backup outcomes. Record exact duration/sample count and
all recovered errors; do not claim multi-day production resilience from a short
canary run. Before F9, prove the intended outage/recovery/alert behavior with the
actual provider and a separately approved scope. This PR's synthetic transport
and local recovery tests are not provider qualification or execution authority.
