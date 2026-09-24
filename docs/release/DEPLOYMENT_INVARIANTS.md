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

The workflow publishes `MAINTENANCE_REQUIRED` and requires the exact current tip
of `main` (`CANDIDATE_MUST_BE_MAIN_HEAD`): forward admission deploys nothing
else, so an ancestor would be a candidate nothing may deploy.

Publication is not a lease on `main`. `forward-deploy` refreshes `origin/main`
after taking its release lock and re-derives the candidate from that exact
commit before it may mutate anything. A session whose mutation is already
durable recovers its recorded target instead; a new `main` must never retarget
recovery.

## The launch machinery is retired

The launch crossed a lineage boundary exactly once: the pre-launch database was
archived, the launch baseline installed in its place, and the release certified.
Session `e4cb1a91` verified complete on 2026-09-24 at `3ad07cf`. What existed
only to make that crossing has been deleted, as this document said it would be:

- the commands `prepare-bootstrap` and `rollback-prepared`, and the
  cross-lineage branch of `rollback`;
- the predecessor topology reader, prepared-cutover envelopes and their
  adoption, the bootstrap archive and restore protocol with its receipts, the
  runtime quiescer, and launch-baseline admission;
- the `LAUNCH_BASELINE` release class as something that can be published or
  deployed;
- the runner settings that served them (`FLEXPERIMENT_RELEASE_REPLACEMENT_ROOT`,
  `_STATE_DIR`, `_ARCHIVE_DIR`, `_ENVELOPE_DIR` and the three
  `FLEXPERIMENT_PREDECESSOR_*`). The host may still export them; nothing reads
  them.

What remains is history, readable and never actionable:

| Left behind | Now |
|---|---|
| `LAUNCH_BASELINE` candidate files | not a `ReleaseClass` any more; readable only through `readHistorical`. `get`, `publish-candidate` and `deploy` refuse with `LAUNCH_BASELINE_RETIRED` |
| the launch session's `adopted_cutover_id` and bootstrap columns | frozen in the `0001` baseline and never written again. A session exposes them only as `launch: true`; `rollback` refuses it with `LAUNCH_SESSION_NOT_ROLLBACKABLE` before touching its lease |
| a pre-launch (`LEGACY`) database | refused by `db.ts`, by readiness, and by `observe` (`READ_ONLY_SCHEMA_LINEAGE_UNOBSERVABLE`) |
| envelopes, archives, `aborted-*` directories and receipts on the VPS | forensic evidence; untouched |

The removed code, its tests and the sections of this document that described it
are in git history at `3ad07cf`.

## Every state the runner produces has exactly one recovery owner

```text
session exists, nothing armed   rollback <session>
external effects armed          forward-deploy <session> <candidate>
```

`rollback` is usually run by a different process from the deploy that failed:
that deploy stood down and exited. So `rollback`, like `certify`, claims a lease
its holder has let go of and refuses one somebody still holds
(`DEPLOY_SESSION_HELD_BY_ANOTHER_RUNNER`). Before the launch was retired this
takeover lived only in the bootstrap rollback, so an ordinary maintenance
deploy that failed could not be rolled back from a new process at all.

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
rollback = restore the exact application source SHA, then prove production
           topology and readiness
```

So recoverability is proved against the predecessor **commit** — that it is
still resolvable and deployable — rather than against an image inventory. One
mechanism serves every application:

```text
sales already closed (maintenance) or never closed (rolling)
→ production-deploy CAS back to the predecessor
→ Coolify deploys the predecessor
→ topology and readiness prove the predecessor, exactly the recorded vector
→ settle the session and, for a maintenance release, open sales
```

No database is involved: an ordinary release is migrated forward and never
replaced. Only the launch restored a database, and that path was retired with
it (see "The launch machinery is retired").

Two rules keep this usable on the day it is needed:

- **An unobservable target does not stop a rollback.** A release that did not
  come up is the usual reason to roll back, so a topology that cannot be read
  beforehand is not recorded, and ownership is proved through the lease alone.
  Authority (`OLD_LINEAGE_ALLOWED`) and the frozen snapshot still gate it.
- **The restored predecessor is waited for, boundedly,** exactly as a deploy's
  target is (see `convergence.ts`). The pointer has moved by then, so anything
  short of the exact recorded vector is `RECOVERY_REQUIRED` with sales closed -
  never an exception that would read as exit `20`, "refused before mutation".

- **No write after a long wait uses a lease granted before it.** Three
  sequential Coolify redeploys and the convergence wait can each outlast the
  five-minute lease, so the lease is re-held after the restore, before every
  poll and before every settling write - as the target wait already does. A
  restore that took six minutes still settles as `ROLLED_BACK`, and one that
  then failed is still `RECOVERY_REQUIRED` rather than a bare lease error.

These were missing until the launch retired: until then, only the launch's
own restore path had the first two.

## An exit code describes what happened, not what was attempted

`20` means "refused before mutation". Once a session exists that is no longer
true: the pointer may have moved and the applications may be deployed, and an
operator reading `20` would believe production untouched.

```text
before a session exists            an exception may legitimately be 20
once the session exists            any unexpected exception is RECOVERY_REQUIRED (12)
```

The same reasoning applies to `resume`: a runtime that cannot be observed is
frequently the reason a session needs resuming, so requiring a successful
observation to produce a recovery plan is circular. An unobservable topology is
reported as `RECOVERY_REQUIRED` with `TOPOLOGY_UNOBSERVABLE`, never as a safe
abort — absence of observation is not evidence of anything.

A session records its candidate when it is acquired, and nothing restates it
afterwards. An adopted session that omitted it still satisfied the schema —
either a candidate or an adopted cutover is enough — but certification resolves
its driver from `session.candidateId`, so the omission surfaced only at
`issueCapability`, after readiness had already admitted the release, and sent a
finished cutover into recovery instead of to the operator.

Attendance belongs **after** `AWAITING_OPERATOR`, not before it. Issuing a
capability is not an attended operation and creates no external effect, so the
deploy that issues one needs no controlling terminal and reaches exit 13
unattended. The terminal is opened in `preflight` — before anything can be
armed — and the channel opened there is the one `certify` then speaks on, which
is why the driver is memoized per session: proving a terminal exists and then
opening a different one later would prove nothing about the operator who is
actually present.

Each runner command is a separate SSH invocation with its own
`hostname:pid` owner, and nothing carries an owner between them. So **a command
that hands a session to a person stands down from its lease, and the command
that picks it up claims it.** `deploy` stands down when it returns
`AWAITING_OPERATOR`; `certify` claims the session before it arms anything. A
lease its holder has not stood down from and which has not lapsed is refused,
never taken - standing down is the holder's to do, which is what stops this
from becoming a way to take a session out from under a running deploy.

Reusing an owner token across processes would be the wrong fix: two different
processes would be indistinguishable to the lease authority, which is the
impersonation this removed.

A command that hands a session back as `RECOVERY_REQUIRED` also **stands down
from its lease**. It
knows it is exiting, and holding the lease until it lapses would make the next
command wait out the full term before it could act, with production fenced the
whole time. Standing down is not the same as being evicted: only the holder may
do it, a live holder is never displaced, and a crash still falls back to
ordinary expiry. It applies wherever that decision is made — a convergence or
readiness failure arrives through a different path than an unexpected one, and
both hand back — and to `resume`, which takes a lease to read the state and
then tells the operator to roll back.

Certification legitimately outlasts a lease term. A real payment, an email and
a refund have timeouts of thirty, fifteen and thirty minutes, with a
synchronous terminal read in the middle; the session lease is five. Nothing can
renew it while that is happening — the terminal read blocks the event loop, so
a timer is not an option — and the writes that close the release would then be
refused for a lease that lapsed while the operator was doing exactly what they
were asked to, on a release whose money has already moved.

So the attended command **reclaims its own lease** at each seam around the long
wait: before arming, and again before the final observation or the recovery
that records a failure. Reclaiming one's own lapsed lease is safe here and
nowhere else, because the process still holds the exclusive runner lock for the
life of the command, so no other runner could legitimately have taken the
session. If the process actually died the lock died with it and ordinary
cross-process takeover applies unchanged. A session whose owner has changed is
refused outright.

Arming is inside the same failure contract as everything else once a session exists. A
session, a deployed successor, a capability and a closed gate already exist by
then, so a refusal there is `RECOVERY_REQUIRED`, never a pre-mutation `20`.

`rollback <session>` may take over a **lapsed** lease itself, as `certify` does.
Requiring an operator to re-supply the dead or departed process's owner id made
an ordinary recovery depend on reading it out of the database by hand. A lease
that has not lapsed still belongs to whoever holds it.

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

## "Finished" is Coolify's answer, not the application's

When Coolify reports a deployment `finished`, its own operation is over: the
build ran and the containers were started. The application-level evidence the
release consumes comes afterwards, asynchronously. The proxy switches to the
new container, the worker writes its runtime row, and the worker's first sweep
completes later still (it is launched with `void runSweep()`). The fourth
launch attempt (2026-09-23) read topology once, 41 ms after commerce
`finished`. The worker container had been up for 1.7 s and had not recorded a
heartbeat, so the cutover went to recovery with nothing wrong. Its rollback
then lost the same race twice, on the frontend descriptor and on commerce.

So every seam that consumes that evidence polls it, boundedly
(`convergence.ts`; production: 120 s at a 5 s cadence):

- **Forward topology.** After the deployment driver returns, `observe()` is
  repeated until all four surfaces are the target. Only rollout-shaped reads
  are waited on: `TOPOLOGY_UNIT_NOT_RUNNING`, `TOPOLOGY_SURFACE_UNREACHABLE`,
  `TOPOLOGY_UNIT_DISAGREES`, or a valid observation that is simply not the
  target yet. A malformed descriptor, an invalid commit or an unreadable or
  invalid deploy pointer is refused on the first look. At the deadline the
  last real reason becomes an ordinary `RECOVERY_REQUIRED`.
- **Forward readiness.** Once topology is the target, readiness is
  re-evaluated while it is `PENDING`. `ADMITTED` proceeds and `REJECTED` stops
  at once (see below).
- **Rollback, per application.** After `restoreApplication` returns,
  `applicationIsAt` is polled. The receipt state machine is unchanged: the
  redeploy is not repeated by the waiter, and an application that never shows
  up leaves the receipt at the stage before it, which the next invocation
  resumes.

The waiter only reads. Each poll is a fresh observation, and nothing is
redeployed, restarted or reopened from inside a wait. The one write it makes is
bookkeeping: the forward wait holds the session lease on every poll
(`holdLease`), because a long Coolify build followed by two full waits can
outlast the five-minute lease. Reclaiming its own lapsed lease is safe for the
same reason as during certification: the runner lock is held throughout.

The polling does not belong in the Coolify client. Coolify already answered
the question it owns, and "can the release see it yet" is the release's
question.

## Readiness separates "not yet" from "converged and inadmissible"

A convergence loop is read-only, and the two failure classes it meets are not
the same:

- **Observable rollout surfaces** - health, readiness, the surfaces' own
  descriptors - may legitimately be absent or unreachable while a deploy is in
  flight: a proxy answering 502, a refused connection, a unit with no
  heartbeat yet. Those are waited on. A descriptor that answers with a body
  that does not parse, or with something that is not a commit, is refused at
  once. A restart shows up as a failed request, not as a well-formed response
  carrying a malformed payload.
- **Semantic and authority evidence** - the source commit, the schema
  inventory, the legal version and manifest digest - does not become correct by
  waiting. A mismatch or an unparseable value there is terminal.

`evaluateReadiness` encodes this: malformed evidence is `REJECTED`, while a
commit that has not converged, a stale heartbeat or a sweep that has not
happened are `PENDING`. Collapsing the first into the second makes a loop wait
forever on something no amount of waiting can fix.

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
component is missing - the lock, the database, the deploy-ref credential, the Coolify token, the three
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

## A certification that did nothing may be retried once, and only after its capability expires

One certification run per deploy session is the rule (`certification-<session>`),
because a restart after a payment must continue that payment, never begin
another. A failed run is reconciled, not replaced, and its failure is immutable.

Attempt 5 (2026-09-23) hit the case the rule did not anticipate. `certify`
armed the release and its first command, `CREATE_OCCURRENCE`, was refused by
the runtime as `CERTIFICATION_COMMAND_NOT_ARMED`. The runtime admits a command
only if it equals the armed one compared as JSON, and the runner had armed the
draft with `cityId` last while the endpoint rebuilds it with `cityId` first.
The run recorded `INCOMPLETE` and shut a catalogue it never opened. Armed means
no rollback, and a failed run can never pass, so a release whose certification
had touched nothing had no way to finish. The runner now spells the draft out
in the endpoint's order. The real-router E2E below is what proves it.

The way out is exactly one retry, `certification-<session>-a2`, and only when
the first run provably did nothing (`no-effect-retry.ts`):

- The session is `RECOVERY_REQUIRED`, `NEW_LINEAGE_ONLY`, fenced, with no
  rollback reserved, for the same candidate.
- The run failed at `NEW`, is `CATALOGUE_CLEAN`, has nothing pending, and has
  no evidence identifiers. A superseded `CREATE_OCCURRENCE` is expected:
  cleanup keeps it as the forensic record of what it retired.
- The run has no catalogue-ledger row. The mutation and its ledger row commit
  in one transaction, so no row means no occurrence.
- The run has no order and no checkout. A certification order cannot exist
  without its run's ledger row.
- There is exactly one capability for the session, bound to that run, never
  spent and never replaced.

The proof, the new run and its capability are one IMMEDIATE transaction. The
first capability's retirement is the capability store's own step during
issuance, and the schema permits it only after `expires_at` by the database
clock. That is kept, not bypassed: until then `certify` refuses with
`CERTIFICATION_RETRY_CAPABILITY_STILL_LIVE`, and the transaction rolls back
with every durable row unchanged. Once `-a2` exists a later `certify` continues
it, and there is no `-a3`. What `-a2` may still need is a capability. A runner
that died after creating it and came back more than a TTL later would otherwise
recover an expired one, be refused by the runtime, and be stuck again. So an
unspent, expired `-a2` capability is replaced on the same run, through the same
store issuance and database-clock guard. A spent one is never replaced: the
checkout happened under it, and the refund and cleanup continue with it. Any
other capability shape fails closed. A first run that
did something is not eligible and goes down the ordinary path, which
reconciles it. `verify` judges the run that certified, and re-proves from the
first run's leftovers that it did nothing.

This is runner-only. The deployed runtime already binds each command to the
capability's run, not to a session-derived id, so recovering this way needs
no new candidate and no deploy, and the certified target stays the one the
session names.

## An armed session goes forward by revision, never by rewriting its target

A cutover session's `target_sha` and `candidate_id` are what it first set out
to deploy, and they never change. When that target cannot be certified after
arming (rollback forbidden, sales fenced), `forward-deploy <session>
<candidate>` carries the session to a newer release by appending a revision to
`deploy_session_forward_targets`. The design is in `FORWARD_SUPERSESSION.md`.

- **Every target decision reads the current release binding**, revision, SHA
  and candidate together, never `session.targetSha`: topology, readiness,
  arming, settling, `certify`, `verify`, and the runtime's certification
  admission.
- **A new revision is admitted in full**: a `MAINTENANCE_REQUIRED` candidate
  that is main's tip, re-derived byte for byte, descended from the current
  target, the installed runner's own tree, and green in CI for its exact SHA,
  read from GitHub at admission and stored with the revision. The prior target
  must be safe to leave: its certification started (at least one run), every
  run terminal, no money in motion,
  every fixture shut. A live capability of the target being left is revoked as
  `FORWARD_SUPERSESSION` in the same transaction as the revision, rather than
  waited out. Only that reason may retire a capability before its expiry. A
  refusal stands the lease down, so the next command need not wait it out.
- **Appending is a release-authority write**: owner and live lease are proved
  in the same IMMEDIATE transaction as the insert. The table's triggers repeat
  the state and chain rules for any other writer.
- **Resuming never re-admits.** The recorded binding is the authority, main
  may have moved on, and the pointer moves only from the revision's own
  `from_sha`; anywhere else is `FORWARD_DEPLOY_REF_DIVERGED`. Migrations run
  before the revision, so a crash between them leaves no target committed, and
  the next run admits from scratch.
- **Nothing certified for one revision counts for another.** Revision N gets
  run `certification-<session>-r<N>` and its own capability. The earlier runs
  stay as history, and `verify` re-proves that each target left behind is
  safe.

## Certification is proved against the real runtime, end to end

`commerce/test/certification/real-router-e2e.test.ts` runs a complete
production certification, from `CREATE_OCCURRENCE` to `COMPLETE`. The real
certification driver and machine talk over their real HTTP ports to
`createApp`, which means the real certification router, the real public quote
and checkout routes, the real domain and the real worker cycle, with real
request and response serialization at every boundary. Only the two systems
outside production are substituted:

- the payment provider, as `TochkaProvider` minus its network;
- the email provider, as `UnisenderGoProvider` minus its network.

The runtime mounts its webhook routes only for those classes, and certification
demands the evidence the webhooks write. The webhooks are signed the way the
providers sign them (an RS256 JWT, and an MD5 over the key) and verified by the
runtime's own verifiers.

It exists because the attended certification had never run against a runtime.
Every test on either side described the other side by hand, including one
written to fix the first production failure, which invented the field whose
absence caused the second. Built on 2026-09-24, it found eight
runner/runtime contract defects between arming and the final close. Each would
have failed a production certification, several of them after the ₽1 had moved:

| # | Step | Defect |
|---|---|---|
| 1 | create | the armed command's JSON key order differed from the endpoint's rebuild |
| 2 | create | identity was judged on the create response, which has no `city_slug` |
| 3 | quote | `checkoutContext` answered the sales gate with no certification path, so a fenced release could never quote |
| 4 | quote, checkout | the claim header was split on `.`, and the versioned nonce contains one |
| 5 | checkout | `withImmediateTransaction` could not nest inside the admission's transaction |
| 6 | checkout | the capability was spent before `checkout` re-proved it, so it was refused as spent |
| 7 | payment, cancellation | the certification occurrence read carried no `availability` |
| 8 | cancellation | the router sent a fixed sentence where the domain requires `CANCEL <bookingId>` |

Reverting any one fix makes the test fail at the step where production would
have. A certification-shaped change is not done until this test reaches
`COMPLETE`, and no runtime stub stands in for it.

## An email the customer did not get in time fails certification, and says why

Certification waits 15 minutes for each email's delivery. That wait is a
customer-experience limit, not a network timeout, and it stays strict. On
2026-09-24, `-r1`'s ticket stayed at `sent` for the whole wait because the
recipient's mailbox was full. It was delivered three minutes after the limit,
which is still a bad experience for a real customer, so failing was right. A
timeout never resends the email.

What a timeout now records, in the run's failure code and the CLI output, is
what the wait saw:

```
CERTIFICATION_EMAIL_TIMEOUT:TICKET last_status=SENT last_provider=sent@2026-09-24T06:23:25Z
  provider_events=4 queued_at=2026-09-24T06:17:43Z first_sent_at=2026-09-24T06:17:58Z
  waited=14m51s observed_at=2026-09-24T06:32:49.000Z
  delivery_status=err_mailbox_full evidence_source=WEBHOOK
  destination_response="452 4.2.2 <address>: Mailbox full"
```

The last three fields come from the most recent provider event that said
anything about delivery. When no event did, they read `delivery_status=UNKNOWN`
and `destination_response=UNAVAILABLE`, which is itself a finding: we don't
know, rather than a guess that the receiver deferred the message. The same day's
cancellation and refund emails stayed `sent` for hours, and without these fields
nothing could tell a receiver deferring them from a provider that never tried
again.

The line carries states, provider status words, times, and the receiving
server's answer after sanitizing: addresses, URLs and long opaque tokens are
removed, and the answer is at most 300 characters. It never carries an address,
a subject or a URL. The database refuses a stored answer containing `@`, whoever
writes it.

### The certification mailbox must be reachable from UniSender quickly

The certification's customer email is `customer_email` in the operator checkout
body (`CERTIFICATION_CHECKOUT_BODY` in `release-runner.env`). It must be a
mailbox that accepts UniSender's mail within minutes, because every one of the
three emails has 15 minutes.

On 2026-09-24 the certification address was a ProtonMail mailbox, and
UniSender's mail to it was accepted slowly or not within the wait each time:

| Email | Sent (UniSender `sent`) | Delivered |
|---|---|---|
| `-r1` ticket | 06:17:58Z | 06:36:04Z, 18 min (the mailbox was also full) |
| `-r1` cancellation and refund | 06:51:59Z | 09:34:44Z, 2 h 43 min |
| `-r2` ticket | 09:44:18Z | not within the 15-minute wait |

There were no bounces and no suppression, and nothing was resent: one send
attempt each, with UniSender's first SMTP attempt on time. Both `-r1` and
`-r2` failed on `EMAIL_TIMEOUT` and were refunded.

`-r3` changed only the receiving mailbox, to Gmail - same runtime, same
UniSender account, sender and templates - and all three emails were delivered
in 11-24 seconds. That isolates the delay to the UniSender-to-ProtonMail path.
Why that path is slow is not established; it is not a claim about either
provider's infrastructure until UniSender says so.

Certify against a mailbox whose provider has been shown to accept UniSender's
mail promptly (Gmail has), and keep its inbox with space free. Changing the recipient needs no code
change, but a run's checkout request is bound to the body it was created
with, so the change only applies from the next revision's run.

### Where the delivery fields come from

Both provider paths store the same sanitized fields on `email_provider_events`
(migration 0006): `evidence_source`, `delivery_status`, `destination_response`,
`sender_ip` and `provider_event_time`.

- **Webhook**: only when the Unisender webhook has `delivery_info = 1`. Only
  `delivery_status`, `destination_response` and `sender_ip` are read from it.
  The recipient's IP, user agent, device and location in the same object are
  never read.
- **Event dump**: the export requests `destination_response` alongside
  `delivery_status`. It has no `sender_ip`. When an event carries an answer,
  the sanitized answer is part of its deduplication key
  (`unisender:event-dump:v2:`). An export that finally carries the answer
  therefore adds a row next to the same event recorded without it, which covers
  every row reconciled before this change, including 2026-09-24's two stuck
  jobs. It isn't discarded as a duplicate. Without an answer the key is
  unchanged, so older rows still deduplicate exactly as before.

### An unresolved email does not use up the event-dump allowance

Unisender stores at most ten exports, each for eight hours. The runtime creates
at most nine in any eight hours. Before this change, an email that stayed `sent`
was exported again five minutes after every export that still showed it
unresolved. On 2026-09-24 two such emails used the whole allowance in an hour,
and nothing could be reconciled for the next seven.

Now each export that has been read and still leaves an email unresolved doubles
that email's wait before the next one: 5, 10, 20, 40 minutes, and so on, up to
4 hours. A saturated or unread export keeps the 5-minute retry, because it never
showed the email. The wait comes from how many exports that email already has
in the database, so a worker restart doesn't reset it.

An export that has been read is deleted at Unisender, which frees its slot
instead of holding it for eight hours. The dump to delete is recorded in the
same write that finishes its run (migration 0007, `release_dump_id`). Every
reconcile pass retries it, up to five attempts, so a failed or ambiguous delete,
or a process that dies first, is retried instead of forgotten. After eight
hours Unisender has removed the dump itself, and the record is cleared. A delete
that keeps failing never causes an export to be created: capacity is still
whatever `event-dump/list` reports, and the create path refuses while nine
exist. Evidence ingested before a failed delete is kept.

The regression tests replay the production shape. One email stuck at `sent` is
reconciled every minute for eight hours, with the worker restarted every hour
and every export's first delete failing. A second test covers a delete that
never succeeds. Removing either the backoff or the retry sweep fails both tests.

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

The lock and the journal live on the host, outside the containers. The git worktree
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
