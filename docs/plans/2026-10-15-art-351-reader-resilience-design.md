# ART-351: bounded current-reader resilience

## Scope and observed evidence

Source463 closed during the real ART338 Tus attempt on 15 October 2026,
04:43:35UTC. Container restart counts remained zero, fence CLOSED/sequence1,
no owner or leases. The exact failed provider request was not recorded. A prior
ListObjectVersions timeout proves a failure mode, not the cause of this event.
The existing schema0026/course v2/upload session must survive recovery. The
04:25 archive predates these writes and must never replace current SQLite/WAL.

This is an offline engineering slice. No new live restart, image, provider,
secret, timer, fence/journal or database mutation is authorized by this design.

## Alternatives and decision

1. Diagnostics and rejected-history reset only: least behavior change, but a
   single transient warm S3 failure still immediately latches CLOSED.
2. **Selected:** add one finite full GET-only re-verification for typed transient
   errors, with safe diagnostics and a final shared-fence check. Keep persistent
   CLOSED and the existing qualified startup recovery. No stale success cache.
3. Cached authority, relaxed /readyz, or automatic OPEN/restart: rejected. These
   broaden admission/recovery semantics and are unnecessary for this slice.

## Exact behavior

The SDK remains maxAttempts1, explicit credentials/namespace/owner, no redirect,
10s command abort and 10s bounded GetObject stream consumption. The current-proof
layer permits at most two full attempts per call, only for recognized network
codes, timeout/abort, HTTP429 or HTTP5xx. An unknown failure, HTTP4xx, signature,
missing object, versioning/history defect, changed head, recipient, stale mirror,
fork/rollback or freshness failure stops immediately. Both attempts share the
original opaque capability issuer's 60s deadline; no new proof until its complete
bundle/signature/prefix/freshness verification succeeds. Each attempt obtains its
own current signed head, exact packet, matching owner mirror and final head.
Successfully qualified cold history remains cached as before; an unsuccessful
in-flight history Promise is cleared only if it is still that exact Promise.
This is a deliberate change from the former zero-repeat reader policy; it does
not permit retries of writes, uncertain sends, deployment or admission recovery.

No remote failure is ignored. An exhausted read still closes persistent admission.
A later standalone successful read does not open it. Only the normal
prepareErasureRuntime drain/application/latest-read/reopen path can recover,
with REQUIRED binding, exact supported schema and no owner/ACTIVE/UNKNOWN leases.

After any awaited remote read, request/worker/send acquisition must recheck
process qualification and shared OPEN/no owner. A successful pending read cannot
run a handler or send mail after another readiness check has closed admission.
Existing durable leases/UNKNOWN evidence and writer coverage are unchanged.

## Diagnostics and validation

Failure-only events contain fixed stage/reason/code enums, numeric HTTP status,
attempt, monotonic latency, scope and operation. Runtime adds a UTC timestamp.
No caught Error/message/stack, provider body, URL/object/version ID, request ID,
headers, credential or identity reaches the sink. Sink exceptions cannot alter
admission. A recovered-read event is emitted only after opaque proof validation,
and never means fence recovered. Fence/boot closure has separate fixed events.

Regressions use real AWS SDK signing/serialization behind a synthetic read-only
transport, real SQLite/fence/age and controlled abort/body deadlines. Cover cold,
warm, overlapping probes/requests, history rejection, bounded exhaustion, no
security retry, changed ledger during a retry, original freshness deadline,
CLOSED concurrency, ordinary drained recovery on the same SQLite, synthetic
suppression and post-recovery backup readback. They do not establish Cloud.ru
availability or the historical root cause. Separate exact-head CI and independent
review precede any new deployment; see ART-351 recovery runbook.
