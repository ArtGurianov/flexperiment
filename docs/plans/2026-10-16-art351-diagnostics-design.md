# ART-351: classify backup refusals without changing recovery

The owner resumed ART-351 after ART-224 completed. The existing canary remains
healthy on application source `80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`.
No new financial operation, shared Refref change or public opening is in scope.

## Evidence and alternatives

The system journal retains a failed backup invocation at 2026-10-15
10:42:09–10:42:11 UTC, previously described approximately as the 10:43 failure.
Its only application record is `FAST_CUT_HOLD`. That record cannot distinguish
identity/readiness refusal from snapshot, transport or archive verification.
Subsequent successful restores do not recover the missing causal information.

Keeping the generic error preserves confidentiality but loses the information
needed for the next incident. Logging exception text or tracebacks could expose
private commands, provider responses and credentials. The selected alternative
adds a finite operation stage and fixed reason/code vocabulary, preserving the
existing refusal and exception boundary.

## Implementation

`fast-cut.py` records its current synchronous CLI stage. Its own guard failures
use a `ValueError` subclass, with only exact allowlisted codes eligible for
output. Known timeout/file/JSON/SQLite exception classes map to fixed reason
labels. Command timeouts also carry `FAST_CUT_COMMAND_TIMEOUT`, and malformed
JSON carries `FAST_CUT_INVALID_JSON`. Other errors remain `UNKNOWN`; no message, representation, command,
provider body, exception cause or unknown code is serialized. Reports retain
`state=FAST_CUT_HOLD`, operation and exit1, adding stage, elapsed milliseconds and
UTC timestamp. Success payloads retain their existing shape.

Stages distinguish role identity/readiness, database, fence, current remote
ledger, snapshot, copy/local verification, upload, independent remote readback,
status publication and freshness. Only observation changes. No gate removal,
new request, retry, stale authority fallback, admission reopen, timer mutation
or runtime/image/source substitution is introduced.

## Scheduled backup subprocess budget (2026-10-23)

Readiness alone retries up to three times per role, with 5 s pauses. Identity,
schema, fence and ledger checks still run once. The successful slow path also
includes 14 identity/network commands at 180 s each: three commands per role,
two extra Admin network commands, and three more for Commerce before snapshot.
The subprocess budget is 2,520 s identity + 300 s readiness/pauses + 180 s ledger
+ 900 s snapshot + 180 s copy + 180 s S3 upload + 180 s S3 readback = 4,440 s
(74 min). `TimeoutStartSec=90min` leaves 16 min for local work and scheduling;
this is a subprocess budget with allowance, not a bound on disk or CPU stalls.
Six-hour cadence plus the 90 min unit limit remains below the 8 h freshness
window. The test derives command counts and timeout values from the helper and
transport source rather than reserving an arbitrary 300 s for all transport.

## Verification and delivery

Fault tests enter through the actual CLI and backup orchestration. They prove
that failures preserve the last successful status byte-for-byte, avoid snapshot
creation after admission refusal, make no extra PUT/GET attempt and suppress
hostile/secret-bearing exceptions. Existing real Docker/nginx/environment tests
remain required. The same approved application images stay installed.

After exact reviewed commit CI, qualify the controller separately from the
application source. Installation is limited to an atomic, hash-checked helper
replacement with retained predecessor bytes, idle backup service and unchanged
runtime/DB/fence/ingress/timer readbacks. Exercise refusal diagnostics only on
isolated copies; do not intentionally close live admission.
