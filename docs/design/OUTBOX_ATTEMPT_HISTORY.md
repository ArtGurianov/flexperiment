# Outbox attempt history and audited resend — relational model

**Design only. No migration, no schema change, no worker change in this
document.** It exists because B4 and B5 are the genuinely new failure modes and
both must be impossible by database construction rather than detected after the
fact.

Builds on migration 0039, which is live: `status` is worker lifecycle and
`delivery_outcome` is delivery truth, enforced by triggers.

## The rule everything else serves

```text
FAILED + KNOWN_FAILED   resend may be requested
FAILED + UNRESOLVED     no resend, ever; reconciliation only
```

No timer, retry count or elapsed budget may promote `UNRESOLVED`. Attempt
budgets are scheduling policy, not evidence.

## The hazard this design has to avoid

`email_outbox` already carries per-attempt columns: `attempts`, `last_error`,
`provider_idempotence_key`, `job_id`, `provider_error_code`,
`provider_error_message`, `send_started_at`, `provider_request_started_at`,
`lease_owner`, `lease_expires_at`, `next_attempt_at`.

Introducing `outbox_attempt` alongside them recreates the two-authorities
problem 0039 just removed — the row would say one thing about the current
attempt and the table another, and they would drift.

Three options were considered:

| Option | Verdict |
|---|---|
| Move the columns off `email_outbox` | Rejected. Needs a table rebuild, and the table has eight inbound foreign keys — nine tables including consent and PII tables. Same reason 0039 used `ADD COLUMN`. |
| Message row holds the in-flight attempt, table holds closed ones | Rejected. Terminating an attempt would mean *copying* it into the table, which is a new write that can be lost — a fresh crash boundary invented to avoid an old one. |
| **Table is authoritative from creation; the old columns freeze** | **Chosen.** |

Under the chosen option `outbox_attempt` is written at claim time and is the
only authority for attempt facts. The legacy columns stop being written for new
attempts and are backfilled once, becoming inert. They can be dropped later with
`ALTER TABLE DROP COLUMN` (SQLite 3.35+, subject to the usual index and
constraint restrictions); until then they are read by nothing.

That transition is the expensive part of this work and is why the migration is
not written yet.

## Tables

`email_outbox` keeps its identity as the logical message: recipient, template,
payload snapshot, consent linkage, `status`, `delivery_outcome`.

```sql
CREATE TABLE outbox_attempt (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  -- Its own key. Reuse is correct WITHIN an attempt (it is what makes an
  -- ambiguous replay safe) and wrong ACROSS attempts, where it would make the
  -- resend a no-op at the provider. Derived, so it is reproducible:
  --   sha256(message_id || ':' || attempt_no)
  provider_idempotence_key TEXT NOT NULL UNIQUE,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  provider_job_id TEXT,

  -- NULL while in flight. Once set, the row is immutable.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('DELIVERED', 'KNOWN_FAILED', 'UNRESOLVED')),
  failure_code TEXT,
  failure_detail TEXT,

  UNIQUE (message_id, attempt_no)
);

-- At most one attempt in flight per message. This is what makes B5 impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX outbox_attempt_active_unique
  ON outbox_attempt(message_id) WHERE outcome IS NULL;

CREATE INDEX outbox_attempt_message_idx ON outbox_attempt(message_id, attempt_no);
```

Immutability of a terminal attempt is enforced the way 0039 enforced its
biconditional — a `BEFORE UPDATE` trigger that aborts when `OLD.outcome IS NOT
NULL`, since SQLite cannot express it as a constraint.

## Crash boundaries

B1–B3 are unchanged and already sound: stale `SENDING` leases sweep into
`SEND_UNKNOWN`, and `email_provider_events.semantic_key` makes reconciliation
replay idempotent.

### B4 — resend requested, attempt absent

Impossible by construction: there is no separate "request" durable object. The
request, the audit record and the attempt commit together or not at all.

```text
BEGIN IMMEDIATE
  read message + its latest attempt
  assert message.status = 'FAILED'
  assert message.delivery_outcome = 'KNOWN_FAILED'      <- the whole point
  assert expected_revision matches                       <- operator CAS
  INSERT outbox_attempt (attempt_no = max + 1, outcome NULL)
  INSERT audit row (actor, reason, incident reference)
  UPDATE email_outbox SET status = 'PENDING', delivery_outcome = NULL
COMMIT
```

The worker consumes the attempt row, so a committed resend always has one.

Note the last line is not bookkeeping: 0039's trigger *forces* it. A row that is
not `FAILED` may not carry a classification, so re-arming the message
necessarily clears the message-level outcome — while attempt #1's
`KNOWN_FAILED` stays immutable in the attempt table. The message says "in flight
again"; history still says why the first attempt failed. The 0039 invariant
turns out to produce the correct behaviour here for free.

### B5 — concurrent resends mint two attempts

Impossible by construction, three ways over:

```text
BEGIN IMMEDIATE                serializes writers
UNIQUE(message_id, attempt_no) two attempts computing max+1 collide
partial unique on outcome NULL only one attempt may be in flight at all
```

Two racing callers therefore resolve to *one* new attempt and one loser, never
attempts #2 and #3. A duplicate request from the same operator is separately
absorbed by `withAdminCommand` durable idempotency, which replays the stored
response rather than minting anything.

## Invariants and where each is enforced

| Invariant | Enforced by |
|---|---|
| Only a known failure may be resent | `delivery_outcome = 'KNOWN_FAILED'` assert inside the transaction |
| A terminal attempt is never modified | `BEFORE UPDATE` trigger on `OLD.outcome IS NOT NULL` |
| Resend creates a new attempt number | `UNIQUE(message_id, attempt_no)` |
| At most one active attempt | partial unique index on `outcome IS NULL` |
| A new attempt never reuses a provider key | `UNIQUE` on the derived key |
| Payload is byte-identical to the original | snapshot lives on the message; the attempt has no payload |
| A delivered message cannot be resent | message-level guard, not the failed attempt alone |
| Duplicate resend requests are idempotent | `withAdminCommand` |
| Manual resend records actor, reason, incident | `recordAdminCommandAudit` |

## Deliberately not decided here

- **Whether `UNRESOLVED` keeps reconciling.** Reaching it means the budget ran
  out. Either it stops permanently and only an operator restarts it, or it drops
  to a slow indefinite cadence. Separate decision; neither creates a resend edge.
- **Deliberate duplicate send.** For when an operator knows the first copy
  arrived and wants another anyway. Explicitly out of scope, named here so
  nobody later widens resend to cover it.
- **Retiring the legacy columns.** Backfill first, drop much later, possibly
  never.

## Sequence

```text
1. this document, reviewed
2. migration 0040: outbox_attempt + backfill of attempt #1 + immutability trigger
3. worker claims the attempt row instead of the message row
4. audited resend command, transaction exactly as B4 above
5. admin surface
6. provider crash and replay tests
```

The resend endpoint is last on purpose. Once a button exists, accidental
duplicate delivery becomes a production risk before the durability model is
ready to prevent it.
