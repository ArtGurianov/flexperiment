# Generic controlled deployment recovery

Use this runbook only for an interrupted generic controlled production deploy.
It is recovery-only, not an arbitrary manual deployment API.

## Stop and inspect first

Before any mutation, perform read-only inspection and record:

- `sales_paused`
- `owner_release_id`
- `owner_mode`
- `expected_source_commit`
- `runtime_source_commit`
- `worker_source_commit`
- `legal_version`
- `current_legal_copies_match`
- `completion`

Capture this snapshot with:

```bash
scripts/print-production-recovery-state.sh
```

On a VPS without an exported token, pass `--container <exact-commerce-container>`;
the helper fails rather than selecting an ambiguous container. To inspect a
completed release after its owner has cleared, pass `--release-id <release-id>`.

Use the durable record, not `HEAD`, `main`, or a controller branch, to decide
what may happen next.

| Durable state | Action |
| --- | --- |
| Sales open and no owner | This is a normal deploy, not recovery. |
| Paused, owner is `deploy-<TARGET_SHA>`, expected source is `TARGET_SHA`, incomplete | Resume that same owner and exact target. |
| Paused with a foreign owner | Stop. Do not move the pointer or create a release. |
| Expected source differs from intended target | Stop. Resolve through an explicit durable protocol. |
| Completion is complete | Verify or reconcile; never blindly recover. |
| Partial runtime/surface convergence | Continue only toward the exact durable target. |

## Same-owner recovery

The controller ref may differ from `TARGET_SHA`; it supplies recovery code, not
deployment content. Validate that `TARGET_SHA` is an exact commit and use it
for all candidate-content checks, the deployment pointer, deployment, and
readiness proofs.

When the table permits same-owner recovery:

- do not acquire again;
- do not pause again;
- do not rewrite expectations unless a defined protocol requires it;
- retain the exact release ID, mode, and target;
- set `production-deploy` by exact CAS, then deploy and prove readiness;
- guarded reopen is allowed only after exact runtime, worker, frontend, admin,
  health, and readiness evidence succeeds.

Never run `git pull` to solve a pointer non-fast-forward rejection. Never use
plain force. The pointer update is: read one remote SHA, force-with-lease from
that SHA to the authorized target, re-read, then prove the exact postcondition.

After recovery, record completion. The incident is not closed until durable
completion is true and post-reopen evidence proves the exact target.

See [deployment invariants](../release/DEPLOYMENT_INVARIANTS.md).
