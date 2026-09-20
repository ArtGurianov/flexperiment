# Deployment invariants

What must be true for a deploy to be safe, and who enforces it. It describes
the system as it is. Where an invariant is enforced by code, the code is named;
where it is proved by a test, the test is named in
[`docs/INVARIANT_REGISTRY.md`](../INVARIANT_REGISTRY.md).

This document is not a runbook and not a history. It replaced 1,133 lines that
had become a record of controllers, epochs and generations that no longer
exist - a document describing a mechanism is worse than no document once the
mechanism is gone, because it is read as normative. The reasoning worth keeping
is below; the incidents that produced it are in the git history.

## Authority and observation are different things

The single distinction everything else rests on:

```text
authority    what may change production, and what decides whether it may
             -> ReleaseCandidate, DeploySessions, the certification authorities

observation  what production currently says about itself
             -> the three surfaces' source commits, /v1/admin/system/evidence,
                public/release.json, the git refs the identity readout prints
```

A git ref that someone reads is an observed fact. `production-runtime-identity-
readout.yml` fetches `production-deploy` and `runtime-candidate` and prints
them; that is reporting, not authority, and no part of the deploy path moves
them. The controllers that once treated those refs as authority are gone, and
nothing should reintroduce a pointer as a decision-maker without saying so here
first.

## Three identities, kept structurally distinct

```text
main              integration history, and CI. Never implicitly a deploy target.
candidate         the exact commit a deploy is for, together with its release
                  class and its readiness expectation - one fact, not three
controller        the workflow and code performing the deploy
```

The controller's own SHA and the candidate's SHA are distinct values. Newer
controller code may recover a target that durable state already authorized; it
must never silently become the deployment source, the expected source or the
promotion source. A deploy is for a candidate, and an operator cannot name a
commit instead. `deploy-production.yml` takes a verb and the argument that verb
means - a candidate path for `deploy`, a session id for `resume` and
`rollback` - and nothing that names a commit, a ref, a branch or a release
class.

## A candidate is published only against its own green CI

`release-candidate.yml` verifies the exact commit: forty hex characters, an
ancestor of `origin/main`, and `test` and `docker-build` both `success` **for
that sha**. Being descended from a green commit is a different claim about a
different tree.

A `LAUNCH_BASELINE` candidate must additionally be the current tip of `main`.
It replaces the database, so publishing an ancestor would deploy a tree `main`
has already moved past with no way back to the commits between.

## The deploy mode is derived, never chosen

`ROLLING_COMPATIBLE` earns `ROLLING_SAFE`; everything else takes
`MAINTENANCE_CUTOVER`. The absence of a compatibility proof is not
compatibility.
An operator who could select the rolling path for a schema-incompatible release
would skip the fence and the certification with it, so the choice belongs to
whoever classified the candidate.

The two differ in exactly one thing that matters here: `ROLLING_SAFE` never
closes the deployment gate, and `MAINTENANCE_CUTOVER` always does. A rolling
release that closed sales, and a maintenance cutover that did not, are both
simply wrong, and the schema refuses to record either.

## Webhook acceptance is not deployment convergence

A 2xx from a deploy webhook is an enqueue acknowledgement. It is not evidence
that a deployment started, and certainly not that it finished. Convergence is
proved afterwards, independently, by observing what the frontend, admin,
commerce and worker surfaces actually serve.

Nor does acceptance imply promptness: a deploy has been observed where the
webhook call and the container `create` happened within seconds of each other
and the container did not `start` for roughly ninety more. A controller that
treats acceptance as progress will report a converged deploy that has not begun.

## Readiness separates "not yet" from "converged and inadmissible"

A convergence loop is read-only, and the two failure classes it meets are not
the same:

- **Observable rollout surfaces** - health, readiness, the surfaces' own
  descriptors - may legitimately be absent, incomplete or briefly malformed
  while a deploy is in flight. A truncated body from a restarting container is
  expected transient behaviour, and a parse failure there is retryable exactly
  like a connection timeout.
- **Semantic and authority evidence** - the source commit, the schema
  inventory, the legal version and manifest digest - does not become correct by
  waiting. A mismatch or an unparseable value there is terminal.

`evaluateReadiness` encodes this: malformed evidence is `REJECTED`, while a
commit that has not converged, a stale heartbeat or a sweep that has not
happened are `PENDING`. Collapsing the first into the second makes a loop wait
forever on something no amount of waiting can fix.

## A fresh launch database is brought up in one order, and part of it is a person

```text
0001_launch_baseline          schema, plus its own zero state: schema_identity,
                              the singletons, the advertising policies, the
                              feature state at ACTIVE
commerce:launch-seed          city reference data, and nothing else. Idempotent
                              by digest: the same catalogue repeated is a
                              success, a different one is refused
bootstrap the admin account   a provisioning command, never carried in a dump
create and publish the        AN OPERATOR STEP, through the admin surface
  certification occurrence
commerce:legal-release        preflight -> publish -> promote, so the
                              publication ledger is real rather than seeded
readiness                     every surface converged on the target
the one-rouble certification  payment, webhook, email, refund, finality
open public sales
```

**Occurrences are not seeded, and the catalogue format has no field for them.**
They are content a person schedules, and the certification occurrence is one of
them - so a checkout cannot be certified until that step has been done by hand.
Naming it here is the point: a field that was only ever allowed to be empty
would have implied the seed provides something it does not.

## Sales are closed by a hierarchy, and only one level is bypassable

```text
effective_sales_closed =
      emergency gate        operator's own stop, absolute, fail-closed
   OR business gates        ordinary product rules, absolute
   OR deployment gate       held by one deploy session, bypassable
```

The emergency gate reads a missing row as closed: losing the gate is not the
same as clearing it. A certification capability may open the deployment fence
and nothing above it.

## A deploy session owns both its state and its fence

One authority owns the session and the deployment gate, because they are one
operational fact. A `SUCCEEDED` session with sales still shut, or a rolling
release that closed them, are both simply wrong, and no amount of caller
discipline makes two independent writes safe.

```text
ACQUIRED -> FENCED -> DEPLOYING -> SAFE_ABORTED | SUCCEEDED | ROLLED_BACK
                               \-> RECOVERY_REQUIRED (non-terminal)
```

Only `SUCCEEDED` means the release is deployed. `ROLLED_BACK` permits sales to
reopen while the release remains unsuccessful; collapsing the two would let a
production that returned to the old revision be recorded as a successful
release of the new one.

Two orthogonal facts decide what is reachable:

```text
mutationObserved     has production been touched  -> is SAFE_ABORTED available
rollbackAuthority    is the archived database still truthful
                     OLD_LINEAGE_ALLOWED -> NEW_LINEAGE_ONLY, one way only
```

Authority is spent by `armExternalEffects()` **before** the first external
effect becomes possible, not after one is observed. Recording afterwards is the
same defect this codebase already refuses at the payment boundary: crossing an
outside boundary and then hoping to write down that it happened. A converged
topology is not an external effect and spends nothing - deploying four surfaces
changes nothing outside the system, and such a deploy must stay reversible.

## A safe abort has to prove two layers, not four surfaces

What production *is* has two layers, and a snapshot of one of them cannot
describe it:

```text
runtime       frontend, admin, commerce, worker   what production serves
controlPlane  production-deploy ref               what it will serve next
```

The three Coolify applications track that ref. A runtime restored to the old
commits while the ref names the target is not a production that was left alone;
it is one waiting to move again, and reopening sales in front of it reopens
them in front of a deploy that is still coming. So `SAFE_ABORTED` requires both
layers back where the pre-deploy snapshot found them, and there is deliberately
no call anywhere that answers with the runtime alone.

The two layers latch differently, and the asymmetry is the point. A deployed
surface cannot be un-deployed, so `mutationObserved` is monotonic and watches
the runtime only. A pointer *can* be put back, so the control plane is compared
against the current reading instead - if moving the ref latched the monotonic
bit, returning it could never restore a safe abort and the recovery path would
be unreachable. A stored snapshot carrying only four surfaces is refused as
malformed rather than completed with an assumed pointer: guessing where the
control plane was is exactly the reading that makes a safe abort unsafe.

## The release runner runs beside production, never inside it and never in CI

The controller is a one-shot process on the VPS, outside the three Coolify
applications. Both of the other placements fail the same way:

```text
inside `commerce`   the deploy replaces the controller mid-flight, between
                    mutating the topology and recording the terminal transition
inside the CI job   survival depends on a network the controller cannot
                    influence; a cancelled job or a dropped connection leaves
                    production fenced with nothing alive to release it
```

Either way the durable session survives owning a closed sales gate, and nothing
is left running that is allowed to open it. The workflow's entire job is to
start the runner over SSH and read its exit code; `12` means recovery is
required and sales stay shut, and no workflow may turn that into a retry.

The composition root fails closed **before the first mutation** when any
component is missing - the lock, the envelope directory, the database, the
archive directory, the deploy-ref credential, the Coolify token, the three
application identities, the two descriptor endpoints, the journal. It reports
every missing one at once, because discovering configuration one variable per
run means repeatedly starting a process against production that could take the
lock and open a session before failing on the next absent field.

A signal is not a way to open sales. `SIGTERM` and `SIGINT` record the
interruption and release the lock so a resume can run, and do nothing else: an
interrupted runner does not know whether production was mid-move, and finding
out is the next runner's job, by looking.

## A lease ends ownership; it never opens sales

An expired lease lets another runner take the session over. It does not prove
anything about production's topology, so it never reopens sales by itself. If a
fence is closed it stays closed until someone proves either the pre-deploy
topology or the target one.

## The database's lineage is checked before anything trusts it

A database is classified before migration, not after: empty and bootstrappable,
supported, legacy, or unknown. The last two fail closed. A runtime that
silently accepts a database from a lineage it was not built for is how a
restored backup becomes a corrupted production.

An empty ledger table with nothing built beside it is a bootstrap that has not
happened; a ledger that records versions is never one, whatever became of the
tables it built. An unread count is not an empty one.

**The reset window closed at the first real external evidence, not at the first
payment.** A payment is only the most obvious example: a partner's acceptance,
a legal consent, a submission to the advertising register, a real subscriber or
lead each close it just as finally. Before that the database was disposable and
the ledger could be replaced wholesale. After it, the schema is append-only
from `0002`, and a database is brought forward by migration or not at all.

## Three things the incidents taught

**Prove the fact at the seam that consumes it.** A safety property is enforced
where the orchestration actually consumes it, and nowhere else. Green unit tests
on a pure implementation are not evidence of enforcement; neither is a sentence
in this document, nor a comment stating the rule correctly above code that does
not call it.

**Make the bad state impossible at the transition, rather than proving it absent
beforehand.** An operator query run before dispatch cannot bind anything:
production may invalidate the answer between the query and the act. A freshness
window narrows that race and never closes it. The check belongs inside the
transition that depends on it.

**Corroboration must not be described as evidence it did not produce.** A check
that participates in admission fails closed. A best-effort probe that cannot
change the decision is fine, but it may be cited only when its output was
actually obtained and verified - a probe that returned a validation error and
was recorded as corroboration is worse than no probe, because the record claims
a check that never ran.

## Installing the release runner on the VPS

The workflow invokes one command, `flexperiment-release`, over SSH. It is a
root-owned wrapper on the release host, and it is where the configuration and
the credentials live - so nothing secret is passed over that connection, and
none of it appears in the workflow's environment or its log.

```sh
# /usr/local/bin/flexperiment-release        root:root, 0755
#!/bin/sh
set -eu
. /etc/flexperiment/release-runner.env       # root:root, 0600
export FLEXPERIMENT_RELEASE_DATABASE FLEXPERIMENT_RELEASE_ARCHIVE_DIR \
       FLEXPERIMENT_RELEASE_ENVELOPE_DIR FLEXPERIMENT_RELEASE_LOCK \
       FLEXPERIMENT_RELEASE_JOURNAL COOLIFY_API_URL COOLIFY_TOKEN \
       COOLIFY_APPLICATION_FRONTEND COOLIFY_APPLICATION_ADMIN \
       COOLIFY_APPLICATION_COMMERCE FLEXPERIMENT_FRONTEND_RELEASE_URL \
       FLEXPERIMENT_ADMIN_RELEASE_URL FLEXPERIMENT_DEPLOY_REF_REMOTE \
       FLEXPERIMENT_DEPLOY_REF_WORKTREE
exec pnpm --dir /srv/flexperiment release:runner "$@"
```

The envelope directory must be on the volume that outlives the containers
(`commerce-data:/var/lib/flexperiment`), because the whole reason the cutover
envelope exists is to survive the database being archived and the containers
being replaced. The lock and the journal may live beside it. The git worktree
holds the credential that may move `production-deploy` and nothing else: that
credential is not a general push credential, and the runner never writes to any
other ref.

`observe` mutates nothing and is the right preflight. It reports both layers of
the topology, the readiness evidence and the state of the deployment gate.
