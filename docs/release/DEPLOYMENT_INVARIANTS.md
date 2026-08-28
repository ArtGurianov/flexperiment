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

## `main` is never an implicit deploy target

Three identities, kept structurally distinct:

```text
main              = deployment-controller / integration history; CI only;
                    NEVER implicitly means "deploy this SHA"
runtime-candidate = the exact candidate authority pointer, moved by its own
                    explicit CAS act (mirroring production-deploy's own
                    discipline) — publishing a candidate is a pure
                    declaration of intent and triggers nothing by itself
production-deploy = the exact last successfully deployed runtime (see above)
```

`controlled-production-deploy.yml` lives on `main` (the default branch, as
`workflow_dispatch` requires) and triggers **only** on manual
`workflow_dispatch` — never on any `push`, to `main` or to any other branch.
Moving `runtime-candidate` does not, by itself, deploy anything: a GitHub
Actions `push` event always runs the workflow version present at the pushed
ref, so a workflow file living only on `main` could never reliably govern a
`push`-triggered deploy off a separate `runtime-candidate` ref in the first
place — this is why the workflow is dispatch-only rather than push-triggered
against that ref.

Inside the run, three identities are kept explicitly distinct end to end and
never conflated:

```text
CONTROLLER_SHA = github.sha            (this workflow's own commit)
CANDIDATE_SHA  = git rev-parse origin/runtime-candidate,
                 or the explicit recovery target_sha input
PRODUCTION_SHA = scripts/read-production-deploy-ref.sh
```

`CONTROLLER_SHA` **MUST NOT** be used as the candidate SHA, `source_commit`,
Coolify deploy target, `production-deploy` CAS target, or release-control
acquire target. An ordinary (non-recovery) dispatch takes no candidate SHA
input at all — only an optional `expected_candidate_sha`, a defensive check
that must equal the exact SHA already at `runtime-candidate` or the run
refuses; the actual candidate is always read fresh from the ref itself.

Before any production mutation, the workflow proves, from that resolved
candidate (never by inferring one from `main` or from its own commit):

- the candidate is a descendant of the current `production-deploy`, with
  **no merge commit anywhere in that exact range** — an ordinary runtime
  candidate is a strictly linear chain, so a side lineage cannot enter
  runtime history through a merge that itself carries no
  `.release/maintenance-only` marker (`scripts/inspect-runtime-candidate-topology.sh`,
  a pure read-only verifier that examines every commit's own tree along the
  path, not just the candidate's tip or an aggregate diff — a later commit
  deleting the marker file does not erase the historical fact that a
  maintenance commit occurred, since the check walks the whole range);
- no commit in that exact range carries `.release/maintenance-only`;
- `production-deploy` still equals the value read at the start of the run
  (`scripts/read-production-deploy-ref.sh`, read again immediately before
  the CAS move);
- `runtime-candidate` still equals the value resolved during preflight,
  reread immediately before the first durable mutation (the "Acquire owner
  and pause registrations" step) — but **only up to that point**. Once
  acquire/pause has actually run, the durable owner (`deploy-<candidate>`)
  is authoritative; `runtime-candidate` is free to move again afterward
  without stranding the paused deployment already in flight, so this
  freshness check does not repeat after the first mutation.

A recovery (`workflow_dispatch` with an explicit `target_sha`, resuming an
already-owned, already-paused same-owner deployment) acts under its own
separate authority and explicitly waives the descendant/linear/maintenance-
lineage rule above — it is recovering a specific already-authorized SHA, not
selecting a new one.

### Controller code never executes from the candidate's tree

The workflow performs exactly one checkout, at its own commit
(`ref: ${{ github.sha }}`) — the candidate SHA is never checked out as the
working tree. Every script invoked to reason about or gate the deployment
(`scripts/read-production-deploy-ref.sh`, `scripts/inspect-runtime-candidate-topology.sh`,
`scripts/set-production-deploy-ref.sh`, the `commerce:production-deploy:*`
policy tooling) runs from that controller checkout, at controller-relative
paths. The candidate SHA is touched only through read-only Git object reads
(`git show`, `git cat-file`, `git diff`, `git ls-tree`) to compare specific
file contents — never `git checkout`, and never executed. A candidate commit
therefore cannot ship a same-named script that approves itself: the
controller's own copy is what always runs, regardless of what the candidate
contains at that path.

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

## Coolify webhook acceptance is not deployment convergence

`scripts/controlled-coolify-deploy.sh` treats an HTTP 2xx from a Coolify
deploy webhook as only an enqueue acknowledgement, never as evidence that a
deployment has started, let alone finished - every controller that calls it
is expected to prove the deployed source independently afterward, from the
Commerce/frontend/admin surfaces themselves.

**Do not assume webhook acceptance implies deployment starts promptly.**
During the 2026-08-27 R5 post-CAS recovery deploy, the webhook call and the
subsequent container `create` both happened within seconds of each other (as
expected), but the container did not actually `start` until roughly 90
minutes later. A controller budgeting a short fixed settling delay plus a
few minutes of bounded polling (as every controller in this repo did at the
time) will time out and have to be cancelled even when the deployment
eventually succeeds cleanly - this is a false failure of the *controller*,
not evidence of a bad deployment, and must not be treated as one (do not
roll back `production-deploy`, reopen, or otherwise react to it as a real
production defect without first checking, read-only, whether the deployment
actually converged after the controller gave up).

This is an open, unresolved gap in controller design, not yet fixed: no
controller in this repo currently has a reliable way to distinguish "still
slowly progressing" from "genuinely stuck," because none of them inspect
Coolify's own deployment status - they only guess a fixed delay/poll budget
and then check the resulting runtime surfaces. Closing this gap requires
first establishing, empirically, whether Coolify's webhook response body (or
its own API) exposes a stable deployment identifier/status a controller
could poll directly - this has never been verified in this repo, and no
controller should assume its shape without checking. Until it is verified,
prefer decoupling a deploy trigger from its convergence proof (a separate,
purely read-only, freely re-dispatchable verification step/workflow with a
realistic budget) over simply inflating a single job's poll-attempt count,
since a combined submit+verify job that times out cannot be safely re-run
without re-triggering the mutation it already performed.

## Runtime-dependent parsers must be pinned to the exact runtime they judge

A controller is authored and published from `main`, but `main` and the
R-lineage (R3/R4/R5/R6/...) are deliberately separate identities - a
runtime-candidate fix (like R4's migration-allowlist entry) lives only on
that lineage and is never merged back into `main`. **A controller must
never interpret runtime release evidence using runtime-semantic code
checked out from `main` when the runtime artifact it is judging lives on
a different immutable lineage.** `main`'s copy of that code reflects
`main`'s own history, not the exact runtime commit whose evidence is being
parsed - the two can and do disagree about what a valid migration, legal
baseline, or readiness shape looks like.

This bit on 2026-08-28: `controlled-r6-same-owner-submit.yml`'s first
dispatch called `commerce/src/assert-generic-production-deploy-ready.ts`
directly from the controller's own `main` checkout to evaluate R5's live
readiness. That script imports `release-control.ts`'s
`evaluateReopenGate()`, which rejects any migration absent from
`requiredMigrationsByExpectedMigration` - and `main`'s own copy of that
map has never received R4's fix (adding `0036_tochka_provider_error_evidence.sql`),
because that fix lives only on the R-lineage. The run therefore failed
with `UNKNOWN_EXPECTED_MIGRATION` for an entirely healthy R5, before any
mutation. **This is also the corrected, more specific explanation for why
the earlier R5 post-CAS recovery workflow's poll loop never had a single
successful iteration**: on top of the genuine ~90-minute Coolify liveness
gap documented above, its poll's own readiness check (the same
main-checked-out parser) was a second, independent, always-failing
blocker - that run's `UNKNOWN_EXPECTED_MIGRATION`-shaped symptoms must not
be read as evidence of a bad R5 runtime.

**Fix pattern**: materialize an isolated, detached `git worktree` at the
exact runtime SHA being judged (e.g. `git worktree add --detach "$DIR"
"$RUNTIME_SHA"`, then prove `git -C "$DIR" rev-parse HEAD` equals that
exact SHA), install that worktree's own dependency graph from its own
lockfile once - never inside a retry/poll loop - and run the readiness
parser from inside that worktree (`cd "$DIR" && node --import tsx
commerce/src/assert-generic-production-deploy-ready.ts
<absolute-path-to-evidence-files> ...`), passing the controller's own
evidence files by absolute path (e.g. `$GITHUB_WORKSPACE/status.json`)
since the working directory has changed. **Dependency materialization
must disable lifecycle scripts** (`pnpm install --frozen-lockfile
--ignore-scripts`): only the one explicitly named readiness parser is
authorized to execute from the runtime tree - a plain install may run
arbitrary package install/postinstall/build scripts from that tree, which
is a materially broader trusted-execution surface than "run this one
script," especially in a job that also holds production mutation
credentials (Coolify's included). A submit-style one-shot controller pins
to the runtime it is leaving; a verify-only controller pins to the runtime
it is proving converged. This is a narrow, deliberate exception to
"controller code never executes from the candidate's tree" above: here the
controller is not executing untrusted candidate code as itself, but is
deliberately invoking one specific, already-reviewed, already-deployed
runtime's own semantics to judge evidence about that same
runtime - the two are exact opposites, not the same mistake.
