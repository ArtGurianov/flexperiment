# Agent Referrals Phase 1 cutover: dispatch evidence

`controlled-agent-referrals-phase-1-deploy.yml` is a one-shot controller for the
Phase 1 legal-identity cleanup (`0058_agents_legal_identity_cleanup.sql`). It is
manual-only and must not be dispatched until its exact inputs are frozen.

```text
BASE   = 2ae6a351669d2cc9d8cd42cf92d50436d64d08cd   (current production-deploy)
TARGET = 1d7310883f4822945725a6ba95d7ff37a470f502   (Q2, the Phase 1 candidate)
tree   = b53cdd72fdae633ad26ea5871d7b7b4f4d440342
```

`BASE..TARGET` is an ordinary linear range of exactly three reviewed commits,
asserted as a sequence rather than a count:

```text
b4e350f  Q    agent legal identity
64b1c59       CONTROL_PLANE: readiness convergence/admission separation
1d73108  Q2   Phase 1 in-transaction migration gates
```

The middle commit is `CONTROL_PLANE`, governed by protected `main` plus required
CI and never deployed. Its presence in the range is expected and is not drift;
the controller classifies it rather than rejecting it.

## The two production gates

Both are **read-only** proofs of existing production eligibility. They are
**STOP conditions**, never migration mechanisms. Do not mutate, backfill,
rewrite, relabel or auto-reconcile any row in order to make either pass, and
never run a repair from the cutover controller.

Run each against the live production database, read-only, immediately before
dispatch. Preserve the exact SQL, the result, the timestamp, and enough
database/environment identity to establish that it was production.

### Gate 1 — existing settlement authority

Zero `reward_settlements` rows may exist whose flow is not `AGENT_REFERRALS`.
`IS NOT` is null-safe in SQLite, so this also catches historical `NULL` rows,
which the authority tuple treats as `LEGACY`.

```sql
-- gate1
SELECT id, agent_id, occurrence_id, status, settlement_flow, prepared_at
FROM reward_settlements
WHERE settlement_flow IS NOT 'AGENT_REFERRALS'
ORDER BY prepared_at;
```

A non-empty result means historical LEGACY settlements exist. 0058 cannot
migrate them: `reward_settlements_authority_columns_immutable_guard`
(`0047_act_payment_settlement.sql:174`) forbids changing
`legal_profile_revision_id_snapshot` or `contractor_type_snapshot` on an
existing row, and a historical settlement's provenance cannot be reconstructed
from today's revisions anyway. **STOP** and design grandfather semantics
separately.

### Gate 2 — legacy-exposed agent binding

Zero agents with real legacy reward exposure may lack a live partner identity
whose legal-profile pointer is that agent's current `MAX(revision)`. The
`NOT EXISTS` clause below is the exact predicate 0058's rewritten `LEGACY`
authority tuple enforces at INSERT time, so the gate proves the same property
the runtime will require.

```sql
-- gate2
SELECT a.id, a.slug
FROM agents a
WHERE (
      EXISTS (SELECT 1 FROM referral_rewards r
              WHERE r.agent_id = a.id
                AND COALESCE(r.reward_authority_kind, 'LEGACY') = 'LEGACY')
   OR EXISTS (SELECT 1 FROM reward_adjustments ra JOIN orders o ON o.id = ra.order_id
              WHERE ra.agent_id = a.id AND o.reward_authority_kind = 'LEGACY')
   OR EXISTS (SELECT 1 FROM reward_settlements rs
              WHERE rs.agent_id = a.id AND rs.settlement_flow IS NOT 'AGENT_REFERRALS')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM partner_identities pi
    JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi.legal_profile_revision_id
    WHERE pi.agent_id = a.id
      AND pi.destroyed_at IS NULL
      AND lp.agent_id = a.id
      AND lp.revision = (SELECT MAX(lp2.revision)
                         FROM agent_referrals_legal_profile_revisions lp2
                         WHERE lp2.agent_id = a.id)
  )
ORDER BY a.slug;
```

No `enabled` filter: `prepareSettlement` does not check it, and a disabled agent
can still hold earned legacy remuneration that must be paid. The gate models the
real consumer, not a UI notion of activity.

This gate can legitimately fail. `agent-referrals-attribution.ts:151` defines a
legacy agent as one *without* a partner identity, and a legal-profile revision
only ever reaches an agent through `applyVerifiedLegalProfileForPartnerIdentity`,
so a genuinely legacy agent structurally cannot have a pinnable binding. A
non-empty result means onboarding those agents into a valid identity binding, or
retiring the legacy route — **never** weakening the pin, synthesizing a
historical binding, selecting an arbitrary revision, or backfilling production.

## Authority: the migration, not the query

```text
operator Gate 1/2 query        = required preflight provenance
0058 in-transaction guards     = cutover authority
```

This distinction is load-bearing, not bookkeeping. A query result is a
point-in-time fact, and the BASE runtime can invalidate either gate after it
returns: legacy `prepareSettlement()` writes `reward_settlements` rows without
`settlement_flow` - so they read as LEGACY - and it is behind no fence.
`assertNewOrdersOpen` appears only on the quote/checkout path, never in the
settlement transaction, and `emergencySalesPaused` is read for display rather
than enforced. Pausing sales does **not** stop settlement preparation.

So 0058 proves both gates itself, before its first destructive statement, inside
the same `BEGIN IMMEDIATE` transaction `applyFkOffMigration` uses for the DDL. A
writer either lands before the lock and is counted, or cannot interleave at all.
That closes the race; a freshness window on the operator evidence would only
have narrowed it.

The dispatch inputs remain mandatory and must still read exactly:

```text
rows=0;<UTC timestamp>;<immutable evidence reference>
```

`rows=0` is literal so that an operator who saw a non-empty result cannot
dispatch. But validating that string is **not** what makes the cutover safe, and
must not be described as if it were.

The controller also records what production can prove about itself: it reads the
token-gated read-only `agent-referrals/dormant-readiness` surface and logs
`business_facts_tables`, covering `partner_identities` and
`agent_referrals_legal_profile_revisions`.

## If a guard refuses

```text
0058 guard violation
  -> migration transaction rolls back
  -> 0058 absent from the migration ledger
  -> the old schema remains authoritative
  -> the candidate fails to boot; readiness fails closed
  -> STOP
  -> separate controlled recovery to BASE, if operationally required
```

Nothing about this path is automatic. The controller performs **one** bounded
redeploy of TARGET for an unconverged surface and then stops; it never redeploys
BASE, has no schema-failure branch, and offers no waiver input. A candidate
refused by its own gates is indistinguishable from a surface that never
converged, and is deliberately treated the same: readiness exit `75` means
"deployment failed to converge" and nothing else. Recovering production to BASE
is a separate, deliberate, controlled act.

Diagnose from the production rows before doing anything else. Neither gate may
be waived, relabelled, weakened, or satisfied by backfill - `0047`'s
`reward_settlements_authority_columns_immutable_guard` forbids relabelling an
existing settlement anyway, and a historical settlement's provenance cannot be
reconstructed from today's revisions.

`commerce/test/agent-referrals-phase-1-gate-queries.test.ts` extracts both
statements from this document - not a copy - and runs them against a schema
built from the production migration set, proving they are not vacuous.
`commerce/test/agent-referrals-phase-1-migration-gates.test.ts` executes the real
loader and proves that a violation leaves the ledger, the schema and every
trigger untouched.
