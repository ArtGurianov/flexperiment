# Controlled release boundary for a future major product feature

**Status: policy requirement. This document does not create, authorize, or
execute a release.**

The next major Flexperiment production feature must use a new, independent
controlled release boundary. The boundary is designed as part of the concrete
feature; it is not created in advance merely because Epoch B has completed.

This preserves the completed Epoch A and Epoch B records as immutable history
and keeps code merge distinct from production authorization.

## Product state transition comes first

Start each future major feature by defining its product state transition, not
by attaching it to a predeclared "Epoch C" controller:

> What new production state does the feature create, which authorities change,
> and what is the smallest controlled boundary that safely moves production
> from P to that state?

Only then derive the release controller, candidate construction, expectations,
and recovery seams required by that transition. This keeps release control
feature-driven and prevents it from becoming a speculative universal framework
whose own complexity becomes a source of production risk.

## Purpose

A controlled release boundary for a major feature must provide:

- deterministic promotion of the production candidate;
- explicit durable ownership of the release;
- fail-closed transitions between production states;
- a durable audit trail and an exact terminal completion record;
- resumability after every partial failure;
- feature-specific runtime, migration, legal, and authority proofs;
- separate `prepare` and `complete` acts when the feature needs a temporary
  sales hold or another owned authority; and
- a prohibition on reusing a completed historical release as a mutable
  container for a different feature.

Every major feature boundary therefore defines its own:

```text
release_id
base production SHA
target candidate SHA
expected migrations
expected runtime contracts
expected legal state, when applicable
feature-specific invariants
completion record
```

## Epoch B is immutable history

Epoch B is a terminal historical release, not the starting owner for later
work:

```text
release_id = epoch-b-notification-activation:80e152259628719af20d363a76ed6b991d67482a

base R     = 80e152259628719af20d363a76ed6b991d67482a
terminal P = 24a382929740a7ead6fb0bb49f5ffc77e063c77a

completion = true
```

A later release must not:

- change Epoch B completion;
- acquire Epoch B's `release_id` again;
- update Epoch B expectations; or
- treat Epoch B as a current mutable release.

It may use terminal P as its production predecessor:

```text
Epoch B:                 R -> P, COMPLETE
Next controlled release: P -> Q
```

Do not call the next release `epoch-c` unless that is the actual product
meaning. Its release ID must identify the rollout and base artifact:

```text
<feature-name>:<base-production-sha>
```

For example:

```text
checkout-v2:24a382...
agent-referrals-v1:24a382...
occurrence-waitlist-v2:24a382...
admin-order-management-v1:24a382...
```

## Base production authority

At release design time, record the exact predecessor:

```text
BASE_SHA = production-deploy at release inception
```

For the next release after Epoch B, the expected base is currently:

```text
24a382929740a7ead6fb0bb49f5ffc77e063c77a
```

This is documentation, not an implicit controller input. Before execution, a
controller must freshly prove:

```text
production-deploy == BASE_SHA
runtime.source_commit == BASE_SHA
worker and other source authorities == expected base
all required predecessor completion records == true
```

If production has advanced, the controller must refuse with `BASE_MOVED`.
It must not automatically rebase the candidate or silently replace its base.

## Deterministic candidate and allowed change surface

The target candidate Q must be reproducible from:

```text
BASE_SHA
+ reviewed feature changes
+ durable production-derived inputs, when required by the feature
```

The same authoritative inputs must yield the same candidate SHA. Unless the
feature design explicitly documents and tests another topology, require:

```text
Q^ = BASE_SHA
```

`main` is implementation and controller history; it is never an implicit
production candidate. `production-deploy` names only the approved production
artifact.

The feature boundary must define an explicit allowlist for the exact
`BASE_SHA -> Q` diff. Candidate validation must fail closed for every
unexpected changed path. The allowlist may be broad only where the feature's
reviewed scope genuinely requires it.

## Expectations and feature readiness

Each release owns phase-specific, durable expectations. The minimal envelope
is:

```json
{
  "release_id": "...",
  "mode": "CONTROLLED_CUTOVER",
  "expected": {
    "source_commit": "Q",
    "migration": "...",
    "legal_version": "...",
    "legal_manifest_sha256": "..."
  }
}
```

This envelope is not presumed sufficient for every feature. When a concrete
feature needs more proof, extend it with feature-specific expectations (or a
versioned schema) as part of that feature's implementation:

```json
{
  "schema_version": 2,
  "release_id": "...",
  "mode": "CONTROLLED_CUTOVER",
  "expected": {
    "source_commit": "Q",
    "migration": "...",
    "legal": {},
    "feature": {
      "kind": "...",
      "contract_version": "...",
      "invariants": {}
    }
  }
}
```

Do not introduce speculative generic fields before a feature requires them.

Every major feature also needs an executable assertion named like
`assert-<feature>-ready`. It must prove the feature's actual production
contract rather than only `/readyz` or deployment success. Depending on the
feature, this can include runtime and worker SHAs, migration inventory, API
contract versions, capabilities, durable schema state, queue or inventory
authority, payment authority, and legal state.

## State machine and recovery

The default state machine is:

```text
BASE
  |
  v
ACQUIRED
  |
  v
PAUSED / CONTROLLED
  |
  v
TARGET EXPECTATIONS
  |
  v
CAS BASE -> Q
  |
  v
DEPLOY / CONVERGE
  |
  v
PREPARED
  |
  v
COMPLETE
```

Use `PAUSED` and `PREPARED` only when the feature's risk model actually needs
a two-phase operational hold. A safe atomic cutover must not be split merely
to mimic earlier epochs.

The controller must classify every durable intermediate state using only:

```text
release-control durable state
production-deploy
runtime state
migration state
feature-specific durable authority
completion records
```

It must never infer progress from local GitHub Actions runner files. After a
runner crash, a new run may continue only through the safe transition implied
by the durable state. At minimum, design and test equivalents of:

```text
owner/base expectations + pointer BASE
    -> continue before CAS

owner/Q expectations + pointer BASE
    -> fresh proof, then guarded CAS

owner/Q expectations + pointer Q + runtime BASE
    -> deploy and converge

owner/Q expectations + pointer Q + runtime Q
    -> prove readiness

completion true
    -> terminal read-only replay
```

Every `production-deploy` transition is a guarded compare-and-swap:

```text
expected_old = BASE
new          = Q
```

If the pointer is no longer `BASE`, refuse with `CAS_REFUSED`; never make an
unconditional or arbitrary force update.

## Authorization and terminal completion

Merge authorization is not production authorization:

```text
implementation PR
    -> review
    -> merge
    -> post-merge CI
    -> fresh production preflight
    -> explicit production GO
    -> controlled execution
```

For a two-phase rollout, authorization remains distinct:

```text
GO prepare
    -> prepared-state review
    -> fresh complete preflight
    -> separate GO complete
```

A GO does not carry over a controller change, controller-relevant `main`
movement, failed production run, unexpected durable drift, or corrective PR.

Successful completion must persist exact terminal expectations:

```json
{
  "complete": true,
  "expected": {
    "...": "exact terminal expectations"
  }
}
```

This completion record is immutable evidence. It must not be edited to reuse
the same release for another feature; the next feature always receives a new
release ID.

## Required tests and implementation order

Feature and controller work must include executing regression coverage for:

- initial classification and every recovery state;
- candidate determinism, topology, and changed-path allowlist;
- exact request generation, including no-stdin shell constructors when used;
- guarded CAS, controller drift, and authority drift;
- feature readiness and mutation ordering; and
- terminal replay.

String or regex checks are supplemental only. Critical shell and controller
behavior must be executed in tests.

Build each major feature programme in this order:

1. Define the feature's new production state, affected data and migrations,
   authorities, and dangerous failure modes.
2. Design its release boundary: release ID, base, candidate construction,
   expectations, hold requirement, readiness assertion, recovery matrix, and
   terminal state.
3. Implement the product feature, migrations, runtime capability, assertions,
   controlled controller, tests, and runbook together.
4. After merge, run the separate production programme with fresh evidence and
   explicit GO gates.

Do not build a generic release framework for hypothetical future features.
Introduce shared abstractions only when a concrete feature proves they are
needed.

## Definition of done

A controlled release boundary is ready only when it proves:

```text
1. The previous production state is immutable and identifiable.
2. The target candidate is deterministic.
3. Candidate topology and path scope are approved.
4. Durable expectations are exact.
5. Every mutation has fresh authority proof before it.
6. Partial failures are resumable.
7. The pointer transition is guarded by CAS.
8. Runtime convergence proves the feature contract, not only process health.
9. Terminal completion is durable and exact.
10. A later release cannot mutate this release's historical meaning.
```
