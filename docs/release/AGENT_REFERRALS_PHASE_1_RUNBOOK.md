# Agent Referrals Phase 1 cutover: dispatch evidence

`controlled-agent-referrals-phase-1-deploy.yml` is a one-shot controller for the
Phase 1 legal-identity cleanup (`0058_agents_legal_identity_cleanup.sql`). It is
manual-only and must not be dispatched until its exact inputs are frozen.

```text
BASE   = 2ae6a351669d2cc9d8cd42cf92d50436d64d08cd   (current production-deploy)
TARGET = b4e350f4ba6ecbaf110461dd5356c2293b3e5c2b   (Q, the Phase 1 candidate)
```

`TARGET^ == BASE`, and `TARGET` is an ancestor of protected `main`. `main` being
ahead of `TARGET` is **not** drift: the intervening commit is `CONTROL_PLANE`,
governed by protected `main` plus required CI and never deployed.

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

## Recording the evidence

Each gate is passed to the controller as a required dispatch input in this exact
shape, which the controller validates before any production effect:

```text
rows=0;<UTC timestamp>;<immutable evidence reference>
```

`rows=0` is literal: the controller refuses any other count, so an operator
cannot wave a non-empty result through. The controller cannot execute the SQL
itself — GitHub Actions has no database access, and adding a gate endpoint would
be a runtime change — so this mirrors the `base_integrity_check_evidence`
precedent in `TOPOLOGY_NORMALIZATION_RUNBOOK.md`. What the controller *can*
verify independently, it does: it reads the token-gated, read-only
`agent-referrals/dormant-readiness` surface and records
`business_facts_tables`, which covers `partner_identities` and
`agent_referrals_legal_profile_revisions` from production's own runtime.

`commerce/test/agent-referrals-phase-1-gate-queries.test.ts` extracts both
statements from this document and runs them against a real schema built from the
production migration set, proving they are not vacuous: each detects its own
violation, a live current binding clears Gate 2, and a destroyed identity or a
superseded pointer does not.
