# Deployment invariants

These invariants govern every production controlled deploy and recovery. They
are intentionally independent of the current `HEAD`, `main`, and any one
workflow implementation.

The operational helpers in `scripts/` are diagnostic and verifier tools only.
They do not authorize a deployment, pointer update, release-control mutation,
or reopen. They report facts and boolean invariants only; release-state
classification and every next-action decision remain in the tested controller
code and recovery runbooks. A helper must not emit a recommended action or a
parallel controller state such as `RESUMING_POSTPUBLICATION_REPAIR`.

## Durable release state is authoritative

- A paused or owned release **MUST** be classified from durable
  release-control state before any mutation.
- `HEAD` and `main` **MUST NOT** replace a paused or owned release merely
  because they are newer.
- A matching durable owner **MUST** be resumed through its defined protocol;
  a foreign owner **MUST** stop recovery.

## Controller and deployment source are separate identities

- The controller/workflow SHA and `TARGET_SHA` **MUST** be treated as distinct
  values.
- Newer controller code **MAY** recover an exact target already authorized by
  durable state.
- Controller code **MUST NOT** silently become the deployment source,
  expected source, repair source, or promotion source.

## `production-deploy` is a mutable deployment pointer

`refs/heads/production-deploy` may move to an authorized exact source SHA even
when that source has unrelated history relative to its old value. Lack of a
fast-forward relationship to the old pointer is **not** an error.

This does not authorize arbitrary rewriting:

- The target **MUST** already be authorized by the controlled workflow and its
  durable state.
- The setter **MUST** observe one exact remote SHA, update with
  `--force-with-lease` for that observed SHA, re-read the ref, and prove exact
  equality with the requested target.
- Plain `--force` **MUST NOT** be used.

## Paused and owned releases

While a release is paused or owned:

- do not start a fresh release;
- do not change target without an explicit durable transition protocol;
- do not manually reopen sales;
- do not deploy arbitrary `HEAD` or `main`;
- classify durable state and resume the existing owner exactly.

A same-owner recovery preserves the release ID, mode, target, legal
expectations, and migration expectations unless its documented transition
explicitly changes one of them.

## Promo Codes v0 controlled epoch

Promo Codes v0 is a separate controlled epoch. Its v2 event chain is ordered
by `release_sales_gate_events.rowid`, never timestamps. While its owner is
active, the projection and replayed generation head must agree or sales fail
closed with `RELEASE_STATE_CORRUPT`. A completed head instead requires an empty
owner and open sales. Recovery is forward-only and same-owner: it adopts a new
generation while preserving the release ID and legal baseline; it never rolls
back or silently reopens sales.

## Legal cutovers

Before legal publication, a validated repair may be adopted only through the
pre-publication repair protocol. After publication, a new repair **MUST NOT**
be adopted: recovery uses only the exact durable repair or promotion SHA.

Promotion starts from the exact repair identity. A promotion commit is a direct
child of that repair (`promotion^ == repair`), has an immutable promotion ref,
and contains only the allowed canonical legal-promotion diff. Controller
commits **MUST NOT** be in promotion ancestry. A controller ref may contain the
repair in its history only when controller-only commits do not contaminate the
promotion ancestry.

See [generic recovery](../runbooks/GENERIC_DEPLOY_RECOVERY.md),
[legal cutover recovery](../runbooks/LEGAL_CUTOVER_RECOVERY.md), and
[recovery branch topology](../runbooks/RECOVERY_BRANCH_TOPOLOGY.md).
