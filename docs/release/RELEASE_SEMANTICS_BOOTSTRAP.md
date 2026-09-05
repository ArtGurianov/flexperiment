# Release-semantics bootstrap: P -> B2

Production today runs `P = 24a382929740a7ead6fb0bb49f5ffc77e063c77a`. `P`'s
own wire schema (`commerce/src/types.ts` at that commit) accepts only
`mode: "CONTROLLED_CUTOVER"` on `POST /v1/internal/release-control/acquire` -
`mode: "ROLLING"` is rejected at the Zod boundary before it ever reaches
`commerce/src/release-control.ts`'s domain logic, even though that domain
logic already fully supports `ROLLING` (it does today, on protected `main`,
independently of this bootstrap and independently of any feature that needs
it - see the file itself and `commerce/test/release-control-rolling.test.ts`).

Any feature whose production controller needs to acquire release ownership
with `mode: "ROLLING"` - the only way to run a controlled rollout without
pausing sales - is therefore structurally blocked while production runs `P`,
regardless of how correct that feature's own candidate is. Calling a
`ROLLING`-only capability against live production before that capability is
deployed is not a bug in the feature; it is a bootstrap ordering problem this
document exists to close.

## What this bootstrap is

A single, one-time, detached commit `B2` with `B2^ == P`, whose only content
is:

```text
commerce/src/release-control-schema.ts   CREATE
commerce/src/api.ts                      MODIFY
```

`release-control-schema.ts` is adopted **verbatim** from the already-reviewed,
already-tested file protected `main` has long carried (it already exports
`mode: z.enum(["CONTROLLED_CUTOVER", "ROLLING"])` and the inert-in-B2
`completeRollingSchema`). `api.ts`'s only change is a two-line import move:
`releaseControlSchema` moves from the legacy inline export in `./types` to
this new dedicated schema module - no route is added, removed, or rewired.

`commerce/src/release-control.ts` - the domain-level state machine - is
**byte-identical** between `P` and `B2`. This bootstrap adds no new logic; it
only makes an already-existing, already-tested domain capability reachable
through the HTTP/Zod wire boundary. `commerce/test/release-semantics-bootstrap-candidate-materialization.test.ts`
proves this identity directly, alongside the reconstruction proof itself.

Deliberately excluded from `B2`, by construction: any Agent Referrals file,
route, table, migration, UI, legal change, or activation path. `B2` grants
exactly one capability - `POST /acquire mode=ROLLING` succeeds instead of
failing wire validation - and nothing about *completing* a ROLLING release
(no `/complete-rolling` route, no feature-specific dormant-readiness
predicate). A feature that actually needs to complete a ROLLING rollout
supplies that itself, on top of `B2`, as its own candidate's `BASE`.

## RECONSTRUCTION_BOUND

`B2` is detached from protected `main` by construction (`P` itself is not an
ancestor of `main` - the two histories diverged before this bootstrap - so
`B2`, being `P`'s direct child, cannot be one either). The ordinary
`git merge-base --is-ancestor "$TARGET_SHA" "$CONTROLLER_SHA"` admission every
other release-semantics deploy is held to (`controlled-release-semantics-cutover.yml`)
cannot and does not accept it - and that lane is not modified to accept it;
its ordinary admission remains exactly as strict as before for every other
release-semantics change.

`B2` is instead authorized the same way Agent Referrals' own detached
candidate `Q` is: a certified, patch-based `RECONSTRUCTION_BOUND` proof,
positively enforced by `commerce/test/controller-not-older-than-target.test.ts`.
The reconstruction core (`commerce/src/controlled-candidate.ts` and its CLI
wrapper `commerce/src/controlled-candidate-verify.ts`) is a mechanical,
behavior-preserving generic extraction of `commerce/src/agent-referrals-candidate.ts`'s
already-reviewed model - every invariant that file's own docstring and tests
establish (BASE pinned, `SOURCE_MAIN_SHA` pinned and proven an ancestor of the
trusted controller, patch bytes pinned by both Git blob SHA and SHA-256, base
and result blobs pinned, tree independently reconstructed and cross-checked,
full commit envelope pinned, exact changed-path manifest, `public/legal/**`
and `commerce/legal/**` permanently forbidden) is unchanged. `agent-referrals-candidate.ts`
itself is untouched by this bootstrap - a separate, later consolidation may
turn it into a thin binding over the generic core once the two files' models
agree end to end.

## Certificate location

```text
.release/controlled-candidates/release-semantics-bootstrap-24a382929740a7ead6fb0bb49f5ffc77e063c77a/certificate.json
```

```text
BASE             24a382929740a7ead6fb0bb49f5ffc77e063c77a
SOURCE_MAIN_SHA  08f21d2293fcc1d908b2cfe23c0b64d8c4ef7e9f
B2               f540b997d6d31a22293909ded7ce464c3f51732f
B2 tree          5d1f623d142f18b4e07c421ac092dac0103c452a
```

## Control plane (dormant)

Both workflows are **manual-only** (`workflow_dispatch` only) and gated by the
`production` environment's required-reviewer approval. Merging this bootstrap
executes neither.

- **`.github/workflows/controlled-release-semantics-bootstrap-candidate.yml`**
  - publication only. Reconstructs the exact certified `B2` from this
  controller's own tree, then pushes that exact commit to a fresh,
  generation-numbered ref: `refs/heads/runtime/release-semantics-bootstrap-<generation>`
  (**flat**, a single path segment - see "Incident: nested publication ref"
  below for why this is load-bearing, not stylistic). It never moves
  `runtime-candidate` or `production-deploy`, never deploys anything, and
  never applies a migration.
- **`.github/workflows/controlled-runtime-candidate-promotion.yml`** - the
  existing, generic, **unmodified** promotion lane. Its own topology
  requirement (target published under `refs/heads/runtime/*`, and a
  descendant of the current `production-deploy`) is satisfied by `B2` without
  any change to that workflow: `B2^ == P == production-deploy` at bootstrap
  time. Its candidate-branch discovery (`git for-each-ref --contains ...
  'refs/remotes/origin/runtime/*'`) uses a single-`*` glob that never crosses
  a `/` - the publication ref above must stay flat for this lane to find it.
- **`.github/workflows/controlled-release-semantics-bootstrap.yml`** - the
  dedicated production controller. Reuses the exact same `CONTROLLED_CUTOVER`
  pause/CAS/deploy/reopen machinery `controlled-release-semantics-cutover.yml`
  uses, with its one ancestor-of-controller admission replaced by the full
  `RECONSTRUCTION_BOUND` certificate proof above. This bootstrap release is an
  ordinary `CONTROLLED_CUTOVER`, never `ROLLING` - it does not use the
  capability it delivers on itself.

## Recovery semantics

`FROZEN_BASE_SHA` (`P`, pinned in the certificate and the controller) and the
live, observed `production-deploy` pointer are two distinct identities and
must never be conflated - a rerun after a partial CAS must still be
understood as a same-release recovery of the one certified `B2`, never as a
new release whose `BASE` silently became `B2`. The controller reuses the
existing generic reconciliation classifier (`commerce/src/reconcile-generic-production-deploy.ts`)
against durable state rather than hand-rolling a weaker recovery model.

## Incident: nested publication ref (resolved)

The bootstrap's first production execution attempt published `B2` to a
**nested** ref, `refs/heads/runtime/release-semantics-bootstrap/bootstrap-1`
(two path segments under `runtime/`). Phase 1 (publication) succeeded exactly
as designed - the ref resolved to exact `B2`, and `production-deploy`/
`runtime-candidate` were correctly left untouched.

Phase 2 (`controlled-runtime-candidate-promotion.yml`, run `33969206791`)
then failed, before any CAS or other mutation, with
`RUNTIME_CANDIDATE_TARGET_NOT_PUBLISHED_RUNTIME_BRANCH`. Root cause: that
lane's own candidate-branch discovery,

```bash
git for-each-ref --format='%(refname:short)' --contains "$INPUT_TARGET_SHA" 'refs/remotes/origin/runtime/*'
```

uses a single-`*` glob that matches exactly one path segment - it does not
cross a `/`. Every other real `runtime/*` branch in this repository
(`runtime/abort-transition`, `runtime/bugfixes-7-r7`,
`runtime/epoch-a-dormant-notifications`, ...) is a single flat segment; the
bootstrap's nested shape was the one exception, and the unmodified,
already-reviewed promotion lane correctly never accepted it. No authority ref
(`production-deploy`, `runtime-candidate`) moved as a result of this failure.

**Fix**: the publication namespace is now canonically **flat**,
`refs/heads/runtime/release-semantics-bootstrap-<generation>` (a hyphen, not
a `/`, before the generation label). `controlled-runtime-candidate-promotion.yml`
itself was not touched - the shared lane's admission stays exactly as strict
as before for every other candidate; only the bootstrap's own publisher and
production controller changed to speak the namespace that lane can already
discover.
`commerce/test/release-semantics-bootstrap-promotion-compatibility.test.ts`
proves this against real Git (the exact discovery command, not a text
assertion): the flat shape is found, the legacy nested shape is not, and the
two coexist without conflict.

The legacy nested ref, `refs/heads/runtime/release-semantics-bootstrap/bootstrap-1`,
is retained untouched as immutable provenance of that first publication - it
is not deleted, moved, or renamed - but it is no longer canonical and is not
accepted by the updated production controller.

A fresh publication under the flat namespace,
`refs/heads/runtime/release-semantics-bootstrap-2`, was subsequently run and
succeeded, resolving to exact `B2`. `controlled-runtime-candidate-promotion.yml`
was then run against it and also succeeded: `runtime-candidate` was promoted
to exact `B2`, with `production-deploy` correctly left untouched at `P`.

## Incident: dependency install ordered after its first use (resolved)

With publication and promotion both complete, the dedicated production
controller (`controlled-release-semantics-bootstrap.yml`, run `33971946073`)
was dispatched for the first time against real production. The run passed
the `production` environment's required-reviewer approval gate and began
executing, then failed four steps in, at "Read the frozen bootstrap
certificate and reconstruct B2":

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /home/runner/work/flexperiment/flexperiment/
```

Root cause: that step invokes `node --import tsx commerce/src/controlled-candidate-verify.ts ...`,
but the `pnpm/action-setup` / `actions/setup-node` / `pnpm install --frozen-lockfile`
block that installs `tsx` was positioned *after* it in the workflow file - a
step-ordering defect, not a semantic one. It never surfaced in any prior
review or CI run because every environment that exercised this file before
production (local development worktrees, this repository's own `Test`
workflow) already had `node_modules` present from an unrelated install step,
which masked the missing ordering dependency. A fresh GitHub-hosted runner
for this workflow's own job has none.

This failed before acquire, pause, or any CAS - `production-deploy` remained
exactly `P` and `runtime-candidate` remained exactly `B2` (unchanged from the
successful promotion above); no production consequence occurred.

**Fix**: the dependency-install block now runs immediately after the cheap,
dependency-free controller/main-identity and production-deploy-pointer
checks, and before the certificate-reconstruction step that needs `tsx` -
strictly earlier than every other command in this file that depends on
installed packages. No other step in the file was found to depend on
installed packages before that same install block.
`commerce/test/controlled-release-semantics-bootstrap-workflow.test.ts` now
asserts this ordering directly against the real workflow text and fails if
install is ever moved back below reconstruction.

## Terminal record

None. `B2` has not been deployed or activated. `production-deploy` remains
`P`; `runtime-candidate` remains `B2` (promoted, not yet deployed). This
bootstrap is **not yet terminal**: publication (Phase 1, under the corrected
flat namespace) and promotion (Phase 2) have both succeeded; the production
controller (Phase 3/4) has not yet succeeded, having failed once on the
dependency-ordering defect above, now fixed and awaiting its own execution
attempt.

## Relationship to Agent Referrals

Agent Referrals' own detached candidate (`docs/release/AGENT_REFERRALS_BOUNDARY.md`)
remains frozen at its current intermediate identity
(`TARGET_Q = 4fcb20d1aee98c9b6892846ec0bc40666f586870`) throughout this
bootstrap. That identity is not final production identity: once this
bootstrap is reviewed, merged, and executed (`production-deploy == B2`),
Agent Referrals must be rematerialized exactly once more with `B2` as its new
`BASE` (`Q2^ == B2`), closing the bootstrap circularity this document exists
to resolve. This bootstrap PR does not perform that rematerialization and
does not modify Agent Referrals' own certificate, migrations, or product
runtime in any way.
