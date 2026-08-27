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

## Runtime candidates and maintenance commits are different artifact classes

A commit that merges a runtime candidate with one-shot recovery/bridge
tooling (for review or audit) is a **maintenance commit**, not a deploy
target — even though the runtime candidate is its ancestor. Every recovery
plan **MUST** name three SHAs separately: the runtime-candidate SHA, the
maintenance/audit SHA, and the `production-deploy` SHA. A maintenance commit
**MUST NEVER** become `production-deploy`'s target merely because it is
newer or contains the candidate in its history.

A maintenance commit declares itself ineligible by committing a
`.release/maintenance-only` file (content is irrelevant; its presence in the
tree is the signal). `scripts/set-production-deploy-ref.sh` checks
`<target_sha>:.release/maintenance-only` before every CAS move and refuses
with `PRODUCTION_DEPLOY_TARGET_IS_MAINTENANCE_ONLY` if it exists. A runtime
candidate branch must never carry this marker; the marker is added only when
preparing the maintenance/audit merge, so it is never inherited by a clean
runtime candidate built from the same ancestor.

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

## Replay compatibility barrier

Before a new v2 ledger event kind is ever written to a durable release chain,
every runtime that may still be running (or could be restarted) **MUST**
already be able to replay it. A writer that doesn't understand an event kind
fails closed with `RELEASE_STATE_CORRUPT` on replay — that is correct
behavior, not a bug to route around.

This means a code change that introduces a new event kind and the write of
the first event of that kind **MUST NOT** leave a window where an
old, non-understanding runtime could still be running or restarted:

- Stop every writer/reader that depends on the ledger and is running code
  that predates the new event kind.
- Prove they are stopped before writing.
- Perform the write offline, through a one-shot bridge (see below), not
  through a live API a stale runtime could also call.
- Never restart the old runtime after the write. If a bridge appends more
  than one event (for example a defect event immediately followed by a
  generation-superseding event), it **MUST** do so in the same transaction:
  there must be no committed state in which an old runtime is asked to
  replay only the new kind without also being superseded.

`PUBLIC_FRONTEND_DEFECT` (added to unblock the gen4→gen5 recovery) is the
concrete precedent: it and the immediately following `CANDIDATE_SUPERSEDED`
are appended in one `BEGIN IMMEDIATE` transaction inside
`bridgeGenerationFourToFive`, specifically so old gen4 code is never asked to
replay an event kind it predates.

## One-shot recovery bridges are non-reusable by construction

A historical repair utility (`commerce/src/gen2-bootstrap-adopt.ts`,
`gen3-classify-readiness-defect.ts`, `gen4-to-gen5-public-frontend-bridge.ts`
are the existing examples) exists to perform exactly one durable transition,
once, for a specific incident. It **MUST NOT** become a generic
`repair-release --from --to` tool. Every such utility:

- hard-codes its release ID, from-generation, from-source-commit,
  to-generation, and to-source-commit — the caller cannot redirect it to a
  different transition;
- accepts no caller-selected replacement SHA;
- accepts only a fresh piece of state evidence that could not have been
  known at build time (typically `expected_state_hash`, read live
  immediately before the run);
- requires an explicit offline sentinel env var affirming the dependent
  services are stopped;
- pins its target replay implementation by SHA-256 and verifies that pin
  before opening the database;
- performs its entire mutation (including any second ledger event required
  by the replay compatibility barrier above) inside one `BEGIN IMMEDIATE`
  transaction, replaying and reconciling before and after commit;
- fails closed on a second invocation (`..._ALREADY_APPLIED`) without
  changing state;
- remains historical after use. Do not repurpose, parameterize, or extend an
  existing bridge for a new incident — write a new one, following this same
  shape, with its own hard-coded identities.

A bridge's `target_replay_sha256` and any other frozen historical pin
**MUST** be checked against the literal value recorded at the time the
bridge was built, not against the live `HEAD` of the file it pins — the pinned
file keeps evolving under later work, and the bridge's own provenance must
stay an immutable historical fact once the bridge has been executed.

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
[legal cutover recovery](../runbooks/LEGAL_CUTOVER_RECOVERY.md),
[recovery branch topology](../runbooks/RECOVERY_BRANCH_TOPOLOGY.md), and
[Promo Codes v0 cutover recovery](../runbooks/PROMO_CODES_CUTOVER_RECOVERY.md).
