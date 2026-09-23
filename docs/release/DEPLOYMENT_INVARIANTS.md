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

Publication is not a lease on `main`. The production runner refreshes
`origin/main` after taking its release lock and re-derives the launch candidate
from that exact commit immediately before either `prepare-bootstrap` or the
initial `deploy` may mutate anything. Historical candidate files remain valid
records, but fail consumption with `LAUNCH_BASELINE_MUST_BE_MAIN_TIP`. A session
whose mutation is already durable recovers its recorded target instead; a new
`main` must never retarget recovery.

## A launch cutover is two commands, and the second adopts the first

`prepare-bootstrap` archives the predecessor database and leaves the fresh
launch database standing in its place. From that moment there is no predecessor
left to read, so the `deploy` that follows cannot re-derive its own pre-deploy
snapshot — it adopts the one the envelope froze before the swap.

That is why a `LAUNCH_BASELINE` deploy names the cutover it is finishing:

```sh
flexperiment-release prepare-bootstrap <candidate> <expires-at> <cutover-id>
flexperiment-release deploy            <candidate> <cutover-id>
```

Omitting it is `LAUNCH_DEPLOY_REQUIRES_PREPARED_CUTOVER`, refused before any
mutation. Nothing but `prepare-bootstrap` creates the launch database, so a
launch deploy is always the second half of a prepared handoff and never a
standalone command.

Adoption happens once. A cutover whose session already exists is
`CUTOVER_ALREADY_ADOPTED`: that session owns the closed gate, and finishing it
is `resume`'s job, never a second `deploy`. The envelope is marked consumed only
after the successor database has committed the session, so a consumed envelope
with no session is a lost authority rather than an invitation to adopt again.

This seam is the one the suite previously missed. Both halves were proved in
isolation — the preparation wrote a correct envelope, and `adoptCutover` adopted
one correctly when called — while nothing called it. Invariants count only at
the seam that consumes them.

## Every state the runner produces has exactly one recovery owner

`prepare-bootstrap` crosses the destructive boundary *before* a successor
session exists. That intermediate state — envelope durable, predecessor
archived, launch database installed, sales fenced, nothing adopted — is a real
durable lifecycle state, and it is reachable even when everything works: the
deploy admission can refuse a candidate `main` moved past, after the
preparation has already run.

```text
before the envelope is durable   prepare-bootstrap cleans up internally
envelope durable, not adopted    rollback-prepared <cutover-id>
adopted, session exists          rollback <session>
external effects armed           forward recovery only
```

`rollback-prepared` is a separate command, not an overload: `rollback` means
"the successor session owns this cutover", and here there deliberately is none.
It refuses with `PREPARED_ROLLBACK_OWNED_BY_SUCCESSOR_SESSION` the moment the
envelope is consumed or a session has adopted it, so the two can never race.
It does **not** invent a session to satisfy the older model — the fact being
represented is that adoption never happened.

Both authorities drive one restore engine and one stage ladder, so a prepared
restore cannot drift into a second implementation that merely resembles the
real one. The receipt records which authority it answers to:

```ts
authority:
  | { kind: "SUCCESSOR_SESSION"; sessionId: string }
  | { kind: "PREPARED_CUTOVER";  cutoverId: string }
```

Two rules that are easy to get wrong. **Envelope expiry must not prohibit
rollback**: expiry is an admission condition for going *forward*, and cannot
revoke the ability to put the predecessor back — a cutover left overnight stays
recoverable. And the durable receipt is written **before** the first
irreversible step, because this command can itself die after replacing the
launch database with the legacy one, at which point the successor database is
no longer available to be anyone's recovery cursor.

## Coolify owns the containers, completely

The runner used to drive Docker directly: discovering containers by label,
capturing their ids, stopping them, proving retained image tags, and starting
those exact ids again. That was a second deployment control plane underneath
the one this project already runs, and it is what both 2026-09-23 production
incidents were made of. It has been deleted.

What the runner owns is what Coolify cannot:

```text
the sales gate
the SQLite backup, archive and restore
schema bootstrap
moving and verifying production-deploy
readiness and topology verification
```

Container lifecycle is Coolify's. "Stopped" is what the control plane reports
and what the runtime stops answering — never a container listing. "Started" is
a deploy of whatever the tracked ref names, which is why recovery moves the
pointer first.

`deploymentKind` remains configuration — frontend and admin are Dockerfile
applications, commerce is Docker Compose — and Coolify's reported `build_pack`
verifies it (`DEPLOYMENT_KIND_MISMATCH`). It no longer selects a code path,
because there is only one path left.

## Rollback restores a source commit, not an artifact

The invariant used to be:

```text
rollback = resurrect exactly the image and container that existed before
```

That premise is what forced image-retention proofs, container capture and a
bespoke Compose restoration into existence. It is now:

```text
rollback = restore the exact application source SHA and the exact predecessor
           database, then prove production topology and readiness
```

So recoverability is proved against the predecessor **commit** — that it is
still resolvable and deployable — rather than against an image inventory. One
mechanism serves every application, and the recovery order matters:

```text
sales already closed
→ Coolify stops commerce
→ prove it POSITIVELY exited, not merely "not running"
→ prove zero SQLite handles on the host
→ restore the exact predecessor database
→ production-deploy CAS back to the predecessor
→ Coolify deploys the predecessor
→ topology and readiness prove the predecessor
→ open sales
```

The database is restored **before** the pointer moves, not after. Moving a
branch the applications track can itself be a deployment trigger where
auto-deploy is enabled, so by the time the ref changes the legacy database is
already in place. Commerce is proved stopped before either happens, which is
what keeps the old runtime away from the successor database.

Dying between the restore and the CAS leaves an unpleasant but safe state -
commerce stopped, database LEGACY, ref still at the target, sales closed - and
the receipt reconciliation below is what continues from it.

## A migrated database is not yet a launch database

`prepare-bootstrap` runs `migrate`, and that alone produces a schema the
runtime cannot serve from: no cities, and `legal_releases` deliberately empty,
which readiness refuses with `LEGAL_RELEASE_EVIDENCE_MISSING`. Initialization
is therefore part of the preparation, in this order:

```text
migrate
→ launch seed (the committed catalogue)
→ publish the candidate's legal release
→ hand ownership to the runtime
```

It is an **ensure**, not a create-once. A crash between the schema and the rest
leaves a `SUPPORTED` database that is still unusable, and an early return on
"lineage is SUPPORTED" would call that finished. Both the seed and the legal
publication are idempotent for an exact replay, so re-running them is the safe
direction.

Ownership is handed over **last**, after every root-side write, and it covers
the sidecars as well as the main file. The runner is root; the runtime is not.
A database created here is root-owned and the container cannot open it — it
crash-loops, and because topology is read from that runtime, the recovery path
stalls with it. The contract is taken from the predecessor archive, which is
the file the runtime demonstrably could open, rather than from a hardcoded uid.

Known limitation: once the successor is installed the predecessor bridge is
gone, so `prepare-bootstrap` cannot be reconstructed in a new process. The
ensure above therefore protects a retry within the preparation, not a
cross-process retry after the swap. That gap is recovered through
`rollback-prepared`.

## An exit code describes what happened, not what was attempted

`20` means "refused before mutation". Once a successor session exists and the
envelope is consumed, it is no longer available: the pointer may have moved and
the applications may be deployed, and an operator reading `20` would reach for
`rollback-prepared` on an adopted cutover.

```text
before a session/adoption exists   an exception may legitimately be 20
once the session exists            any unexpected exception is RECOVERY_REQUIRED (12)
```

The same reasoning applies to `resume`: a runtime that cannot be observed is
frequently the reason a session needs resuming, so requiring a successful
observation to produce a recovery plan is circular. An unobservable topology is
reported as `RECOVERY_REQUIRED` with `TOPOLOGY_UNOBSERVABLE`, never as a safe
abort — absence of observation is not evidence of anything.

Cross-lineage `rollback <session>` may take over a **lapsed** lease itself. It
has an external receipt and does not need the successor's cooperation to begin,
and requiring an operator to re-supply the dead process's owner id made an
ordinary recovery depend on reading it out of the database by hand. A lease
that has not lapsed still belongs to whoever holds it.

## "Stopped" is a positive proof, never an absence

`POST /applications/{uuid}/stop` queues the request and returns. A single
status read afterwards proves nothing, so the runner polls for a positive
`exited` state and refuses everything else:

```text
exited:*                        stopped, continue
running:* starting:* degraded:* keep waiting, refuse at the timeout
unknown                         refuse
status absent                   refuse
```

Absent matters more than it looks: a token without visibility omits the field
entirely on this installation, and an implementation that collapsed that into
"unknown" and then tested for the word "running" would read an unreadable
runtime as a stopped one - and replace the database underneath it.

`lsof` stays as a second, independent proof. The control plane says the runtime
is stopped; the host says nothing is holding the SQLite file. Neither alone is
the evidence.

The stop is also issued with `docker_cleanup=false`. That parameter defaults to
true and prunes networks and volumes, and a cutover is the worst possible
moment to ask the control plane for housekeeping.

This accepts one real cost, deliberately: recovery depends on the build
pipeline at the moment it is needed. That is a smaller risk than maintaining a
second control plane to avoid it, and it is the reason readiness — not a
container state — is what admits a recovery as finished.

## The bootstrap is a one-time operation with an expiry date

The launch machinery below — the predecessor reader, prepared-cutover
envelopes, `rollback-prepared`, the bootstrap archive protocol and the LEGACY
lineage branches — exists to cross a lineage boundary exactly once. It should
be deleted after the first successful launch, leaving:

```text
publish candidate
→ CAS production-deploy
→ Coolify deploy
→ verify topology and readiness
→ on failure: CAS back, Coolify redeploy predecessor
```

## A receipt stage is reconciled against reality, never replayed

`RESERVED` records intent, not that storage is still where it was when the
intent was written. A process that died after the atomic restore but before
advancing the receipt leaves `RESERVED` over a database that is already the
predecessor; replaying the swap there would archive the predecessor as though
it were the successor.

So the stage is reconciled against the live lineage before it is acted on.
`SUPPORTED` means storage has not crossed and `RESERVED` is honest. `LEGACY`
with the exact archived predecessor in place means it has, and the receipt is
advanced to agree with reality. Anything else is `BOOTSTRAP_ROLLBACK_LINEAGE_UNACCOUNTED`.

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

## A cutover is finished by a person, and proved by a separate command

Certification is irreducibly attended: someone opens a mailbox and says the
ticket arrived, and the payment page reaches them on `/dev/tty` and nowhere
else. So the release is two dispatches and a proof.

```text
deploy   → fence, deploy, converge, readiness, issue a capability
         → exit 13, AWAITING_OPERATOR
         → fence shut, nothing spent, OLD_LINEAGE_ALLOWED intact
certify  → attended, on the VPS: read-only preflight, then arm, then buy
         → payment, ticket, refund, close and hide the fixture, settle
verify   → changes nothing, and is the only thing that proves a finished deploy
```

`13` is neither success nor failure. A workflow that retried it would re-enter a
cutover a person is in the middle of; one that failed it would report a broken
release that is merely waiting.

The capability is issued by `deploy` and its bearer is thrown away. It is
HMAC-derived from the capability's own binding under a versioned key only the
runner holds, and the database keeps the digest - so `certify` in a new process
derives the identical bearer, a read-only leak of the database is not a
capability, and a compromised runtime cannot mint one. A key may not be retired
while a non-terminal run issued under it still exists, which is why the runner
takes a keyring and not a key.

`armExternalEffects` sits between the preflight and the first request that can
create a payment. An unreachable runtime, a capability that cannot be
recovered, a catalogue that is not ready or an absent operator are all ordinary
refusals that leave the old lineage a legal destination. Once armed, a request
that never reached the provider still costs it - a window that cannot be
removed, only kept this small.

## Installing the release runner on the VPS

The workflow invokes one command, `flexperiment-release`, over SSH. It is a
root-owned wrapper on the release host, and it is where the configuration and
the credentials live - so nothing secret is passed over that connection, and
none of it appears in the workflow's environment or its log.

```sh
# /usr/local/bin/flexperiment-release        root:root, 0755
#!/bin/sh
set -eu
# Export every assignment in the root-owned configuration.  Keeping an
# explicit list here caused candidate publication and certification variables
# to be silently held in the wrapper shell rather than reaching the runner.
set -a
. /etc/flexperiment/release-runner.env       # root:root, 0600
set +a
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

The certification half needs more, and all of it is root-owned on the host:
`CERTIFICATION_ADMIN_BASE_URL` and `CERTIFICATION_PUBLIC_BASE_URL` for the
runtime being certified, `CERTIFICATION_ADMIN_TOKEN` for the service surface -
whose digest, not the token, is what the runtime holds in
`COMMERCE_CERTIFICATION_TOKEN_SHA256` - and `CERTIFICATION_CAPABILITY_KEY` as
`<version>:<base64url of at least 32 random bytes>`, newest first, which never
reaches a container. `CERTIFICATION_OCCURRENCE_SCOPE` and
`CERTIFICATION_CHECKOUT_BODY` are the operator's own files: the fixture's timing
and a real person's checkout details, read fresh on every attempt and never
copied into anything this system keeps.

`certify` must be run from an interactive session. It opens `/dev/tty`, and a
process with no controlling terminal cannot - which is the attendance check.
