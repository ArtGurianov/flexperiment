# Promo Codes v0 cutover recovery

Classify durable release-control state before any action. Do not use `HEAD` or
`main` as authority and do not manually reopen sales.

Use the manual
[`controlled-promo-codes-cutover.yml`](../../.github/workflows/controlled-promo-codes-cutover.yml)
workflow only. Its controller SHA is not the deployment source: operators pass
the exact initial `target_sha`, and the durable release ID remains
`promo-codes-v0:<initial-sha>` throughout recovery. The workflow reads
`GET /v1/admin/release-control/candidates/head` with the release-control bearer
credential and uses the returned `state_hash` verbatim for every next CAS
transition. Do not derive a hash from workflow inputs or reconstruct a lease
binding.

The protected `production-deploy` pointer is updated only by the workflow's
exact CAS helper. Configure `PRODUCTION_DEPLOY_REF_TOKEN` as a production
environment secret with repository contents-write and workflow-write authority:
the immutable feature source itself includes a workflow file, which the default
Actions token is not permitted to update through a ref move. The workflow
requires this credential before it can acquire an owner, and uses it only for
the pointer helper. It first removes the checkout-provided GitHub App auth
header so the dedicated credential is actually selected; never pass it as a
dispatch input or print it in logs.

The deploy source (including a `replacement_sha`) must descend from the
authority-head API hardening commit `91c78c9545820698cb2433f426b75bd5e1ca262c`.
Before generation one is acquired, the workflow proves every already applied
production migration is an identical sorted prefix of the candidate inventory.
Before `DEPLOYED_READ_ONLY` can issue a lease, it verifies exact Commerce,
worker, frontend and admin source evidence; fresh worker heartbeat/sweep;
complete migration hashes; immutable legal baseline/copies; and health/ready
responses.

Run `prepare` first without certification inputs. It acquires generation one,
proves public checkout is paused, deploys the exact source, and reaches
`DEPLOYED_READ_ONLY`. Create the hidden/closed 101-kopeck occurrence and active
`FIXED 1` promo, retain a stable checkout idempotency key and pass its SHA-256
with all other certification inputs to `prepare` again. That second pass only
activates the lease and leaves the ordinary public/provider checkout flow to
produce the consumed evidence. After evidence has reached `CERTIFIED`, use
`complete`; it is the only workflow path that reopens sales.

All four certification inputs are all-or-nothing. `retry_reason=OPERATIONAL`
requires a fresh full fixture after resolved terminal payment failure.
`replacement_sha` is accepted only by `prepare` from `RECOVERY_REQUIRED` and
adopts generation N+1 under the same release ID; it never rewrites the old
generation or reuses a consumed fixture.

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
