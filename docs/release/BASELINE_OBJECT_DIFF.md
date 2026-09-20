# The baseline, object by object

The review artifact for `0001_launch_baseline.sql`. A textual diff of two schema
dumps cannot carry this review: an identical `column id TEXT PK(1)` line belongs
to a different table in each file, and a lost trigger is one line among
thousands. This is the structured delta instead, with every intentional change
named. Anything in the delta that is not on this list is a defect.

## Reproducing it

```sh
git show <parent>:commerce/migrations | ...        # the ledger, 61 files
npx tsx scripts/release/schema-inventory.ts ledger > /tmp/ledger-inventory.txt
npx tsx scripts/release/schema-inventory.ts commerce/baseline/0001_launch_baseline.sql > /tmp/baseline-inventory.txt
npx tsx scripts/release/schema-delta.ts /tmp/ledger-inventory.txt /tmp/baseline-inventory.txt
```

The generator was proved faithful before any delta was applied: a database built
from the dumped effective schema is object-for-object identical to the
61-migration database. Every group below was then applied and re-diffed on its
own, which is the only reason each one is reviewable in isolation.

```
SUMMARY tables -8 +6; objects -65 +40
```

## 1. Removals with no successor

Seven tables, each proved to have no inbound foreign key and no surviving
trigger or view naming it.

| Table | Note |
|---|---|
| `release_sales_gate`, `release_sales_gate_events` | The gate now lives in `deploy_sessions`. |
| `release_certification_allowlist` | Replaced by `certification_capabilities`. |
| `runtime_release_evidence` | Replaced by `runtime_instance_evidence`. |
| `reward_settlement_idempotency` | Replaced by `reward_settlement_command_idempotency`, which is the one the runtime writes. |
| `reward_adjustments`, `settlement_prepared_reviews` | No successor by design. |

## 2. The outbox attempt columns

Eleven columns leave `email_outbox`: `provider_idempotence_key`, `job_id`,
`lease_owner`, `lease_expires_at`, `send_started_at`,
`provider_request_started_at`, `attempts`, `last_error`, `provider_error_code`,
`provider_error_message`, `next_attempt_at`.

With them go `email_outbox_legacy_attempt_freeze_guard` (it froze exactly these
columns), `email_outbox_send_unknown_due_idx` (its predicate reads
`next_attempt_at`) and `sqlite_autoindex_email_outbox_2` (the inline UNIQUE on
`provider_idempotence_key`).

`lease_owner` is the one to check twice: it has **no writer**, so
`emailDispatchDrained()`'s `leased` term is structurally always zero and the
conjunction has one live term. Removing the column is also the repair.

## 3. The pre-launch discriminators

`orders.reward_authority_kind`, `referral_rewards.reward_authority_kind` and
`reward_settlements.settlement_flow` go, with their CHECKs.

**The two tuple guards do not restate the same way, and that is the point.**

- `orders_authority_tuple_consistency_guard` keeps both arms and keys them on
  `resolution_reason`, which the domain already decides
  (`DIRECT` / `DISCOUNT_PROMO` / `EXPLICIT_PARTNER_PROMO`) and which carries no
  lineage meaning. An ordinary order is a real thing on a clean database. The
  direct arm is also **stronger** than the `LEGACY` arm it replaces: it pins
  `attributed_agent_id`, `reward_type_snapshot` and `reward_value_snapshot` to
  null, which makes the deleted slug model unrepresentable rather than merely
  unused.
- `reward_settlements_authority_tuple_consistency_guard` loses its first arm
  outright. A settlement without an engagement *is* the deleted slug model - it
  has no path to appear from a real business action - so the engagement-scoped
  arm becomes the whole guard.

`resolution_reason` loses its `DEFAULT 'LEGACY'` and gains a CHECK naming the
three live values.

Two triggers retire outright, because the column was their entire subject:
`referral_rewards_authority_kind_matches_order_guard`,
`referral_rewards_authority_kind_immutable_guard`.

Thirteen more lose only their condition, mechanically:
`orders_authority_columns_immutable_guard`,
`reward_settlements_authority_columns_immutable_guard`,
`reward_settlements_agent_referrals_status_transition_guard`,
`reward_settlements_agent_referrals_terminal_immutable_guard`,
`reward_settlements_contractor_type_projection_guard`,
`engagement_effective_reward_snapshots_no_correction_during_live_payment_guard`,
`settlement_acts_relational_consistency_guard`,
`payment_authorizations_relational_consistency_guard`,
`engagement_zero_reward_closures_relational_consistency_guard`,
`engagement_recovery_exposure_evidence_relational_consistency_guard`,
`ord_distribution_period_reports_relational_consistency_guard`,
`ord_paid_invoice_payloads_relational_consistency_guard`.

## 4. `DORMANT`

`agent_referrals_feature_state.state` loses the member and the
`DEFAULT 'DORMANT'` - a default is what made it the implicit genesis - and the
CHECK narrows to `ACTIVE`/`SUSPENDED`. The baseline seeds `ACTIVE`.
`agent_referrals_feature_state_events_lineage_guard` drops the `DORMANT → ACTIVE`
transition and names `ACTIVE` as the genesis the seed actually writes.

## 5. The outbox authority becomes a fence

`outbox_authority.attempt_authority` and its CHECK go.
`outbox_authority_events.action` narrows to `DISPATCH_FENCED` /
`DISPATCH_UNFENCED`: with no second authority, `AUTHORITY_ACTIVATED` is not an
action anything can take. The paused bit, its owner, its revision and the audit
trail are untouched.

## 6. `agents` becomes `partners`

One table renamed; thirteen foreign keys repointed
(`orders.attributed_agent_id`, `orders.resolved_partner_id`,
`orders.promo_agent_id_snapshot`, `quotes.attributed_agent_id`,
`quotes.promo_agent_id_snapshot`, `promo_codes.agent_id`,
`referral_rewards.agent_id`, `reward_settlements.agent_id`,
`partner_identities.agent_id`,
`agent_referrals_legal_profile_revisions.agent_id`, `partner_promos.partner_id`,
`engagement_promo_authorizations.partner_id`,
`engagement_creative_revisions.partner_id`).

The specification measured **fourteen**; thirteen are repointed. The fourteenth
was `reward_adjustments.agent_id`, and it leaves with its table in group 1.
Both documents now say so.

The `agent_id` **columns keep their names**. Renaming them is a separate change
with a separate cost, and it is not what made the table's name wrong.

`default_reward_type` and `default_reward_value` do not survive the rename.
`createAgent` writes `'PERCENT', 0` and nothing reads them back - a reward is
decided by the engagement revision that authorises it. Both are `NOT NULL` with
no default, so **the code half cannot land in this batch**: narrowing the
`INSERT` while the ledger is still the live schema breaks `createAgent` against
it. The probe is in the report; the two halves move together in the swap.

## 7. The additions

Five tables and one column, plus the ledger table the runtime keeps for `0002`
onward.

| Object | Structural contract, proved by probe |
|---|---|
| `schema_identity` | Singleton; `lineage` CHECKed to the launch value; no UPDATE, no DELETE. |
| `deploy_sessions` | At most one non-terminal session (partial unique index). `pre_deploy_topology` is `NOT NULL`: both entry points take it as a required argument, so a session without the snapshot a safe abort is decided from cannot exist. A terminal state with the gate shut, a `ROLLING_SAFE` session with the gate shut, `SAFE_ABORTED` beside an observed mutation, and a half-adopted handoff are all CHECK-refused. **Frozen, not write-once**: the snapshot and all four adoption fields arrive in `AcquireInput` and appear nowhere in `DeploySessionPatch`, so after acquisition they have no legal path of change at all - a write-once rule would be weaker than the contract. `observed_topology` deliberately **not** frozen, because it is the reading. `mutation_observed` and `rollback_authority` one-way; a terminal session admits no update at all. |
| `certification_runs` | `revision` advances by exactly one; phase and cleanup direction never move backwards; `run_id`, `release_sha`, `started_at` immutable; a recorded failure never rewritten or cleared; `pending_command` A→B structurally refused; `superseded_command` write-once; eleven evidence identifiers write-once. |
| `certification_capabilities` | Slot as a **stored** fact - `UNIQUE(deployment_session_id) WHERE consumed_at IS NULL AND retired_at IS NULL` - because a partial index cannot express "unexpired" and an expired capability would otherwise block its own replacement. `consumed_at`/`retired_at` mutually exclusive and one-way; scope columns frozen. A **retirement guard** is what makes the slot safe: retiring is what frees it, so without one a raw `UPDATE` could retire a live capability early and issue a second beside it, defeating the partial index rather than passing it. Retirement is only for a capability never spent, and only at or after `expires_at`. |
| `runtime_instance_evidence` | Keyed by instance, not unit; a second row per unit is expected. Instance identity frozen. |
| `orders.certification_run_id` | The only certification discriminator. `NULL` is an ordinary order. No `order_purpose`. |

Bindings are foreign keys: `certification_capabilities.run_id →
certification_runs.run_id`, `.deployment_session_id → deploy_sessions.id`,
`orders.certification_run_id → certification_runs.run_id`.

## 7a. The dispatch fence's owner

`outbox_authority.dispatch_owner_release_id` + `dispatch_owner_generation`
become one `dispatch_owner_session_id REFERENCES deploy_sessions(id)`, and
`outbox_authority_events` likewise gains `owner_session_id`. The pair really
does protect ownership today - `sameEpoch` stops a second controller unfencing
mid-migration - so it could not simply be dropped; but `generation` belongs to
the release-generation model being dismantled, and the fence belongs to release
control. Ownership becomes a real foreign key, and the epoch concept
disappears instead of being preserved somewhere new.

## 8. Genesis rows

The baseline creates the schema's own zero state, and **this is new**: an
earlier draft of this document said "the baseline seeds `ACTIVE`" while the SQL
contained no `INSERT` at all.

`schema_identity`; the `outbox_authority`, `emergency_sales_gate` and
`unisender_event_dump_control` singletons; `agent_referrals_feature_state` at
`ACTIVE`; nine `ad_channel_policy` rows and ten `ord_reporting_period_policy`
rows. Each is a row whose absence a runtime reads as *fail closed* rather than
*empty*. The policy tables are append-only and immutable, and their
`reporting_basis` differs per format - three of the ten are
`PROVIDER_SPECIAL_PERIOD` - so they are generated from the ledger rather than
retyped.

The catalogue is deliberately **not** here: cities, occurrences and operational
settings belong to `launch-seed.ts`, and the legal release is republished
rather than seeded.

## 9. One defect closed, not carried forward

`0053` added four tax snapshot fields validated on INSERT by the settlement
tuple guard; `0058` reinstalled
`reward_settlements_authority_columns_immutable_guard` without them. On the
ledger, `UPDATE reward_settlements SET tax_canonical_hash = 'rewritten'` on a
`PREPARED` row is accepted and the row stays `PREPARED`. The baseline names
`tax_treatment_revision_id_snapshot`, `tax_canonicalization_version`,
`tax_canonical_json` and `tax_canonical_hash` in that guard.

Both sides were run in one process, the ledger as the negative control:

```
ledger    UPDATE ACCEPTED -> status=PREPARED hash=rewritten
baseline  UPDATE REFUSED  -> REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE
```

## How the guards stay proved after the ledger is deleted

`commerce/test/baseline-schema.test.ts` builds a database from this file and
asserts behaviour, not text. Thirty cases: genesis, the single-live-session
index, every refused gate/state combination, the adoption tuple, freezing vs
retaking topology, the monotonic bits, the capability slot and premature
retirement, run CAS and monotonicity, armed-command replacement, the eleven
write-once evidence identifiers, and the tax-snapshot defect.

Each guard, CHECK and partial predicate was removed in turn and the suite
re-run. Every one of them kills at least one case. That sweep is the reason the
file is worth having: it found a CHECK - "spent or replaced, never both" - that
nothing tested, because the retirement guard was answering first in the only
direction being exercised.

## What is not in the delta, and why

`schema_migrations` appears on both sides and cancels: `db.ts` creates it before
applying anything, so the inventory creates it in both modes. The baseline
defines it too, so that a database built from this file alone is already one the
migrator recognises.
