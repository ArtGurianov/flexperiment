# Controlled checkout/legal cutover recovery

Classify durable state before any action. The legal recovery controller has four
exact states; do not substitute a new source from `main` or controller `HEAD`.

## `ADOPTING_PREPUBLICATION_REPAIR`

**Required facts:** predecessor legal is active; durable expected source is the
original candidate; supplied repair differs; the exact repair boundary passes;
the same owner holds a paused, incomplete release.

**Permitted:** validate and adopt the repair by moving expectations to that
exact repair SHA.

**Forbidden:** publish legal before candidate readiness; acquire or pause
again; change legal hashes, surface contracts, or migration expectation.

**Next durable transition:** deploy and prove the adopted repair while the
predecessor legal release remains active.

## `RESUMING_PREPUBLICATION_REPAIR`

**Required facts:** predecessor legal remains active and durable expected source
equals the supplied repair SHA exactly.

**Permitted:** reuse that exact repair and continue candidate deployment and
readiness.

**Forbidden:** a new repair adoption, reacquire, repause, or expectations
rewrite.

**Next durable transition:** publish only after exact repair readiness passes.

## `RESUMING_POSTPUBLICATION_REPAIR`

**Required facts:** candidate legal is active; durable expected, runtime, and
worker source all equal the adopted repair SHA exactly; the same owner remains
paused and incomplete; candidate version and hashes match durable
expectations.

`current_legal_copies_match=false` is allowed only in this narrow interval:
candidate legal has published, but the promotion artifact has not yet deployed.

**Permitted:** create or recover promotion directly from the exact repair SHA.

**Forbidden:** adopt a new repair or republish legal.

**Next durable transition:** update expectations to the exact promotion SHA,
deploy it, and require current legal copies to match before completion or
reopen.

## `RESUMING_PROMOTION`

**Required facts:** candidate legal is active and durable expected source is an
exact validated promotion SHA.

**Permitted:** reuse that exact promotion SHA for deployment and proof.

**Forbidden:** reconstruct promotion from `main` or controller `HEAD`.

**Next durable transition:** after promotion deployment, prove current copies,
legal hashes, surfaces, runtime, worker, health, and readiness; then complete
and guarded-reopen.

## Promotion invariants

A promotion is a direct child of repair (`promotion^ == repair`), lives on an
immutable promotion ref, and contains only the allowed canonical legal
promotion files. Controller commits are excluded from its ancestry. Current
legal copies must be true only after promotion deploy and before completion or
reopen.

Before a recovery action, inspect the exact identities and promotion provenance
locally:

```bash
scripts/inspect-release-topology.sh \
  --candidate <candidate-sha> \
  --repair <repair-sha> \
  --controller <controller-sha-or-ref> \
  --promotion <promotion-sha-or-ref>
scripts/verify-legal-promotion.sh <repair-sha> <promotion-sha>
```

Both helpers are read-only and require the referenced Git objects to already be
available locally.

See [deployment invariants](../release/DEPLOYMENT_INVARIANTS.md) and
[recovery branch topology](RECOVERY_BRANCH_TOPOLOGY.md).
