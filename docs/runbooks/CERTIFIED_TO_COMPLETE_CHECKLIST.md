# `CERTIFIED` → `COMPLETE`: operator checklist

This is a **human pre-dispatch checklist, not a machine proof.** It does not
gate anything and must never be treated as authority.

`completeCandidate` re-verifies every item below server-side and refuses the
transition if any of them is unmet. That check is the authority. The list exists
only so an obvious unfinished step is noticed before dispatch rather than
discovered as an HTTP 409 several minutes later.

## Why it exists

During the 0039 cutover, `complete` was dispatched twice against a candidate
that was genuinely `CERTIFIED` and failed both times on cleanup the operator had
not been told to perform:

```text
attempt 1   payment PAID, no refund      CERTIFICATION_PAYMENT_REFUND_MISSING
attempt 2   promo still ACTIVE           CERTIFICATION_CLEANUP_INCOMPLETE
```

Neither was a defect. Both were preconditions nobody had written down, found one
refusal at a time while production sales were paused.

## Before dispatching `complete`

```text
payment                 PAID
refund                  SUCCEEDED, full amount
                        (payment status becomes REFUNDED once the worker
                         reconciles - a refund still in REQUESTED will refuse)
certification lease     CONSUMED, with consumed_order_id set
certification promo     DISABLED
certification fixture   HIDDEN / CLOSED / SCHEDULED / price 101
emergency latch         ON
```

The last one is the opposite of the certify-stage requirement and is easy to get
backwards. The ordering is safety-critical in both directions:

```text
latch OFF before certify    the emergency gate is absolute, so a latch set
                            early fails the real 1-RUB payment, not the workflow
latch ON  before complete   completeCandidate clears the release gate, so
                            without the latch sales open before the new durable
                            state has been inspected
```

## What the controller can and cannot see

The controller holds a release-control token and no admin credentials, so it
cannot observe promo status, refund state, or the fixture rows, and it cannot
latch or clear the emergency stop. That is deliberate: a release controller able
to stop sales could also refund, cancel and mutate, which is far wider authority
than driving a release needs.

It observes the emergency latch through `emergency_sales_paused` on the internal
release-control status, which is read-only, and refuses to complete into open
sales. Everything else on this list is verified by `completeCandidate` itself.

Widening the release-control HTTP surface so the controller could pre-check the
rest was considered and rejected: it would grow a permanent authority boundary
to serve a rare cleanup procedure. A written checklist plus an authoritative
server refusal is the right split.

## Reading a refusal

Controllers use `scripts/release/release-api.sh`, which prints the HTTP status,
the parsed `error.code` and message, and the raw body on any non-2xx. A refusal
reads as:

```text
RELEASE_API_REFUSED
  HTTP 409
  code: CERTIFICATION_CLEANUP_INCOMPLETE
```

If a run instead shows a bare `curl: (22)`, something is still calling curl
directly with `--fail-with-body`, which discards the server's answer. Fix that
rather than guessing at the cause.
