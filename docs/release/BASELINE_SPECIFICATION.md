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
| Columns | 1,145 |
| Triggers | 156 |
| Indexes | 279 |

Everything below is measured against that schema - the one the migrations
actually produce - rather than against what any individual migration says.

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
`reward_settlements.settlement_flow` go, and every guard whose condition names
them is restated unconditionally. Two guards retire with them outright, because
the column is their entire subject; the rest freeze or relate a dozen columns of
which the discriminator is one, and lose only their condition.

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
| `provider_idempotence_key` | yes, at enqueue | attempt #1 copies it byte for byte | **keep** |
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
| `certification_capabilities` | At most one live capability per deployment session, as a partial unique index. Bound to run, session, release and an amount ceiling. Consumed once, by a guarded update inside the checkout's own transaction. |
| `certification_runs` | Revision compare-and-set on every write. Phase and cleanup direction monotonic, as CHECKs. Release immutable. Failure write-once. |
| `runtime_instance_evidence` | Keyed by instance, carrying unit, source commit, start, heartbeat and last successful sweep. A second row for the same unit is expected, not a conflict - that is the whole reason it replaces the singleton. |

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
| Outbox attempt authority | Ten frozen columns remain, one of them read | They go; `emailDispatchDrained` loses its dead term and `sendTryCount` its vestigial parameter |

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
in the runtime, fifty-three files mentioning the word. `partner_identities`
stays a separate table - authentication and personal data are a different
bounded concept from the operational partner, and a one-to-one relationship
does not make them one thing.

## What the baseline is not

It is not a place to encode future fields "for later". The freeze rule that
governed P2–P8 still applies in the other direction: a column that nothing
writes on the day the baseline ships is a column that will be explained away
for a year.
