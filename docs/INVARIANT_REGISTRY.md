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

A row is one of two kinds, and they are held to different standards:

- **ACTIVE** — the invariant still governs production. It must name an owner and
  a surviving behavioural proof.
- **RETIRED** — the surface it governed no longer exists. It needs no test; it
  needs a reason and evidence that the surface is genuinely gone. Without this
  distinction a closed epoch survives forever merely so that its row has a file
  to point at, which is the outcome this cleanup exists to avoid.
- **ACTIVE_BASELINE_REWRITE** — active, and proved now against the trigger as it
  is written today, but the baseline will restate that trigger without the
  pre-launch discriminator its condition currently names. The row stays open
  until the rewritten form is proved to carry the same invariant. It exists so
  that a guard proved only in its conditional form is not mistaken for one that
  has been carried across.

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
| A tampered ticket capability fails authenticated decryption | `crypto.ts` | `crypto.test.ts` |
| A command's canonical encoding is stable over its supported domain, and rejects the rest | `crypto.ts` | `crypto.test.ts` |
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

## Publication, delegation and the order reference

Rehoused out of the engagement publication, ORD reporting and foundation
migration tests. These are the last of the 48.

| Invariant | Enforced by | Guarded by | Status |
|---|---|---|---|
| An engagement revision is never edited or erased | `ENGAGEMENT_REVISION_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| A promo authorization's placement is frozen | `ENGAGEMENT_PROMO_AUTHORIZATION_PLACEMENT_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| A promo authorization is never deleted | `ENGAGEMENT_PROMO_AUTHORIZATION_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| Revocation is one-way | `ENGAGEMENT_PROMO_AUTHORIZATION_ALREADY_REVOKED` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| A reported distribution revision is never edited or erased | `ENGAGEMENT_DISTRIBUTION_REVISION_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| A delegation cites its own partner's acceptance | `ORD_REPORTING_DELEGATION_ACCEPTANCE_PARTNER_MISMATCH` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| A delegation uses the template that acceptance was issued on | `ORD_REPORTING_DELEGATION_TEMPLATE_ISSUANCE_MISMATCH` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| The reporting period policy is never edited or erased | `ORD_REPORTING_PERIOD_POLICY_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| Every order carries a public reference | `PUBLIC_ORDER_NUMBER_REQUIRED` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |
| An order's public reference never changes | `PUBLIC_ORDER_NUMBER_IMMUTABLE` | `agent-referrals-publication-constraints.test.ts` | ACTIVE |

## Identity, legal basis and framework

Rehoused out of the partner identity, legal profile, tax treatment and
framework reissuance migration tests. These rows answer "on what authority was
this person paid", and they are append-only for the reason a ledger is: an edit
does not correct history, it replaces it with a version nobody agreed to.

| Invariant | Enforced by | Guarded by | Status |
|---|---|---|---|
| An identity event is never edited or erased | `PARTNER_IDENTITY_EVENT_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| An audience verification event is never edited or erased | `PARTNER_AUDIENCE_VERIFICATION_EVENT_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| A legal profile revision is never edited or erased | `AGENT_REFERRALS_LEGAL_PROFILE_REVISION_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| A tax treatment revision is never edited or erased | `AGENT_REFERRALS_TAX_TREATMENT_REVISION_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| A tax treatment agrees with the legal profile it derives from | `AGENT_REFERRALS_TAX_TREATMENT_RELATIONAL_INCONSISTENT` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| An acceptance answers an issuance made out to the same partner | `FRAMEWORK_ACCEPTANCE_ISSUANCE_PARTNER_MISMATCH` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| An acceptance cites that partner's own legal profile | `FRAMEWORK_ACCEPTANCE_LEGAL_PROFILE_PARTNER_MISMATCH` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| A retention policy revision is never edited or erased | `PARTNER_IDENTITY_RETENTION_POLICY_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |
| An ad channel policy revision is never edited or erased | `AD_CHANNEL_POLICY_REVISION_IMMUTABLE` | `agent-referrals-identity-constraints.test.ts` | ACTIVE |

## Payments, receipts and recovery exposure

Rehoused out of `agent-referrals-act-payment-settlement-migration.test.ts`. The
partner is paid all the way through - settlement, accepted act, authorization,
attempt recorded as made - so these guards are tried against the rows that say a
real person received a real amount.

| Invariant | Enforced by | Guarded by | Status |
|---|---|---|---|
| A payment authorization is never edited or deleted | `PAYMENT_AUTHORIZATION_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| A payment attempt is never deleted | `PAYMENT_ATTEMPT_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| A settled attempt is never rewritten | `PAYMENT_ATTEMPT_TERMINAL_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| An attempt restates the authorization that permitted it | `PAYMENT_ATTEMPT_RELATIONAL_INCONSISTENT` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| An NPD receipt is never edited or deleted | `NPD_RECEIPT_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| A receipt evidences a payment that was made, for an NPD settlement | `NPD_RECEIPT_RELATIONAL_INCONSISTENT` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| The status check an authorization relied on is frozen | `NPD_STATUS_CHECK_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| A zero-reward closure is never edited or deleted | `ENGAGEMENT_ZERO_REWARD_CLOSURE_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| A zero-reward closure is only for an engagement that earned nothing | `ENGAGEMENT_ZERO_REWARD_CLOSURE_RELATIONAL_INCONSISTENT` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| Recovery exposure evidence is never edited or deleted | `ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_IMMUTABLE` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |
| Exposure arises only from a correction against a paid settlement | `ENGAGEMENT_RECOVERY_EXPOSURE_EVIDENCE_RELATIONAL_INCONSISTENT` | `agent-referrals-payment-constraints.test.ts` | ACTIVE |

One branch of the zero-reward guard is not independently reachable: it also
refuses a closure while a live settlement exists, and a settlement is only ever
created for a snapshot that earned something. An engagement can have a zero
reward or a live settlement, not both, so the branch is defence in depth against
a path that does not exist yet.

## Settlements and acts

Rehoused out of `agent-referrals-act-payment-settlement-migration.test.ts`. The
settlement is prepared from a finalized reward snapshot and the act is
generated, presented and accepted through the real step-up chain, so the guards
are tried against documents the domain issued.

| Invariant | Enforced by | Guarded by | Status |
|---|---|---|---|
| A settlement's authority columns are frozen | `REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| A settlement's authority tuple holds together | `REWARD_SETTLEMENT_AUTHORITY_TUPLE_INCONSISTENT` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| A terminal settlement is never reopened | `REWARD_SETTLEMENT_TERMINAL_IMMUTABLE` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| A settlement's status moves only along the permitted path | `REWARD_SETTLEMENT_TRANSITION_ILLEGAL` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| A settlement act cannot be deleted | `SETTLEMENT_ACT_IMMUTABLE` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE |
| An act's identifying fields are frozen | `SETTLEMENT_ACT_FIELDS_IMMUTABLE` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE |
| A presented act cannot be changed at all | `SETTLEMENT_ACT_ALREADY_PRESENTED` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE |
| An act restates its settlement exactly | `SETTLEMENT_ACT_RELATIONAL_INCONSISTENT` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE |
| An acceptance is frozen once recorded | `SETTLEMENT_ACT_ACCEPTANCE_IMMUTABLE` | `agent-referrals-settlement-constraints.test.ts` | ACTIVE |

`AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH` has no
independently reachable branch and is therefore not listed as separately
guarded. It was written when the tuple guard compared the contractor type
against `agents`, a column a later rebuild removed; the effective tuple guard
compares against the same legal-profile projection and reaches the same
conclusion first.

## Attribution and reward snapshots

Rehoused out of `agent-referrals-attribution-reward-migration.test.ts`. Every
row here is exercised against rows the domain itself wrote - an attribution
tuple assembled by checkout, a registry snapshot written by finalization -
rather than against rows the test invented.

| Invariant | Enforced by | Guarded by | Status |
|---|---|---|---|
| An order's attribution columns are frozen after checkout | `0046` `ORDER_AUTHORITY_COLUMNS_IMMUTABLE` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| An order's attribution tuple holds together | `0046` `ORDER_AUTHORITY_TUPLE_INCONSISTENT` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE_BASELINE_REWRITE |
| A finalized reward registry snapshot is immutable | `0046` `ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_IMMUTABLE` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE |
| A registry snapshot agrees with the engagement and occurrence it names | `0046` `ENGAGEMENT_REWARD_REGISTRY_SNAPSHOT_RELATIONAL_INCONSISTENT` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE |
| An effective reward snapshot is immutable | `0046` `ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_IMMUTABLE` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE |
| An effective snapshot restates its base, unless it supersedes a predecessor | `0046` `ENGAGEMENT_EFFECTIVE_REWARD_SNAPSHOT_RELATIONAL_INCONSISTENT` | `agent-referrals-attribution-constraints.test.ts` | ACTIVE |
| The suite runs for pull requests, `main` and manual dispatch only | `test.yml` | `release/deploy-workflow-contract.test.ts` |

## Retired

The surface these governed no longer exists. They are listed so that a reader
who finds them in the history knows they were retired deliberately rather than
lost, and each names the evidence that the surface is gone.

| Invariant | Retired because |
|---|---|
| Candidate publication refs use the flat `runtime/release-semantics-bootstrap-*` shape | The epoch and its refs are gone. `git grep` finds no reference to that namespace anywhere outside the test that asserted it. |
| Candidate publication refs use the flat `runtime/agent-referrals-<generation>` shape | Generation semantics were deleted with the release controller; the namespace has no remaining reference either. |
| A candidate pointer is adopted over a stale one, and read as a lease | The test named no file in this repository: it ran `git` against temporary repositories and asserted git's own ancestry and lease behaviour. The controller it was written for is gone, and what survives - the runtime identity readout and `inspect-runtime-candidate-topology.sh` - it never exercised. The lease property itself is now owned by `release/deploy-session.ts` and proved in `release/resume.test.ts`. |
| A referral reward's authority kind never changes, and matches its order's | `reward_authority_kind` is the pre-launch discriminator, and the guard's condition is the column itself. When the baseline removes it there is nothing left for either `REFERRAL_REWARD_AUTHORITY_KIND_IMMUTABLE` or `REFERRAL_REWARD_AUTHORITY_KIND_MISMATCH` to compare. |
| The production deploy pointer moves only by compare-and-set | The scripts that moved it are called by nothing. The new deploy path runs `deploy-production.yml` → `scripts/release/deploy-production.ts` → the orchestrator, which never touches a git pointer, and the compare-and-set property it cared about is now owned by the deploy session's own authority and proved in `release/deploy-session.test.ts`. The `production-deploy` ref itself survives as something the runtime identity readout reads, inline, for observability. If the baseline's adapters turn out to need a pointer primitive, P9 writes a canonical one rather than inheriting a legacy pair. |
| A candidate's topology is inspected before promotion | `inspect-runtime-candidate-topology.sh` is called by no workflow and no test. Convergence is now proved by observing what the three surfaces actually serve, in `release/orchestrator.ts`. |
| `test.yml` does not run on durable runtime refs | Rephrased rather than dropped: the trigger set is now asserted as parsed YAML in `release/deploy-workflow-contract.test.ts`, which states the same property without depending on the file's whitespace. |

## Pending classification: schema guards held only by migration tests

The fifteen `*-migration.test.ts` files carry 401 cases between them, and P9
deletes most of them when the ledger collapses into one baseline. The question
that matters is not how many cases go, but which named schema guards lose their
only proof when they do.

Measured rather than estimated. The current migrations define **113** named
guards (`RAISE(ABORT, '...')`). Migration tests assert **60** of them. Of those
60, **48 are asserted nowhere else**: if those files are deleted as they stand,
48 constraints that the running system enforces would have no test at all.

This is the residual risk the plan predicted, now counted instead of feared.

Each of the 48 has now been read against the trigger it names, and the result
corrects an earlier claim made in this file.

**Retired with their column — 2.** Only two guards have nothing left to protect
once the pre-baseline discriminator goes, because the column *is* their entire
subject: `REFERRAL_REWARD_AUTHORITY_KIND_IMMUTABLE` fires only when
`reward_authority_kind` changes, and `REFERRAL_REWARD_AUTHORITY_KIND_MISMATCH`
only cross-checks that column against the order's.

**Active, rewritten without the discriminator — 6.** An earlier revision of this
section listed six guards as retiring with their column. Four of them do not,
and the error is worth recording because it is the exact mistake the section
warns about. `ORDER_AUTHORITY_COLUMNS_IMMUTABLE` and
`REWARD_SETTLEMENT_AUTHORITY_COLUMNS_IMMUTABLE` each freeze a dozen attribution
columns of which the discriminator is one; deleting it does not retire the
invariant that an order's or a settlement's attribution cannot be rewritten
after the fact. The two `_TUPLE_INCONSISTENT` guards use the discriminator to
choose which shape to require, and after the baseline there is only one shape,
so the requirement becomes unconditional rather than absent. The same is true of
`REWARD_SETTLEMENT_TERMINAL_IMMUTABLE` and `REWARD_SETTLEMENT_TRANSITION_ILLEGAL`,
whose `WHEN settlement_flow = 'AGENT_REFERRALS'` is a condition on which rows to
guard and not the thing being guarded.
`AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH` was listed here
too, and has since been found to have no independently reachable branch at all;
it is recorded below as subsumed rather than rewritten.

**Active, untouched — 39.** Immutability and relational-consistency guards on
tables that survive unchanged: engagement revisions and their snapshots, promo
authorizations, settlement acts and acceptances, payment attempts and
authorizations, NPD receipts and status checks, partner identity events and
retention policies, audience verification events, ORD reporting delegations and
period policy, framework acceptances, ad channel policy, and the public order
number.

So 46 of the 48 need a surviving proof before the file asserting them can go,
not 42. Classifying by proximity to a doomed column would have retired four real
protections, which is why each is read.

**The census is closed.** Every one of the 48 is accounted for, and the only
guards no surviving test names are the two that retire with their column:

| | Count |
|---|---:|
| Rehoused and proved at predicate level | 45 |
| Anonymous constraints rescued by the residual sweep | 3 |
| Retired with the pre-launch discriminator | 2 |
| Subsumed: no independently reachable branch | 1 |
| Still held only by a migration test | 0 |

An earlier revision of this table said 25 / 2 / 1 / 21, which adds to 49. The
error was in the measurement, not the arithmetic: the two retired guards have no
surviving test by design, so a search for "guards no surviving test names"
counted them as remaining, while the subsumed one is named in a comment and
counted as covered. The counts above separate those.

Of the 45 rehoused, six carry `ACTIVE_BASELINE_REWRITE`: they are proved in the
conditional form they have today, and the baseline will restate them without the
discriminator their condition names.

Five families: attribution and reward snapshots; settlements and acts; payments,
receipts and exposure; identity, legal basis and framework; and publication,
delegation and the order reference.

**What this does and does not license.** Point 1 of the removal rule is now
satisfied for every migration test. Points 2 and 3 were satisfied family by
family as the constraints travelled with the guards. Point 4 still decides the
timing: while the ledger exists, each file's own mechanics - exactly-once
application, replay as a no-op, ordinary versus FK-off, rows that predate a
migration - still have a subject. **The files go in P9, with the ledger they
describe.** What P8 owed was that nothing else goes with them, and that debt is
now paid. Before that: six rehoused and two retired, which empties
`agent-referrals-attribution-reward-migration.test.ts` of guards it alone held;
forty remain. Its own constraints travelled with them - the registry's uniqueness
per engagement, its terminal-status domain, the rule that a cancelled occurrence
mints nothing, and the effective chain's uniqueness, its INITIAL-to-sequence-one
identity and its predecessor rule - because those carry no `RAISE` name and the
census could not see them.

Predicate-level mutation found three cases that were passing for the wrong
reason and one predicate that cannot be reached at all: the guard's pin on a
predecessor's engagement is implied by its pin on the base registry, which is
unique per engagement. That is recorded in the test rather than asserted by a
case contorted into covering it.

**The rule this section exists to enforce.** A migration test may be deleted
only when all four hold:

1. no named guard is asserted by it alone;
2. the live `CHECK`, `UNIQUE` and relational constraints it exercises are
   rehoused - the census reads `RAISE` names, and a table's own constraints have
   none, so counting guards is not enough;
3. the application-facing schema contracts it proves are rehoused;
4. what remains is migration mechanics - exactly-once application, replay as a
   no-op, ordinary versus FK-off, rows that predate the migration - which have a
   subject only while the migration file exists.

Point 4 decides when: **no migration test is deleted in P8 at all.** While
`0046` is still in the ledger, its mechanics are still a live subject. Those
files go in P9, in the change that collapses the ledger they describe. What P8
owes is that nothing else goes with them.

A guard leaves the list by being rehoused against the schema as it is - as the
`outbox_attempt` constraints were - or by being retired with evidence that the
object it protects is gone.

**Read the effective schema, not the migration that introduced a guard.** A
trigger is frequently rewritten by a later migration, and the earlier text then
describes something that has not run for months. Disabling a `RAISE` in the
file that first defined it can leave every test passing while the live guard is
untouched - which happened here, and was visible only because the mutation
failed to kill anything. Guards are read, and mutated, in the schema the
migrations actually produce.

**And rehousing is measured by branches, not by names.** A guard that freezes
eleven columns is not carried across by a test that edits six of them. Each
rehoused guard is confirmed by disabling its own `RAISE`, and then by deleting
individual predicates from its condition: a case that survives the second kind
of mutation was passing for the wrong reason.

## The residual sweep

Counting named guards was never the whole job: a table's own `CHECK`, `UNIQUE`
and foreign-key rules raise nothing named, so the census could not see them.
Slice 1 had already shown this costs real protections - the registry's
uniqueness per engagement and the effective chain's sequence rules carry no
name and would have gone unnoticed.

So the same question was asked of the layer the census is blind to. The
migration tests contain 98 assertions on anonymous constraints - 56 `CHECK`, 32
`UNIQUE`, 10 foreign key - and write to 72 tables between them.

**One real gap, now closed.** Two `UNIQUE` constraints on
`occurrence_notification_intents` were named nowhere else: one active intent per
request, and one intent per outbox message. Together they are what stops a
person being emailed twice about one occurrence, and they are proved in
`city-interest-notification-constraints.test.ts` along with the supersession
that makes room for a successor - because uniqueness with no way forward would
be a dead end rather than a rule.

**Six tables are written only by migration tests.** Of those, `reward_adjustments`
and `settlement_prepared_reviews` are referenced nowhere in `commerce/src` at
all, and `outbox_authority_events` belongs to the outbox authority control that
the baseline removes; their constraints go with them. The remaining three -
`reward_settlement_command_idempotency`, `settlement_act_disputes` and
`settlement_step_up_grants` - are written by modules that surviving suites
exercise heavily, through the domain rather than by naming the table.

That last point is the honest limit of this sweep: exercising the module that
writes a table is not the same as proving the table's constraints, and this
method cannot tell the difference. What it can say is that no live table's
rules are held *exclusively* by a migration test. Anything finer belongs to P9,
where each file is deleted against the baseline suite rather than against this
one.

## Blocks the baseline

Found by reading the schema the migrations produce, and confirmed by running it.

**A settlement's tax snapshot is not frozen.** `0053` added four load-bearing
fields to `reward_settlements` - `tax_treatment_revision_id_snapshot`,
`tax_canonicalization_version`, `tax_canonical_json`, `tax_canonical_hash` - and
the tuple guard validates all of them on INSERT, including the
`SETTLEMENT_TAX_V1` version and the link from the tax treatment to the legal
profile. The columns-immutable guard was never extended to cover them, and
`0058` reinstalled the tuple guard while leaving it alone.

So for a `PREPARED` or `PENDING_DOCUMENT` settlement this succeeds today, with
nothing raised:

```sql
UPDATE reward_settlements SET tax_canonical_hash = 'rewritten' WHERE id = ...;
```

Confirmed against a real settlement: the statement did not throw, the row stayed
`PREPARED`, and the hash changed. The terminal guard only protects rows that
have already settled, so the window is the whole life of the settlement up to
payment - and the payment and ORD paths consume that snapshot as though it were
fixed at settlement time.

It is not patched here. Amending `0053` after the fact is the compatibility
archaeology this work exists to remove, and P8 adds no migrations. **The baseline
must fold these four fields into the final, unconditional settlement authority
guard, and prove them in the steady-state suite.**

## Open rows

Rows here are invariants with no guarding test, or whose guard is known to be
weaker than the claim. The PR does not merge with an open row.

_None._

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

Ticket capabilities round-tripped through two suites, so the happy path was
covered and the security property was not. The authentication tag is the reason
the mode was chosen, and a capability is exactly the kind of value someone would
try to edit, so corruption of the message, of the tag, and of the nonce are each
asserted against re-encoded bytes rather than an edited string.

`canonicalV2` had no test at all, although it decides when two requests are the
same request. Its encoding is asserted as exact text - key order at every depth,
array order left alone, `undefined` omitted, non-finite and unsupported values
refused - because that text is the identity, and a parser-based comparison would
hide precisely the changes that matter.
