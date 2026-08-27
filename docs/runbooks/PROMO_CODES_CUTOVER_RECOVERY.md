# Promo Codes v0 cutover recovery

Classify durable release-control state before any action. Do not use `HEAD` or
`main` as authority and do not manually reopen sales.

| Durable phase | Allowed next transition |
| --- | --- |
| `PAUSED` | deploy the exact generation, then `DEPLOYED_READ_ONLY` |
| `DEPLOYED_READ_ONLY` | activate a bounded certification lease |
| `CERTIFICATION_ONLY` | exact leased certification checkout |
| `CERTIFICATION_IN_FLIGHT` | evidence classification only |
| `CERTIFIED` | guarded complete and reopen |
| `RECOVERY_REQUIRED` | same-owner forward adoption of generation N+1 |
| `COMPLETE` | read-only verification only |

An operational payment failure may return to `DEPLOYED_READ_ONLY` only after
all payment/refund state is resolved. A source, migration-byte, pricing, or
evidence mismatch requires `RECOVERY_REQUIRED`; revoke the active lease in the
same durable transition. The production certification fixture remains hidden
and closed, and the real checkout must demonstrate 101 → 100 kopecks through
capture and refund on `IN_FLIGHT → CERTIFIED`; that append-only transition is
the exact order/payment/refund evidence authority. `COMPLETE` rechecks the
consumed lease and cleanup invariant instead: the fixture is still hidden and
closed at 101 kopecks and its `FIXED 1` promo is disabled before sales reopen.
After a consumed attempt, any same-owner retry uses a fresh occurrence and a
fresh promo; it must never reuse either part of the prior fixture.
