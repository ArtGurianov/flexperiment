# Release subsystem audit (post-launch)

Audit only: nothing here changes behaviour. The baseline is `main` at `77dbc9d`
(#158–#162 merged). Production runs `3ad07cf`, and so does the runner staged
on the VPS. Each surviving component is asked four questions:

1. What real production scenario needs it?
2. What is its authority, the source of truth?
3. What failure does it make safer?
4. Does another component already do the same job?

Verdicts: **KEEP** (the ordinary release flow needs it), **SIMPLIFY** (needed,
but wider or looser than necessary), **DELETE** (no reachable production
scenario), **DEFER** (a cleanup that needs a migration or a change to the
safety model).

## Summary

| Component | Verdict | One line |
|---|---|---|
| Candidate publication | **SIMPLIFY** | The runner CLI accepts `ROLLING_COMPATIBLE` from the operator. The mode is supposed to be derived, never chosen |
| Candidate admission (exact SHA, CI, installed runner) | **SIMPLIFY** | Enforced for `forward-deploy` only. Ordinary `deploy` has none |
| `production-deploy` CAS | KEEP | The only pointer Coolify follows, moved by lease-guarded compare-and-set |
| Rolling deploy | **DEFER** | Correct code, but nothing can prove a candidate compatible; reachable only through the loophole above |
| Maintenance deploy | KEEP | The only real release path |
| Coolify adapter | KEEP | Down to four calls since #158 |
| Convergence and readiness | KEEP | Bounded waits (#150, #159), distinguishing "not yet" from "wrong" |
| Sales gate | KEEP | Two levels, the emergency gate and the deployment fence |
| Sessions, leases, runner lock | KEEP | Each protects its own seam |
| Certification | KEEP | The attended proof that a release sells |
| Rollback | KEEP | Hardened in #159 |
| Resume | **SIMPLIFY** | Two of its plans (`RETRY_DEPLOY`, `PROVE_READINESS`) have an executor, `continueSession`, that no command calls |
| Forward supersession | KEEP | A general recovery path now, not launch machinery |
| No-effect retry (`-a2`) | KEEP / **DEFER** | Still needed. Removing its wait for expiry needs a migration |
| Verify | KEEP | Independent of what the deploy believed |

## Components

### Candidate publication

1. **Scenario:** every release starts as a published candidate, meaning the
   commit, its class and its readiness expectation, derived from the commit's
   own tree.
2. **Authority:** the write-once candidate directory on the VPS. The
   `release-candidate.yml` workflow is one publisher, and
   `flexperiment-release publish-candidate` run by hand is another (both
   `-r2` and `-r3` were published that way).
3. **Failure made safer:** a deploy can't be handed an expectation that
   disagrees with the tree it deploys.
4. **Overlap:** the workflow checks exact-SHA CI; the CLI does not.

**Finding: SIMPLIFY.** The CLI takes the release class as an argument and
accepts `ROLLING_COMPATIBLE`. "The deploy mode is derived, never chosen" holds
for the workflow, which always publishes `MAINTENANCE_REQUIRED`, but not for
the CLI. An operator can publish a schema-incompatible commit as rolling, and
`deploy` will then skip the fence and the certification. No compatibility
proof exists anywhere in the codebase. **Fix:** until one exists,
`publish-candidate` should accept only `MAINTENANCE_REQUIRED`, and
`ROLLING_COMPATIBLE` should become derivable only from that proof.

### Candidate admission

1. **Scenario:** before anything moves, prove the candidate is main's exact
   tip, that its exact commit passed CI (`test` and `docker-build`), and that
   the runner doing the deploy *is* that commit (clean checkout, same tree).
2. **Authority:** `ForwardSupersessionAdmissionGuard`: a fresh `origin/main`,
   GitHub check runs, and the runner's own git checkout.
3. **Failure made safer:** deploying something CI never passed, something main
   has already moved past, or code the runner itself doesn't carry (whose
   migrations it would then not know).
4. **Overlap:** partly the workflow's CI check at publication. That check
   doesn't cover CLI publication, and it runs at publication, not at
   consumption.

**Finding: SIMPLIFY (the important one).** Only `forward-deploy` has
admission. Ordinary `deploy` checks nothing beyond the candidate existing,
because the launch's admission guard went with the launch in #158 and the
forward guard was never reused. So the next ordinary release can deploy an
unreviewed, CI-red or stale commit if it was published through the CLI, which
is how this project actually publishes. **Fix:** one admission guard
(main-tip + exact-SHA CI + installed runner) used by `deploy` and
`forward-deploy`, with `CI_ATTESTATION_INCOMPLETE` and the other refusals
unchanged. This is the one change worth making **before the next production
release**.

### `production-deploy` CAS

1. **Scenario:** Coolify's three applications track the `production-deploy`
   branch, so moving production means moving that ref.
2. **Authority:** the remote ref itself, read fresh.
3. **Failure made safer:** two controllers each believing they moved it;
   rollback moves it back first, so the next ordinary deploy can't silently
   undo a rollback.
4. **Overlap:** none.

**KEEP.**

### Rolling deploy (`ROLLING_COMPATIBLE` → `ROLLING_SAFE`)

1. **Scenario:** a release proved readable by the running revision, so sales
   need not close.
2. **Authority:** the candidate's class.
3. **Failure made safer:** unnecessary maintenance windows.
4. **Overlap:** none.

**DEFER.** The path is correct and tested, but no production scenario can
produce its input legitimately: there is no compatibility proof. Either keep
it and close the CLI loophole (above), or delete `runRolling` until a proof
exists. Deleting it is a behaviour change; closing the loophole is enough to
make it harmless.

### Maintenance deploy

1. **Scenario:** every release today. Fence, deploy, converge, prove
   readiness, issue a capability, then hand over (exit 13).
2. **Authority:** the deploy session (state, lease, fence) and the frozen
   pre-deploy snapshot.
3. **Failure made safer:** selling on a release nobody certified; a failure
   with no way back.
4. **Overlap:** none. Migrations are applied by the commerce server on boot
   (`server.ts`); `forward-deploy` also applies them itself first, so a
   revision is atomic with respect to its schema. Both are idempotent, so this
   is not a duplication worth removing.

**KEEP** (plus admission, above).

### Coolify adapter

Down to four calls since #158: read an application (build pack), read its
deployment queue, start a deployment, and follow it to a terminal state.
Recovery moves the ref back and redeploys. **KEEP.**

### Convergence and readiness

Bounded waits after every deploy and every restore (#150, #159); readiness
separates "not yet" from "converged and inadmissible". A deploy that raced
its own runtime is exactly what failed attempt 4. **KEEP.**

### Sales gate

Two levels: the emergency gate, an operator's own switch answered first, and
the deployment fence, which the release closes and only its certification
capability may pass. They are different authorities, so there's no overlap.
**KEEP.**

### Sessions, leases, runner lock

- **The runner lock** (filesystem, per host) guards *concurrency*: two runner
  processes at once. It dies with its process.
- **The session lease** (in the database, per session) guards *ownership
  across processes*: `deploy` and the attended `certify` are different
  processes, and a dead runner's lease lapses so another can take over.

They protect different seams, and `holdLease` relies on both: reclaiming your
own lapsed lease is safe only because you still hold the lock. **KEEP both.**

### Certification

The attended ₽1 proof, run against the real runtime. After #160–#162 the
model is: run identity stays distinct (base run, `-a2`, `-rN`), and the
capability lifecycle is one rule (issue, then either spent or expired and
reissued on the same run); capabilities live one hour; preflight refuses an
expired one before arming. **KEEP.** No further unification is planned.

### Rollback

Same-lineage only: the ref moves back, Coolify redeploys, the exact recorded
vector is awaited, then the session settles and sales reopen. It runs from a
new process, rolls back a target that never came up, and holds its lease
through long restores (#158, #159). **KEEP.**

### Resume

1. **Scenario:** a runner died mid-deploy. Take over the lapsed lease, observe
   production, and report a plan: `RETRY_DEPLOY`, `PROVE_READINESS`,
   `FIX_FORWARD_OR_ROLLBACK` or `FIX_FORWARD_ONLY`.
2. **Authority:** the session plus a fresh observation.
3. **Failure made safer:** re-firing a deploy over a partially moved
   production.
4. **Overlap:** `rollback` executes `FIX_FORWARD_OR_ROLLBACK`, and
   `forward-deploy` executes `FIX_FORWARD_ONLY`.

**Finding: SIMPLIFY.** `RETRY_DEPLOY` and `PROVE_READINESS` have an executor,
`ReleaseOrchestrator.continueSession`, that no command calls (only
`resume.test.ts` does). So `resume` can report those plans, exit 0 and leave
the fence closed, and the only way on is `rollback`. Either wire it in as
`resume --continue <plan>` (it already refuses a stale plan), or delete
`continueSession` and make `resume` say "roll back" for those states. Deleting
it is simpler, and rollback covers both states.

It also leaves the lease behind. For `RETRY_DEPLOY` and `PROVE_READINESS`,
plain `resume` takes the lease and exits 0 **without yielding it**, so a
separate follow-up invocation would wait out the lease. If continuation stays
a separate invocation, the diagnostic `resume` must yield. Better: continue in
the same invocation (`resume --continue`), which is what #164/#165 do.

### Forward supersession

1. **Scenario:** a maintenance release crossed the external-effects boundary
   (armed), then turned out uncertifiable. Rollback is forbidden, so the
   session is carried to a fixed descendant commit. This can happen again
   without any bootstrap.
2. **Authority:** the append-only `deploy_session_forward_targets` table (the
   binding) and the admission guard.
3. **Failure made safer:** a release stuck forever with sales shut.
4. **Overlap:** none.

What remains is general: admission, supersession safety, a lease-guarded
append, CAS from the revision's own `from_sha`, early revocation atomically
with the append, and a per-revision run. The only launch-era traces are words
in tests ("attempt 5"). **KEEP.**

### No-effect retry (`-a2`)

A same-SHA second attempt, only when the first provably did nothing; forward
supersession can't do this, because it needs a new SHA. **KEEP.** **DEFER:**
`-a2` still waits for the first capability to expire (at most an hour now),
because the schema allows only `FORWARD_SUPERSESSION` to retire a capability
early. A `NO_EFFECT_RETRY` retirement reason, written atomically with `-a2`'s
creation, would remove the wait, but needs a migration and its own safety
proof.

### Verify

Read-only, and independent of what the deploy believed. It re-observes the
topology (catching drift after settling), re-proves every superseded target
safe, checks the run's final state and the fixture in the catalogue itself,
and that no capability is live. Nothing in it repeats a check whose answer
can't have changed since. **KEEP.**

### Dead code

Apart from `continueSession` (see Resume), nothing is unreachable. The other
exports not used outside their own file are types and error classes, which
are fine as they are.

## Environment

What the runner at `main` (`77dbc9d`) reads, compared with the names present
in `/etc/flexperiment/release-runner.env` on the VPS (names only):

| Class | Variables |
|---|---|
| **REQUIRED** (every mutating command) | `FLEXPERIMENT_RELEASE_DATABASE`, `FLEXPERIMENT_RELEASE_LOCK`, `FLEXPERIMENT_RELEASE_JOURNAL`, `FLEXPERIMENT_RELEASE_CANDIDATE_DIR`, `CERTIFICATION_ADMIN_BASE_URL`, `CERTIFICATION_PUBLIC_BASE_URL`, `CERTIFICATION_ADMIN_TOKEN`, `CERTIFICATION_CAPABILITY_KEY`, `CERTIFICATION_CITY_SLUG`, `CERTIFICATION_OCCURRENCE_SCOPE`, `CERTIFICATION_CHECKOUT_BODY`, `COOLIFY_API_URL`, `COOLIFY_TOKEN`, `COOLIFY_APPLICATION_FRONTEND`, `COOLIFY_APPLICATION_ADMIN`, `COOLIFY_APPLICATION_COMMERCE`, `FLEXPERIMENT_FRONTEND_RELEASE_URL`, `FLEXPERIMENT_ADMIN_RELEASE_URL`, `FLEXPERIMENT_DEPLOY_REF_REMOTE`, `FLEXPERIMENT_DEPLOY_REF_WORKTREE`, all present |
| **REQUIRED by one command** | `FLEXPERIMENT_CI_REPOSITORY` (`forward-deploy`, and `deploy` too once admission is shared), present |
| **OPTIONAL** | `FLEXPERIMENT_DEPLOY_REF_NAME` (default `refs/heads/production-deploy`), `FLEXPERIMENT_CI_TOKEN_FILE` (public repository), `FLEXPERIMENT_RELEASE_OWNER` (tests only; not an operational workaround), all absent |
| **Host plumbing, not read by code** | `GIT_ASKPASS` (git credential helper), present; `GIT_TERMINAL_PROMPT` is set by the wrapper |
| **RETIRED** (read by nothing at `main`) | `FLEXPERIMENT_RELEASE_REPLACEMENT_ROOT`, `FLEXPERIMENT_RELEASE_STATE_DIR`, `FLEXPERIMENT_RELEASE_ARCHIVE_DIR`, `FLEXPERIMENT_RELEASE_ENVELOPE_DIR`, `FLEXPERIMENT_COMMERCE_IMAGE_REPOSITORY`, `FLEXPERIMENT_COMMERCE_WORKER_IMAGE_REPOSITORY`, `FLEXPERIMENT_PREDECESSOR_SHA`, `FLEXPERIMENT_PREDECESSOR_LEDGER`, `FLEXPERIMENT_PREDECESSOR_READY_URL`, all present |

The subset of the read-only commands (`observe`) and of `publish-candidate` is
`READ_ONLY_RELEASE_ENVIRONMENT_VARIABLES` and
`loadCandidatePublicationConfig`'s list in `production-config.ts`.

**Ordering constraint for the VPS cleanup.** The runner staged on the VPS is
`3ad07cf`, which still **requires** six of the retired names (the four
directories and the two image repositories) and validates the three
`PREDECESSOR_*` if present. Removing them before a runner from `main` is
staged would make every runner command refuse to start, including `observe`.
So the order is:

1. stage a runner from `main` (a runner install, not a deploy);
2. `observe` with it, read-only;
3. then remove the nine retired names.

The commerce containers read their own variables (`SOURCE_COMMIT`,
`COMMERCE_CERTIFICATION_TOKEN_SHA256`, `COMMERCE_INSTANCE_ID`), set in
Coolify, not in this file. They are outside this audit.

## Addressed since

- #164: `deploy` and `forward-deploy` share `ReleaseAdmissionGuard`, and
  `publish-candidate` accepts only `MAINTENANCE_REQUIRED`.

## Recommended order

1. **PR: shared admission for `deploy`**, and `publish-candidate` accepting
   only `MAINTENANCE_REQUIRED`. Before the next production release.
2. **PR: `resume --continue`** runs `continueSession` in the same invocation.
   Plain `resume` yields its lease and exits 12 whenever action is still
   needed.
3. **VPS cleanup**, in the order above: stage a runner from `main`, observe,
   then remove the nine retired names. Keep the launch forensics. Disk is 59%
   used (31 GB free).
4. **DEFER:** a `NO_EFFECT_RETRY` early retirement (migration); deleting
   `runRolling` if no compatibility proof is planned; the legacy
   launch columns (kept, per the earlier decision).
