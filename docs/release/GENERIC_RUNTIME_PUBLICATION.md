# Generic runtime publication

`controlled-generic-runtime-publication.yml` is the publication authority for
an ordinary runtime commit. It creates, or idempotently re-reads, exactly one
immutable provenance ref:

```text
refs/heads/runtime/generic-<full target SHA>
```

It is intentionally not a promotion or deployment controller. A successful
run leaves both `runtime-candidate` and `production-deploy` unchanged, starts
no Coolify deployment, and does not contact or mutate release-control state.
The workflow is manual, runs from current `main` under the `production`
environment gate, and has only read-scoped default GitHub permissions. The ref
write uses the dedicated `GENERIC_RUNTIME_PUBLICATION_REF_TOKEN`; do not
substitute candidate- or production-deploy credentials.

## Dispatch evidence

Dispatch requires the following separately recorded values:

- `target_sha`: exact reviewed runtime commit;
- `expected_controller_sha` and `expected_controller_tree`: the current
  protected-`main` controller identity;
- `expected_production_deploy_sha`: current runtime base;
- `expected_test_run_id`: a completed, successful `Test` workflow run triggered
  by a `push` to `main` for exactly `target_sha`.

Before publication, the controller re-reads `main` and `production-deploy`,
proves that the target is covered by the controller, and uses
`inspect-runtime-candidate-topology.sh` to require a linear, descendant
runtime path with no `.release/maintenance-only` commit. It rejects stale
controller or production evidence, an ineligible target, or CI evidence for a
different commit, event, branch, repository, workflow, or conclusion.

The ref is create-only with an absent-ref lease. An existing ref is accepted
only when it already points to the identical target; a conflicting SHA fails.
Afterward the workflow reads the publication ref, `runtime-candidate`, and
`production-deploy` from origin and fails unless the ref equals the target and
both mutable authorities remain unchanged.

Only after a successful publication may an operator separately dispatch
`controlled-runtime-candidate-promotion.yml`, using this precise ref as
`expected_published_ref`. Publication alone neither authorizes nor triggers
that promotion or a production deploy.
