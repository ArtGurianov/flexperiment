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

### The pre-launch discriminators

`orders.reward_authority_kind`, `referral_rewards.reward_authority_kind` and
`reward_settlements.settlement_flow` go, and every guard whose condition names
them is restated unconditionally. Two guards retire with them outright, because
the column is their entire subject; the rest freeze or relate a dozen columns of
which the discriminator is one, and lose only their condition.

`agent_referrals_feature_state` loses `DORMANT` from its CHECK, and the baseline
seeds `ACTIVE`.

### A correction to the plan

The plan lists `email_outbox.authority` among the removals. **It is already
gone** - a later migration rebuilt the table without it. All twenty-nine of the
table's remaining columns are named somewhere in the runtime, so which of them
are genuinely frozen needs a write-versus-read analysis rather than a name scan;
that analysis is the one piece of removal work this specification does not yet
decide.

## Additions

| Object | Purpose |
|---|---|
| `schema_identity` | The singleton that makes lineage answerable before anything trusts the database. Absent means legacy; unknown means unknown; both fail closed. |
| `deploy_sessions` | Session state and the deployment gate as one row, so that a `SUCCEEDED` session with sales still shut is unrepresentable. |
| `certification_capabilities`, `certification_runs` | Storage for what P7 proved: a one-shot capability spent in the same transaction as the order it admits, and a revisioned run that only one runner can advance. |
| `orders.certification_run_id` | The only certification discriminator. `NULL` is an ordinary order; not null is a certification order. No `order_purpose`: a second column with one meaningful value is the kind of monument this change removes. |
| `runtime_instance_evidence` | Evidence per instance rather than per unit, so readiness can tell a converged runtime from an old one that has not stopped. |

## Coupled removals

Three places where code and schema have to move together, because the schema
enforces what the code currently humours:

| Coupling | Today | In the baseline |
|---|---|---|
| Feature state `DORMANT` | The CHECK admits it and the dev row is it | The member goes, the CHECK narrows, the seed is `ACTIVE` |
| Discriminator partitions | Triggers check the partition on insert | The column goes and the triggers become unconditional |
| Outbox attempt authority | The frozen columns remain | Decided by the write/read analysis above |

## What the baseline is not

It is not a place to encode future fields "for later". The freeze rule that
governed P2–P8 still applies in the other direction: a column that nothing
writes on the day the baseline ships is a column that will be explained away
for a year.
