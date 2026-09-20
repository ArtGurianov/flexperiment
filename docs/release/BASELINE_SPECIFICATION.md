# The launch baseline, specified

`0001_launch_baseline.sql` is written from this document, not transcribed from
the ledger it replaces. The difference matters: a baseline assembled by
concatenating sixty-one migrations would carry every compromise those
migrations were forced into, and the point of replacing them is that none of
those compromises is owed anything.

This is the specification. It is written before the SQL because the SQL is long
and a defect in it is the most expensive defect in the whole change - a silently
dropped trigger, index or CHECK is something only a line-by-line object diff
would catch, and only if someone knew to look for it.

## What was measured

The current ledger produces:

| | |
|---|---:|
| Tables | 112 |
| Columns | 1,146 |
| Foreign keys | 219 |
| Triggers | 156 |
| Indexes, explicitly created | 87 |
| Indexes, implied by `PRIMARY KEY` / `UNIQUE` | 192 |

Everything below is measured against that schema - the one the migrations
actually produce - rather than against what any individual migration says.

The index split matters for the review. An earlier revision of this document
said "279 indexes", which is what `sqlite_master` reports and is misleading:
192 of those are created by SQLite itself to back a `PRIMARY KEY` or a
`UNIQUE`, and only 87 are written by hand. A baseline that declares the same
constraints produces the same 192 without anyone typing them, so the number to
compare when reviewing is 87 - while the artifact still prints all 279, because
a lost `UNIQUE` shows up there as a missing implied index.

The artifact is produced by `scripts/release/schema-inventory.ts`, which prints
every object grouped under the table it belongs to, in a stable order, with
partial-index predicates and trigger bodies normalised. It runs against the
ledger or against a single SQL file, so the baseline is reviewed by diffing one
against the other rather than by reading either.

## Acceptance criteria

These hold from the first draft of the baseline, not as later repairs.

1. **The settlement tax snapshot is frozen.** `tax_treatment_revision_id_snapshot`,
   `tax_canonicalization_version`, `tax_canonical_json` and `tax_canonical_hash`
   join the settlement authority immutability guard. Today they do not: the tuple
   guard validates them on insert and nothing stops a `PREPARED` settlement's
   `tax_canonical_hash` being rewritten, which was confirmed by running it. The
   payment and ORD paths consume that snapshot as though settlement froze it.
2. **The review artifact is an object inventory, not sorted DDL text.**
   `sqlite_schema(type, name, tbl_name, sql)` plus `table_info`, `foreign_key_list`,
   `index_list`/`index_info` and triggers, grouped by table, with an explicit
   allowlist of intended deltas. A lost partial unique index has to be its own
   line in a diff, not one line among thousands.
3. **`PRAGMA foreign_key_check` is empty**, and a database built from the single
   baseline stands up.
4. **The archived pre-launch database is rejected** by the new runtime with
   `LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED`, proved against the real old file.
5. **No migration test is deleted without showing where its non-migration
   invariants live** in the baseline and the steady-state suite. The invariant
   registry names them; the gate is per file.

## Removals

### Tables the runtime no longer references at all

Seven, and each for a stated reason rather than because a scan found them.

| Table | Why |
|---|---|
| `release_sales_gate` | The release controller's own gate. Its successor is the deploy session, which owns state and fence together. |
| `release_sales_gate_events` | Its audit trail. |
| `release_certification_allowlist` | The old certification mechanism, replaced by a scoped one-shot capability in P7. |
| `runtime_release_evidence` | A singleton row per unit, which cannot distinguish a fresh instance from an old one still running - the exact thing readiness has to distinguish. Replaced, not dropped: see below. |
| `reward_settlement_idempotency` | Superseded by `reward_settlement_command_idempotency`, which is the one the runtime writes. |
| `reward_adjustments` | No reference in the runtime. |
| `settlement_prepared_reviews` | No reference in the runtime. |

**Dependency proof.** "The runtime does not name it" and "nothing depends on it"
are different claims, and P8 taught that the difference matters. Checked against
the schema the migrations produce: every one of the seven has **no inbound
foreign key and is referenced by no surviving trigger or view**. Two of them
name a successor rather than simply going - `runtime_release_evidence` is
replaced by `runtime_instance_evidence`, and `reward_settlement_idempotency` by
`reward_settlement_command_idempotency`, which is the one the runtime writes.
The rest have no successor by design.

### The pre-launch discriminators

`orders.reward_authority_kind`, `referral_rewards.reward_authority_kind` and
`reward_settlements.settlement_flow` go. Two guards retire with them outright,
because the column is their entire subject. Most of the rest freeze or relate a
dozen columns of which the discriminator is one, and lose only that conjunct.

**The two tuple guards are the exception, and they do not restate the same
way.** Implementation showed that "unconditionally" is right for one and wrong
for the other, and the difference is not a detail:

- `reward_settlements`: a settlement without an engagement has no path to
  appear from a real business action on a clean database - it *is* the deleted
  slug model. Its arm is not restated, it is removed, and the engagement-scoped
  arm becomes the whole guard.
- `orders`: an ordinary order is a real thing, so an unconditional
  engagement-scoped guard would demand a partner on every sale. Both arms
  survive, keyed on `resolution_reason` (`DIRECT` / `DISCOUNT_PROMO` /
  `EXPLICIT_PARTNER_PROMO`), which the domain already decides and which says
  nothing about when a row was created. The direct arm is deliberately
  *stronger* than the `LEGACY` arm it replaces: it pins `attributed_agent_id`,
  `reward_type_snapshot` and `reward_value_snapshot` to null, so the deleted
  slug model becomes unrepresentable rather than merely unused.

The rule the baseline actually obeys is therefore not "restate every condition
unconditionally" but: **no surviving condition may mean "this row predates a
feature"**. Where the remaining branch is a real distinction in today's data, it
stays and is keyed on something today's domain decides.

`agent_referrals_feature_state` loses `DORMANT` from its CHECK, and the baseline
seeds `ACTIVE`.

### The outbox, decided

The plan lists `email_outbox.authority` among the removals. **It is already
gone** - a later migration rebuilt the table without it.

The eleven attempt-era columns were then classified by what the runtime does
with each, not by whether it names them. Being named is not being written, and
being read is not being relied on:

| Column | Written | Read | Verdict |
|---|---|---|---|
| `provider_idempotence_key` | yes, at enqueue | nothing reads it; see below | drop |
| `job_id` | never | nothing but a comment | drop |
| `lease_owner` | never | `emailDispatchDrained` counts it | drop, and simplify the reader |
| `lease_expires_at` | never | nothing but comments | drop |
| `send_started_at` | never | nothing | drop |
| `provider_request_started_at` | never | nothing | drop |
| `attempts` | never | passed to `sendTryCount`, which discards it | drop, with the vestigial parameter |
| `last_error` | never | nothing | drop |
| `provider_error_code` | never | nothing | drop |
| `provider_error_message` | never | nothing | drop |
| `next_attempt_at` | never | nothing | drop |

**All eleven go, including the provider key.** The code says why itself: under
LEGACY the message-level key was authoritative and the attempt held a shadow;
under ATTEMPT the attempt is authoritative and the message holds a "write-once
shadow". The baseline has no LEGACY, so the shadow has no reader - and it
already has none today. `claimForDispatch` takes
`{ id, provider_idempotence_key }` and refers to the second field zero times;
`providerLookupIdentity` takes `{ id, job_id, provider_idempotence_key }` and
refers to neither. Both resolve the authoritative identity from
`requireUnsettledAttempt`.

So the final shape is one key, minted once, in one place:

```text
email_outbox        no provider_idempotence_key
outbox_attempt #1   provider_idempotence_key, authoritative and unique

enqueue, one transaction:
  mint the key once
  insert the message
  insert attempt #1 carrying the key
```

and both signatures lose the fields they never read, so nothing can pass a
message-level key that looks significant and is not.

`lease_owner` is the one worth stating plainly. `emailDispatchDrained()` reports
`{ drained: sending === 0 && leased === 0 }`, and nothing has written
`lease_owner` since the attempt store took over - so `leased` is structurally
always zero and the conjunction has one live term. The function's answer is
correct, because a claimed message is set to `SENDING` and that half is live,
but it describes itself as two checks while performing one. That is the
corroboration rule from the deployment invariants, and the column's removal is
also the reader's repair.

### The outbox authority table, reshaped rather than removed

`outbox_authority` cannot simply go: the runtime still uses it as the durable
dispatch fence - `email_dispatch_paused`, its owner, its revision and its audit
events are an operator's stop on outgoing mail. What goes is its other half.
Attempt records are the only dispatch authority now, so in the baseline:

- the authority selector column disappears;
- the legacy-attempt freeze trigger disappears with the columns it froze;
- `AUTHORITY_ACTIVATED` stops being an audit action, because there is no second
  authority to activate.

`outbox_authority` becomes a fence, and nothing else.

## Additions

| Object | Purpose |
|---|---|
| `schema_identity` | The singleton that makes lineage answerable before anything trusts the database. Absent means legacy; unknown means unknown; both fail closed. |
| `deploy_sessions` | Session state and the deployment gate as one row, so that a `SUCCEEDED` session with sales still shut is unrepresentable. |
| `certification_capabilities`, `certification_runs` | Storage for what P7 proved: a one-shot capability spent in the same transaction as the order it admits, and a revisioned run that only one runner can advance. |
| `orders.certification_run_id` | The only certification discriminator. `NULL` is an ordinary order; not null is a certification order. No `order_purpose`: a second column with one meaningful value is the kind of monument this change removes. |
| `runtime_instance_evidence` | Evidence per instance rather than per unit, so readiness can tell a converged runtime from an old one that has not stopped. |

### The structural contract each one owes

Names are not a specification. What the baseline has to enforce:

| Object | Must hold structurally |
|---|---|
| `schema_identity` | Singleton. Carries the launch lineage exactly; its absence is what makes a pre-launch database legacy rather than unknown. |
| `deploy_sessions` | At most one non-terminal session. Owner and lease moved only by guarded update, so `changes === 1` is the proof of ownership. `adopted_cutover_id` unique, so a handoff is adopted once. The deployment gate's owning session lives in the same row, because a gate closed by a session that does not exist is the state this merge exists to forbid. |
| `certification_capabilities` | At most one capability occupying a session's slot, as a partial unique index over an explicit state - see below. Bound by foreign key to its run and its deployment session, and carrying the release and the amount ceiling. Consumed once, by a guarded update inside the checkout's own transaction. |
| `certification_runs` | Revision compare-and-set on every write, and separately a transition guard on every update - see below. |
| `runtime_instance_evidence` | Keyed by instance, carrying unit, source commit, start, heartbeat and last successful sweep. A second row for the same unit is expected, not a conflict - that is the whole reason it replaces the singleton. |

### The capability's slot has to be a stored fact

"One live capability per fence" is the rule, and P7 defines live as unconsumed
**and** unexpired. A partial unique index cannot express the second half: SQLite
evaluates the index predicate against the row, not against the clock, so

```sql
UNIQUE(deployment_session_id) WHERE consumed_at IS NULL
```

would let an expired, unconsumed capability block its own replacement forever -
and reissuing after expiry is exactly what P7 permits.

So the slot is materialised rather than computed. A capability carries both
`consumed_at` and `retired_at`, and occupies the slot while both are null:

```sql
UNIQUE(deployment_session_id) WHERE consumed_at IS NULL AND retired_at IS NULL
```

Reissuing after expiry retires the old capability and inserts the new one in one
transaction. This keeps "expired" and "spent" as different facts - which they
are, and which a single nullable column would blur - and it keeps the history,
because neither ending deletes the row.

### Monotonicity is a trigger's job, not a CHECK's

A row-level `CHECK` cannot see `OLD`. It can prove that a phase is one of the
phases and that a direction is one of the directions, and nothing more. The
properties that make a certification run an authority are all comparisons
against the previous row, so they belong to `BEFORE UPDATE` guards:

| Enforced by | Property |
|---|---|
| `CHECK` | phase, direction, kind and status are legal values |
| `BEFORE UPDATE` guard | `revision` advances by exactly one |
| | phase never moves backwards |
| | cleanup direction never moves backwards |
| | `release_sha`, `run_id` and `started_at` are immutable |
| | a recorded failure is never rewritten or cleared |
| The adapter's own statement | `UPDATE ... WHERE run_id = ? AND revision = ?`, where `changes === 1` is the proof this caller is the one that advanced it |

Compare-and-set and transition validation are different protections and the
baseline needs both: the first decides *who* wrote, the second decides *whether
that write was legal*.

### What neither authority may have rewritten underneath it

The adapters own which transitions are legal. What the schema owes is narrower
and harder to recover from if it is missing: a raw `UPDATE` must not be able to
rewrite the identity and the evidence those decisions are made from. A rollback
is chosen by reading `rollback_authority` and the archived database digest; if
either can be edited, the decision is made from a record rather than from a
fact.

**`deploy_sessions`.** Frozen after the session is acquired: `id`, `mode`,
`target_sha`, `created_at`, `candidate_id`, `adopted_cutover_id`,
`adopted_envelope_sha256`, `predecessor_database_ref`,
`predecessor_database_sha256` and **`pre_deploy_topology`**. One-way once
moved: `mutation_observed` from false, `rollback_authority` from
`OLD_LINEAGE_ALLOWED` to `NEW_LINEAGE_ONLY`, `bootstrap_rollback_id` from null
to a value, and a terminal state, which nothing leaves.

The topology snapshot belongs on that list for the same reason as the database
digest, and it is easy to miss because it looks like a reading rather than a
fact. `planResume` decides between a safe abort, a forced direction and proving
readiness by comparing what production serves now against that snapshot - so
anything able to edit it can make a production that moved look untouched, and
obtain a safe abort for a deploy that already changed something.
`observed_topology` is deliberately not frozen: it is the reading, and readings
are meant to be retaken.

**`certification_capabilities`.** Frozen for the life of the row: `id`,
`run_id`, `deployment_session_id`, `release_sha`, `max_amount_kopecks`,
`expires_at` and `nonce` - every one of them is part of the scope the
capability was issued within, and an editable scope is not a scope.
`consumed_at` and `retired_at` are each one-way, and mutually exclusive: a
capability is spent or replaced, never both, and a CHECK says so.

Retirement is only for a capability that was never spent, and only where
reissue is permitted - after expiry, **and a trigger has to say so**. Retiring
is what frees the slot, so without that guard a raw `UPDATE` could retire a
live capability early and issue a second one beside it - defeating the partial
index rather than passing it. `retired_at` and `expires_at` are both
`toISOString()`, so they are fixed width, UTC, and compare correctly as text.

And because the slot is now a stored fact rather than a computed one,
**`authorizationDefect()` gains a retired case**: without it, retiring a capability would free the index slot while the
old row, still unconsumed, would go on satisfying P7's own predicate. That is
a code change the baseline brings with it, not a schema detail.

### A run's recovery evidence is written once

`certification_runs` needs the same treatment, and for a sharper reason. The
recovery planner does not reconstruct what to do: it returns the stored
`pending_command`, and the machine re-issues that command with the saved
idempotency key, the saved expected revision and the saved request digest,
deriving nothing from what production looks like now. That is the property that
makes an interrupted run safe to resume - and it means the stored command *is*
the external effect a recovery will perform.

So the schema fixes what an adapter is not asked to police:

```text
pending_command
  NULL    -> command    arming, which the adapter decides
  command -> NULL       settling or retiring, likewise
  command -> command    refused, structurally

superseded_command
  NULL -> value, once; never rewritten, never cleared
```

Replacing one armed command with another is the case worth naming: it is not a
state the adapter has a transition for, it changes what a later resume will
send to the outside world, and nothing else in the system would notice.

The same rule covers the identifiers of things that already exist, because
recovery follows them to find real objects to cancel, refund and verify:

`occurrence_id`, `quote_id`, `status_id`, `order_id`, `payment_id`,
`booking_id`, `ticket_id`, `refund_obligation_id`, `refund_id`,
`human_ticket_verified_at`, `completed_at`.

Each may go from null to a value once, and after that may be neither replaced
nor cleared. Rewriting `order_id` or `booking_id` would not corrupt anything the
run can detect - it would simply send the recovery, working correctly, at a
different customer's purchase.

The boundary is unchanged: **the adapter decides when a field may be set, and
the schema refuses to let a fact already written be rewritten.**

### The dispatch fence's owner is a deploy session

`(release_id, generation)` is not dead weight: `sameEpoch` uses it to stop a
second controller unfencing in the middle of the first one's migration, so it
cannot simply be dropped. But `generation` is the release-generation model this
change dismantles, and `Domain` already states that the fence belongs to
release control rather than to an operator's business surface. With
`deploy_sessions` in the schema the successor is the session itself:

```text
outbox_authority.dispatch_owner_release_id + dispatch_owner_generation
    -> dispatch_owner_session_id  REFERENCES deploy_sessions(id)
outbox_authority_events.owner_release_id + owner_generation
    -> owner_session_id           REFERENCES deploy_sessions(id)
```

Ownership is now a real foreign key rather than a pair of free strings, and the
epoch concept disappears rather than being preserved in a new place. If an
independent manual mail fence is ever wanted, it deserves its own explicit
authority - not a legacy epoch shape kept alive in case.

### The bindings are foreign keys, not conventions

```text
certification_capabilities.run_id                → certification_runs.run_id
certification_capabilities.deployment_session_id → deploy_sessions.id
orders.certification_run_id                      → certification_runs.run_id
```

**Where the certification replay binding lives.** P7's admission contract needs a
permanent record that a checkout key already created an order, resolved before
anything is spent. That record already exists: `checkout_idempotency`
(`idempotency_key_hash`, `canonical_request_hash`, `order_id`) is the permanent
ledger, and `orders.certification_run_id` is what ties the order it names back
to the run. No third table.

## Coupled removals

Three places where code and schema have to move together, because the schema
enforces what the code currently humours:

| Coupling | Today | In the baseline |
|---|---|---|
| Feature state `DORMANT` | The CHECK admits it and the dev row is it | The member goes, the CHECK narrows, the seed is `ACTIVE` |
| Discriminator partitions | Triggers check the partition on insert | The column goes and the triggers become unconditional |
| Partner reward defaults | `createAgent` writes `'PERCENT', 0`; nothing reads them back, because a reward is decided by the engagement revision that authorises it | `partners.default_reward_type` and `default_reward_value` go, and `createAgent` stops naming them. Both columns are `NOT NULL` with no default, so the code half cannot land before the schema half - this is exactly the coupling the "nullable?" column of the schema-debt list exists for |
| Outbox attempt authority | Eleven message-level columns remain, one of them read | They go; `emailDispatchDrained` loses its dead term, and `sendTryCount`, `claimForDispatch` and `providerLookupIdentity` lose the parameters they never read |

### `agents` becomes `partners`

The rename is kept, and the baseline is the only cheap moment for it: there is
no data to migrate and one file defines the table.

It is also overdue in a way the current schema shows plainly. Fourteen foreign
keys point at `agents`, and four of them are already named for what the table
actually holds - `orders.resolved_partner_id`,
`partner_promos.partner_id`, `engagement_promo_authorizations.partner_id`,
`engagement_creative_revisions.partner_id`. A column called `partner_id`
referencing a table called `agents` is the confusion this removes.

The cost is bounded and measured: fourteen foreign keys, fifteen SQL statements
in the runtime, fifty-three files mentioning the word. Thirteen of the fourteen
are repointed; the fourteenth was `reward_adjustments.agent_id`, and it leaves
with its table. `partner_identities`
stays a separate table - authentication and personal data are a different
bounded concept from the operational partner, and a one-to-one relationship
does not make them one thing.

## Genesis, and what is not genesis

The baseline creates the zero state of the schema itself: `schema_identity`,
the `outbox_authority`, `emergency_sales_gate` and
`unisender_event_dump_control` singletons, `agent_referrals_feature_state` at
`ACTIVE`, and the two immutable advertising policy tables (nine channels, ten
formats - and the reporting basis genuinely differs per format, so a uniform
seed would be wrong). Each is a row whose absence a runtime reads as *fail
closed* rather than as *empty*: dispatch stays fenced, the ORD path has no
policy to resolve against, and lineage is unanswerable.

The catalogue is **not** here. Cities, occurrences and operational settings
belong to `launch-seed.ts`, which runs against a database this file has already
made trustworthy. The legal release is not seeded at all - it is republished
through `commerce:legal-release:publish`, so the publication ledger is real.

## What the baseline is not

It is not a place to encode future fields "for later". The freeze rule that
governed P2–P8 still applies in the other direction: a column that nothing
writes on the day the baseline ships is a column that will be explained away
for a year.
