# Invariant registry

Every production invariant this repository intends to hold, and the test that
would fail if it stopped holding. It exists because the cleanup PR deletes a
great deal of test code, and a deleted test is indistinguishable from a
redundant one until someone names what it was guarding.

A row is green when the guarding test both exists and has been shown to fail
against a deliberate break in the thing it guards. "Exists" is not enough: a
test that passes whatever the code does guards nothing, and a registry built
from names rather than from evidence is a longer way of writing a wish.

Rows are grouped by who owns the invariant, not by which file it lives in.

## Data invariants enforced by the schema

These are triggers and constraints. They run whether or not the application is
the one writing, which is the point: they protect against maintenance run
straight against the database as well as against a defect in the domain.

| Invariant | Enforced by | Guarded by |
|---|---|---|
| A venue cannot be announced later than it is disclosed | `0008` `VENUE_ANNOUNCEMENT_TOO_LATE` | `api.test.ts` |
| Hidden implies not sellable | `0010` `OCCURRENCE_HIDDEN_SALES_MUST_BE_CLOSED` | `api.test.ts` |
| Terminal fulfilment implies sales closed | `0011` `OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED` | `api.test.ts` |
| `FAILED` if and only if a delivery outcome is recorded | `0039` `EMAIL_OUTBOX_DELIVERY_OUTCOME_INVARIANT` | `email-delivery-outcome.test.ts` |
| At most one unsettled attempt per message | `0041` partial UNIQUE | `outbox-attempt-constraints.test.ts` |
| An attempt's identity never changes after it is written | `0041` `OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE` | `outbox-attempt-constraints.test.ts` |
| A settled attempt is never rewritten | `0041` `OUTBOX_ATTEMPT_SETTLED_IMMUTABLE` | `outbox-attempt-constraints.test.ts` |
| An attempt is never deleted, but a purged message takes its own | `0041` `OUTBOX_ATTEMPT_DELETE_FORBIDDEN` | `outbox-attempt-constraints.test.ts` |
| Dispatch stops when an operator pauses it | `0041` `EMAIL_DISPATCH_PAUSED` | `outbox-attempt-claim-seam.test.ts` |
| Exactly one legal release is active | `one_active_legal_release` UNIQUE | `legal-release.test.ts` |
| A payment's idempotency key is unique | `checkout_idempotency` UNIQUE | `api.test.ts`, `domain.test.ts` |

## Runtime invariants

| Invariant | Owner | Guarded by |
|---|---|---|
| The emergency stop closes sales everywhere, at once | `emergency-sales-gate.ts` | `emergency-sales-gate.test.ts` |
| A missing emergency gate row reads as closed | `emergency-sales-gate.ts` | `emergency-sales-gate.test.ts` |
| The emergency stop is durable, not in-process state | `emergency-sales-gate.ts` | `emergency-sales-gate.test.ts` |
| A certification capability bypasses only the deployment fence | `release/sales-gate.ts` | `release/sales-gate.test.ts` |
| A capability is scoped to one release, run, session, occurrence and ceiling | `certification/capability.ts` | `certification/capability.test.ts` |
| A capability is spent exactly once, with the order it admits | `certification/checkout-authority.ts` | `certification/checkout-authority.test.ts` |
| A certification run is advanced by one runner at a time | `certification/run.ts` | `certification/run.test.ts` |
| An interrupted command is replayed as itself, never composed anew | `certification/machine.ts` | `certification/machine.test.ts` |
| A catalogue that turned to cleanup never reopens | `certification/run.ts` | `certification/run.test.ts` |
| A failed run reconciles captured money before it is finished | `certification/machine.ts` | `certification/machine.test.ts` |
| A late catalogue command cannot undo a finished cleanup | `certification/catalogue-authority.ts` | `certification/machine.test.ts` |
| `CREATE_UNKNOWN` is never resolved by a second POST | `domain/payments.ts` | `domain.test.ts` |
| At most one non-terminal refund per payment | `domain/refunds.ts` | `api.test.ts` |
| A duplicate provider webhook is quarantined, not applied twice | `domain/payments.ts` | `domain.test.ts` |
| Seats cannot be oversold under concurrency | `domain/occurrences.ts` | `occurrence-inventory-concurrency.test.ts` |
| City-interest data is processed only for its stated purpose | `domain/city-interest.ts` | `api.test.ts` |
| Migrations take the write lock and re-check inside it | `db.ts` | `db-migrate.test.ts` |

## Release invariants

| Invariant | Owner | Guarded by |
|---|---|---|
| A deploy binds to a published candidate, never to a named commit | `deploy-production.yml` | `release/deploy-workflow-contract.test.ts` |
| Rolling is derived from a candidate's class, never chosen | `release/candidate.ts` | `release/candidate.test.ts` |
| A candidate is published only from a commit whose own CI is green | `release-candidate.yml` | `release/deploy-workflow-contract.test.ts` |
| A launch baseline is the current tip of `main` | `release-candidate.yml` | `release/deploy-workflow-contract.test.ts` |
| Dispatch inputs never reach a shell as interpolated text | both workflows | `release/deploy-workflow-contract.test.ts` |
| Sales do not stay shut after a deploy that touched nothing | `release/deploy-session.ts` | `release/deploy-session.test.ts` |
| A partial deploy does not reopen sales by itself | `release/deploy-session.ts` | `release/deploy-session.test.ts` |
| Rollback authority is spent before external effects, not after | `release/deploy-session.ts` | `release/deploy-session.test.ts` |
| A dead runner's session can be taken over, but the fence stays | `release/deploy-session.ts` | `release/resume.test.ts` |
| Readiness separates "not yet" from "converged and inadmissible" | `release/readiness.ts` | `release/readiness.test.ts` |
| A foreign database lineage fails closed | `release/schema-identity.ts` | `release/schema-identity.test.ts` |
| A cutover envelope is adopted exactly once | `release/cutover-handoff.ts` | `release/cutover-handoff.test.ts` |

## Open rows

Rows here are invariants with no guarding test, or whose guard is known to be
weaker than the claim. The PR does not merge with an open row.

| Invariant | Owner | Why it is open |
|---|---|---|
| A tampered ticket capability fails to decrypt | `crypto.ts` | `encryptTicketCapability` round-trips through `api.test.ts` and `domain.test.ts`, so the happy path is covered, but nothing asserts that a modified ciphertext or a swapped nonce is rejected. The AES-GCM auth tag is the property worth proving, and it is the one not proved. |
| Canonical JSON is stable across key order and nesting | `crypto.ts` `canonicalV2` | No test names it. It is the basis of command-replay digests, so a change in its output silently changes what counts as the same command. |

## How the rows above were checked

Each guarding test was confirmed twice: that it names the invariant, and that it
fails when the invariant is deliberately broken. Four rows were opened by that
second check rather than the first.

`emergency-sales-gate.test.ts` did not exist. It was deleted in `cb8cf20` along
with the release controller it imported, which took the operator's absolute stop
down with it - including the property that a missing gate row reads as closed.
Rehoused against the live composition boundary, without the controller.

`OCCURRENCE_TERMINAL_SALES_MUST_BE_CLOSED` had no test at all, while its pair in
`0010` had one. Added beside it.

The `outbox_attempt` immutability triggers - the strongest protection against
sending a customer two tickets - were named only inside
`outbox-attempt-migration.test.ts`, a file whose purpose is to stop existing
once the ledger collapses. The constraint cases were moved to
`outbox-attempt-constraints.test.ts` and rephrased against the schema as it is,
so that deletion is now safe. The migration-semantics cases stay where they are.

`one_active_legal_release` was exercised only through the publisher. A direct
write now proves the index itself.
