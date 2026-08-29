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

`email_outbox` already carries eleven per-attempt columns: `attempts`,
`last_error`, `provider_idempotence_key`, `job_id`, `provider_error_code`,
`provider_error_message`, `send_started_at`, `provider_request_started_at`,
`lease_owner`, `lease_expires_at`, `next_attempt_at`. Every one of them is given
an explicit destination in "Column ownership" below.

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
not written yet. It is also not merely a data-migration problem: see "Where the
lease lives" and "Authority cutover", where moving the lease to the attempt
turns out to make worker quiescence mandatory, because two workers leasing in
two different places do not exclude each other at all.

## Tables

`email_outbox` keeps its identity as the logical message: recipient, template,
payload snapshot, consent linkage, `status`, `delivery_outcome`.

```sql
CREATE TABLE outbox_attempt (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  -- Its own key. Reuse is correct WITHIN an attempt - it is what makes an
  -- ambiguous replay safe - and wrong ACROSS attempts, where it would make the
  -- resend a no-op at the provider.
  --
  -- Opaque, never derived. enqueueEmail already mints these with publicId()
  -- (domain.ts:2939), so a derivation rule would both contradict production and
  -- add a second canonicalization that layers could reproduce differently -
  -- the mistake release-expectation.ts exists to have fixed. Safety comes from
  -- persisting the key before any provider call and reusing it within the
  -- attempt, not from being recomputable.
  --
  --   attempt #1    copy the message's existing key byte-for-byte
  --   attempt #2+   mint a fresh publicId(), persist, then call the provider
  provider_idempotence_key TEXT NOT NULL UNIQUE,

  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  provider_request_started_at TEXT,
  -- When THIS SEND was settled - acceptance or refusal established. Not when a
  -- recipient's mail server later emitted a delivery event.
  completed_at TEXT,
  provider_job_id TEXT,

  -- Scheduling and mutual exclusion belong to the attempt, not the message: a
  -- resend has its own retry budget, its own lease sequence and its own
  -- reconciliation cadence. See "Where the lease lives" - this choice is what
  -- makes worker quiescence mandatory rather than optional.
  send_try_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,

  -- NULL means acceptance or refusal is NOT ESTABLISHED - in flight, or
  -- ambiguous and unsettled. Settling is monotone and one-way; once non-NULL
  -- the row is immutable.
  --
  --   NULL -> ACCEPTED       provider accepted this send
  --   NULL -> KNOWN_FAILED   a response refused it
  --
  -- There is deliberately no UNRESOLVED here. An unresolved send is one whose
  -- outcome was never established, and later provider evidence may still settle
  -- it - which an immutable terminal UNRESOLVED would forbid. Ambiguity is a
  -- message-level fact and 0039 already models it there.
  --
  -- ACCEPTED, not DELIVERED: this records whether the provider accepted THIS
  -- SEND, knowable when the attempt ends. Whether anyone received it is decided
  -- later by provider events and belongs to the message. Naming it DELIVERED
  -- would repeat the conflation 0039 removed and force a terminal attempt to be
  -- rewritten when a bounce arrives.
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ACCEPTED', 'KNOWN_FAILED')),
  failure_code TEXT,
  failure_detail TEXT,
  -- Automatic reconciliation budget spent. Scheduling metadata, never evidence:
  -- it must not settle `outcome`, and no elapsed time may either.
  reconciliation_exhausted_at TEXT,

  UNIQUE (message_id, attempt_no)
);

-- At most one attempt in flight per message. This is what makes B5 impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX outbox_attempt_active_unique
  ON outbox_attempt(message_id) WHERE outcome IS NULL;

CREATE INDEX outbox_attempt_message_idx ON outbox_attempt(message_id, attempt_no);
```

Immutability of a *settled* attempt is enforced the way 0039 enforced its
biconditional — a `BEFORE UPDATE` trigger that aborts when `OLD.outcome IS NOT
NULL`, since SQLite cannot express it as a constraint. An unsettled attempt
stays mutable precisely so later evidence can settle it.

### The consequence worth noticing

Dropping `UNRESOLVED` from the attempt makes the resend rule structural rather
than merely asserted. A message that is `FAILED + UNRESOLVED` has an attempt
whose `outcome IS NULL`, and that attempt occupies the one active slot:

```text
CREATE UNIQUE INDEX outbox_attempt_active_unique
  ON outbox_attempt(message_id) WHERE outcome IS NULL;
```

So no resend attempt can be inserted beside it. The invariant that mattered most
in this whole design —

```text
FAILED + UNRESOLVED   no resend, ever
```

— stops depending on a check inside the transaction and becomes a thing the
database cannot represent. The `KNOWN_FAILED` assert stays as defence in depth,
but it is no longer the only thing standing between an unresolved send and a
duplicate email.

## Column ownership

Every per-attempt column on `email_outbox` gets an explicit destination. "Frozen"
means still present, no longer written, read by nothing, droppable later.

| Legacy column | Destination | Why |
|---|---|---|
| `attempts` | → `outbox_attempt.send_try_count` | A resend gets its own budget. Carrying one counter across attempts would let attempt #1's exhaustion truncate attempt #2. |
| `next_attempt_at` | → `outbox_attempt.next_retry_at` | Backoff is per attempt for the same reason. |
| `lease_owner` | → `outbox_attempt.lease_owner` | See "Where the lease lives" — this one is load-bearing for the cutover. |
| `lease_expires_at` | → `outbox_attempt.lease_expires_at` | As above. |
| `provider_idempotence_key` | → `outbox_attempt.provider_idempotence_key`, with the legacy column kept as a write-once **compatibility shadow** | Stable within an attempt, distinct across attempts. Attempt #1 carries the same value, so today's replay protection is preserved exactly. The legacy column stays `NOT NULL UNIQUE` and must still be filled at insert; it is never updated and never authoritative. See "Creating attempt #1". |
| `job_id` | → `outbox_attempt.provider_job_id` | Provider identity is per send. |
| `send_started_at` | → `outbox_attempt.started_at` | Per send. |
| `provider_request_started_at` | → `outbox_attempt.provider_request_started_at` | Per send. |
| `last_error` | → `outbox_attempt.failure_code` | Per send, and it is the discriminator 0039 classifies on. |
| `provider_error_code` | → `outbox_attempt.failure_detail` (with `provider_error_message`) | Per send. |
| `provider_error_message` | → `outbox_attempt.failure_detail` | Per send. |
| `status` | stays on the message | Message lifecycle, not attempt state. |
| `delivery_outcome` | stays on the message | Message-level truth; 0039's biconditional continues to hold against `status`. |
| `sent_at`, `delivered_at`, `bounced_at` | stay on the message | Delivery events are facts about the message, arriving after an attempt has closed. This is the same separation as `ACCEPTED` vs `DELIVERED`. |
| `suppressed_at`, `superseded_at`, `superseded_reason` | stay on the message | Consent and supersession are message-level and must survive every attempt. |
| `ops_acknowledged_at`, `ops_acknowledged_reason` | stay on the message | An operator acknowledges the message needing attention, not one send. |

Nothing is left implicit: if a column is not in this table, it is message
identity (`recipient_email`, `template`, `payload_snapshot`, …) and is untouched.

## Where the lease lives

Putting `lease_owner` / `lease_expires_at` on the attempt is semantically right —
a resend has its own lease sequence — but it has a consequence that decides the
whole rollout, and it is not the obvious one.

**Mutual exclusion between workers is enforced by contention on a single row.**
An old worker leases on `email_outbox`; a new worker would lease on
`outbox_attempt`. Two different lease stores means no contention at all:

```text
old worker   UPDATE email_outbox SET lease_owner = ... WHERE lease_owner IS NULL
new worker   UPDATE outbox_attempt SET lease_owner = ... WHERE lease_owner IS NULL

both succeed
both send
```

That is a **double send to a real recipient**, which is materially worse than
the stale-snapshot problem it was found next to. Staleness corrupts a record;
this delivers a second email.

So the choice is forced and should be stated plainly: either the lease stays
message-level, or the old and new workers must never run at once. Attempt-level
leases are the better long-term model, so this design takes the second branch
and treats worker quiescence as **mandatory**, not as a convenience.

## Authority cutover

Stopping the worker is necessary and **not sufficient**. The worker is not the
only writer of attempt facts.

`POST /v1/webhooks/unisender` (`api.ts:204`) reaches `applyUnisenderDelivery()`
and then `applyEmailObservation()`, which writes `status`, `delivery_outcome`,
`job_id`, `lease_owner`, `lease_expires_at` and `next_attempt_at` on
`email_outbox`. That path is driven by the provider, runs in the API process,
and is entirely independent of worker sweeps:

```text
worker stopped, backfill done
        ↓
provider callback arrives
        ↓
API writes legacy attempt facts
        ↓
outbox_attempt is stale at birth
```

Shutting the API off instead is not an option — callbacks would be lost, and the
release machinery deliberately keeps the API answering throughout a cutover.

### A durable authority selector, enforced by the database

The cutover is a state change in the database, not an orchestration window:

```text
attempt_authority       LEGACY | ATTEMPT
worker_sweeps_paused    0 | 1
revision                N            -- CAS token
```

**A selector alone is not enough, and this is the crux.** The worker binary in
production today never reads it: it wakes every 30 seconds unconditionally. So

```text
worker_sweeps_paused = 1, no lease_owner set, nothing in SENDING
```

proves only that the *last* sweep drained. An old, idle worker can wake after
the CAS and claim again. Draining is not exclusion.

The pause therefore has to be enforced where the old binary cannot avoid it. Its
claim is a single recognisable transition at the provider boundary
(`domain.ts:2384`) — it moves `PENDING`/`SEND_UNKNOWN` to `SENDING`, takes the
lease and increments `attempts`, all before calling the provider:

```sql
CREATE TRIGGER email_outbox_dispatch_pause_guard
BEFORE UPDATE ON email_outbox
WHEN (SELECT worker_sweeps_paused FROM outbox_authority WHERE singleton = 1) = 1
 AND OLD.status IN ('PENDING', 'SEND_UNKNOWN')
 AND NEW.status = 'SENDING'
BEGIN
  SELECT RAISE(ABORT, 'EMAIL_DISPATCH_PAUSED');
END;
```

A binary that has never heard of the selector now obeys it. That splits the two
proofs cleanly, and only one of them was previously available:

```text
no leases, nothing in SENDING     drain proof      (the last sweep finished)
dispatch pause trigger            exclusion proof  (no future sweep can start)
```

The second permanent guard freezes legacy attempt facts once authority moves:

```sql
-- Rejects any UPDATE that changes a legacy attempt column while
-- attempt_authority = 'ATTEMPT'.
```

This is deliberately a database guard rather than a concurrency test.
`email_outbox` has **21** distinct `UPDATE` sites — claim, settle, ambiguous
deferral, exhaustion, supersession, suppression, webhook projection — and a
forgotten twenty-second path must fail closed rather than silently write to a
store nobody reads. That is precisely how 0039's trigger caught the
parameter-bound write that source review had missed.

### Activation

```text
authority = LEGACY, dispatch paused and enforced, drained

BEGIN IMMEDIATE
  backfill attempt #1 for every message from its legacy columns
  assert every message that needs one has exactly one attempt
  CAS attempt_authority LEGACY -> ATTEMPT at revision N
COMMIT

authority = ATTEMPT
```

`BEGIN IMMEDIATE` serializes a callback against the backfill:

```text
callback commits BEFORE   its write is legacy, and the backfill reads it
callback commits AFTER    it reads ATTEMPT and writes the attempt row
```

**That proof holds only if the selector read and the projection write happen in
the same `BEGIN IMMEDIATE` transaction.** A selector cached in process memory, or
read before the transaction opens, reintroduces exactly the interleaving the
serialization was meant to remove. The Unisender callback already runs inside
`withImmediateTransaction`, so this is a property to preserve rather than build —
but it is the actual reason the argument works, so it is stated here rather than
assumed.

**`activate` is therefore defined durably**, not as a sequence of steps:

```text
activate = atomic backfill + authority CAS LEGACY -> ATTEMPT
```

which also makes replay obvious: a crashed activation either committed or did
not, and re-running reads the selector to decide.

The worker resumes only once the attempt-aware build is proven deployed — that
part is still required, because it is what prevents the split lease.

### Shapes considered

| Shape | Verdict |
|---|---|
| **Durable selector + paused worker + atomic activation** | **Chosen.** Covers every writer, needs no API downtime, no dual-write phase, and gives crash-replay a single durable fact to read. |
| Quiesce the worker only | Rejected. Necessary but not sufficient — the webhook keeps writing. |
| Compatibility phase writing both stores | Rejected. Requires the old runtime to know the new table, and does not address the split lease. |
| Lazy materialization on first touch | Rejected. Removes the stale snapshot but leaves two workers holding two lease stores. |

### The seam to prove

> After the authority CAS commits, no writer may write a legacy attempt fact.

Two independent connections, in the style of
`commerce/test/support/concurrency-fixture.ts`: one impersonating a provider
callback, one performing the activation, interleaved in both orders. A
source-level assertion would not be proof — the parameter-bound write that source
review missed in 0039, and that only the database trigger caught, is exactly the
failure mode here.

### Preventing the next one

The old worker cannot be taught to stand aside for 0040; it is already deployed.
Every later build can be, cheaply — and the assertion should be a set
comparison, not a head comparison, because `schema_migrations` already stores
the applied versions as a set and the release machinery hashes the whole sorted
inventory rather than trusting one filename:

```text
applied_migration_versions  ⊆  build_known_migration_versions
```

If `applied − known` is non-empty, refuse to sweep and name the unknown
versions. "Head is newer" is another proxy of the kind this programme keeps
finding to be subtly wrong.

## Creating attempt #1

The design says the attempt table is authoritative from creation and the legacy
columns are read by nothing. Both cannot be true if attempts are minted at claim
time, because `email_outbox.provider_idempotence_key` is `NOT NULL UNIQUE`
(`0001_initial.sql:284`, rebuilt in `0012`), so every brand-new message after the
CAS must still populate a legacy column — and until claim, that column is the
only key the message has.

So initial send and resend are made **symmetrical**, and attempt #1 is created
with the message:

```text
enqueue                          manual resend
BEGIN IMMEDIATE                  BEGIN IMMEDIATE
  INSERT email_outbox              assert FAILED + KNOWN_FAILED, revision
  INSERT outbox_attempt #1         INSERT outbox_attempt #N
COMMIT                             INSERT audit row
                                   re-arm message, clear delivery_outcome
                                 COMMIT
```

The worker then **claims an existing attempt** instead of creating one, which is
what makes "authoritative from creation" literally true rather than nearly true.

`email_outbox.provider_idempotence_key` receives attempt #1's key at insert as a
**compatibility shadow** required by the old schema. It is written once, never
updated, and never read as authority. That is a narrower and more honest claim
than "read by nothing", and it is the one the schema can actually support until
the column is dropped.

This also removes a crash boundary rather than adding one: with claim-time
creation there is a window where a message is committed and has no attempt, and
every reader would need a rule for it. Creating both in one transaction means
that state cannot exist.

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
| Only a known failure may be resent | Structural: an unsettled attempt (`outcome IS NULL`) holds the one active slot, so no attempt can be inserted beside it. The `KNOWN_FAILED` assert inside the transaction remains as defence in depth. |
| A terminal attempt is never modified | `BEFORE UPDATE` trigger on `OLD.outcome IS NOT NULL` |
| Resend creates a new attempt number | `UNIQUE(message_id, attempt_no)` |
| At most one active attempt | partial unique index on `outcome IS NULL` |
| A new attempt never reuses a provider key | `UNIQUE` on the key column; keys are opaque and freshly minted per attempt |
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
2. migration 0040 - outbox authority control:
     selector (attempt_authority, worker_sweeps_paused, revision)
     DB-enforced dispatch pause trigger
     legacy-attempt freeze guard, inert until authority = ATTEMPT
3. forward guard: refuse to sweep when applied migrations are not a subset of known
4. migration 0041 - outbox_attempt schema and immutability trigger, no backfill
5. every attempt-fact writer reads the selector inside its own transaction
   (worker claim AND webhook projection), and enqueue creates attempt #1
6. pause -> drain -> deploy attempt-aware writers ->
   activate (atomic backfill + CAS) -> resume
7. audited resend command, transaction exactly as B4 above
8. admin surface
9. provider crash and replay tests
```

The split into 0040 and 0041 is not cosmetic. 0040 carries no new lease store
and no attempt table; its whole purpose is to retrofit a hard fence onto the
worker **already running in production**, before anything else changes. Only once
that fence exists and is proven can a new authority be introduced at all.

Until the moment authority changes hands is both defined and enforceable against
binaries that have never heard of it, a perfectly correct new table can begin
life stale - or worse, can let two workers with two lease stores each believe
they hold exclusive claim on the same message.

The resend endpoint is last on purpose. Once a button exists, accidental
duplicate delivery becomes a production risk before the durability model is
ready to prevent it.
