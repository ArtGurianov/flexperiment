# Agents legal identity cleanup release shape

This document describes the future ordinary release of Phase 1. It grants no
deployment authority and must not be used to publish a runtime ref, move
`runtime-candidate`, deploy, or mutate production.

## Candidate boundary

The PR is based on topology-normalized `T0`:

```text
T0 = 2ae6a351669d2cc9d8cd42cf92d50436d64d08cd
Q^ = T0
```

After protected merge, `Q` is the only candidate source. The prospective
declaration is immutable and does not start a release:

```text
refs/heads/runtime/agents-legal-identity-cleanup-1 = Q
```

Only a separately authorized ordinary promotion may then move
`runtime-candidate` from `T0` to `Q`; it must prove `production-deploy` still
equals `T0` and that `Q^ == T0`. The controlled schema cutover is a later,
separately authorized operation which deploys and migrates `T0 -> Q`.

The required final convergence, proved independently after that future
cutover, is:

```text
main = production-deploy = runtime-candidate = commerce = worker = Q
```

## Data preflight

Before the future cutover, record read-only evidence that:

1. no `reward_settlements` row has `settlement_flow IS NOT 'AGENT_REFERRALS'`;
2. every agent with real LEGACY reward exposure has a non-destroyed partner
   identity whose legal-profile pointer equals its own maximum revision.

The migration deliberately does not fabricate historical legal provenance.
If either fact fails, stop rather than backfilling the current legal profile.
