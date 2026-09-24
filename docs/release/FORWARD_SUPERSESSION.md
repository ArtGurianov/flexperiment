# Forward supersession of an armed cutover session

Status: implemented. `forward-deploy` is in `scripts/release/cutover-runner.ts`
(`commerce/src/release/forward-deploy.ts`). The migration is
`0004_deploy_session_forward_targets.sql`, admission is `forward-admission.ts`,
and the safety predicate is `supersession-safety.ts`. The runner needs
`FLEXPERIMENT_CI_REPOSITORY` (`owner/name`) for the CI attestation, and
optionally `FLEXPERIMENT_CI_TOKEN_FILE`; without the repository,
`forward-deploy` refuses and every other command runs as before.

## The situation this exists for

Attempt 5 (2026-09-23) left production in a state the release machinery cannot
leave:

- Session `e4cb1a91-5e8a-4e2b-8b40-9e8fbcadb557` is `RECOVERY_REQUIRED`, armed
  (`NEW_LINEAGE_ONLY`), and owns the closed deployment gate. Sales are shut.
- It targets `fed1638`, and `fed1638` **cannot be certified**. The real-router
  E2E (`commerce/test/certification/real-router-e2e.test.ts`) shows its runtime
  refuses every certification quote behind the fence (`checkoutContext` calls
  `assertNewOrdersOpen()` with no certification path). It also rejects every
  claim header, because the header is split on `.` and the versioned nonce
  `v1.<hex>` contains one.
- Being armed, it may not roll back.

So recovery is forward only, to a release that fixes the runtime. The
orchestrator has no way to do that today:

| Obstacle | Where |
|---|---|
| `target_sha` and `candidate_id` are frozen | `deploy_sessions_identity_immutable_guard`; absent from `DeploySessionPatch` |
| settling requires the runtime to be the session's original target | `DeploySessions.completeTarget()` |
| arming checks observed topology against the original target *before* noticing the session is already armed | `DeploySessions.armExternalEffects()` |
| only one non-terminal session may exist, and this one owns the gate | `deploy_sessions_single_non_terminal_idx` |
| `FIX_FORWARD_ONLY` is a plan kind with no executor | `planResume()` |
| the runtime judges certification against `deploy_sessions.target_sha` | `performCertificationCatalogueCommand()` |
| the consumption guard admits only `LAUNCH_BASELINE` | `LaunchBaselineAdmissionGuard.admit()` |
| nothing on the runner's publication path checks CI | `deriveCandidate()`, `FileReleaseCandidateStore.publish()`. The green-CI check lives only in `release-candidate.yml`, which this cutover's candidates never went through. |

## Principle

**The session's original target is a historical fact and stays one.** What
changes is a separate, monotonic record of the session's *current release
binding*. The session keeps its identity, its gate, its rollback authority and
its pre-deploy snapshot. It gains a history of which releases it has been
carried forward to.

Nothing certified for one target counts for another. `fed1638`'s certification
runs and capabilities stay as forensic history. Each forward target gets its
own run and capability, bound to the same session, its own release SHA and its
own forward revision.

## Model

A new table, shipped as a predeploy-compatible expand migration in the forward
release (see [Migrations](#migrations)):

```sql
CREATE TABLE deploy_session_forward_targets (
  session_id   TEXT NOT NULL REFERENCES deploy_sessions(id),
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  from_sha     TEXT NOT NULL,   -- the target this one supersedes
  target_sha   TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  ci_evidence  TEXT NOT NULL,   -- the exact-SHA CI attestation admission read
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (session_id, revision)
);
```

Triggers make it append-only and gap-free:

- `UPDATE` and `DELETE` abort (`FORWARD_TARGET_IMMUTABLE`).
- An insert must have `revision = max(revision) + 1` for the session (1 for
  the first), and `from_sha` must equal the previous row's `target_sha`, or
  `deploy_sessions.target_sha` for revision 1.
- An insert requires the session to be `RECOVERY_REQUIRED`, `NEW_LINEAGE_ONLY`,
  gate closed, with no `bootstrap_rollback_id`.

The triggers are the schema backstop, not the authority. **Appending is a
release-authority mutation and is guarded like every other one:**

```text
ReleaseAuthorityStore.appendForwardTarget(sessionId, ownerId, binding, ciEvidence, now)
  one BEGIN IMMEDIATE:
    owner_id == ownerId                                  else DEPLOY_SESSION_NOT_OWNER
    lease_expires_at > now                               else DEPLOY_SESSION_LEASE_EXPIRED
    RECOVERY_REQUIRED, NEW_LINEAGE_ONLY, gate closed by this session, no rollback reserved
    revision chain (next revision, from = current binding's target)
    INSERT
  COMMIT
```

A row in the right state is not authorisation. The writer must also hold the
session's lease.

### The current release binding

Every decision resolves one binding, never a bare SHA:

```ts
currentReleaseBinding(session): {
  revision: number;     // 0 = the session's original target
  targetSha: string;
  candidateId: string;
}
```

Revision 0 is `(0, session.targetSha, session.candidateId)`. Revision N is the
highest row. SHA and candidate always come from the same row, so no reader can
combine the newest SHA with the original candidate.

It replaces every target read that decides something:

| Reader | Today |
|---|---|
| `ReleaseOrchestrator.requireTargetTopology` | `request.candidate.sha` |
| `ReleaseOrchestrator.requireReadiness` | `request.candidate` expectation |
| `DeploySessions.armExternalEffects` | `session.targetSha`, checked before the already-armed early return |
| `DeploySessions.completeTarget` | `observed.targetSha` |
| CLI `certify` | `session.candidateId` → candidate → driver |
| `verifyCutover` | `session.targetSha` |
| runtime `performCertificationCatalogueCommand` | `fence.target_sha` |

`armExternalEffects` also moves its already-armed early return ahead of the
topology check. When the session is already `NEW_LINEAGE_ONLY` it arms nothing
new, and the topology it must match is the current binding's.

### Certification identity per revision

Run ids become revision-scoped: `certification-<session>` for revision 0
(unchanged, so existing rows keep their meaning), and
`certification-<session>-r<N>` after that. The runtime already binds every
command to the run named in the capability, and a capability to
`(session, release_sha)`, so it needs no new certification identity. The
capability for revision N carries that revision's `target_sha`.

`certification_catalogue_shut_before_release_succeeds` already joins every
capability of the session to its fixtures. So the session cannot settle while
any revision's fixture is open, including `fed1638`'s `-a2` fixture, which is
already closed and hidden. That stays the schema backstop.

## The command

```text
flexperiment-release forward-deploy <session-id> <candidate-id>
```

A new command, not `deploy`. `deploy` creates sessions. This one carries an
existing session forward, and the two must not share an entry point.

The command has two modes, decided from durable state and never from
arguments: **new revision** and **resume revision**.

### New revision: admission

All read-only, and all before anything changes. The candidate is
`MAINTENANCE_REQUIRED`. `LaunchBaselineAdmissionGuard` does not apply. A
dedicated `ForwardSupersessionAdmissionGuard` proves it afresh after the
runner lock is taken:

1. **Session.** It exists, is `RECOVERY_REQUIRED` and `NEW_LINEAGE_ONLY`,
   and the gate is closed and owned by it, with no rollback reserved.
2. **Candidate is today's main.** After `origin/main` is refreshed, the
   candidate equals its tip, and the candidate re-derives byte for byte from
   that commit.
3. **Forward successor.** The current binding's target is an ancestor of the
   candidate (`merge-base --is-ancestor`), and the candidate is not the
   current target.
4. **Runner is the candidate.** The installed runner's SHA and tree equal the
   candidate's.
5. **Exact-SHA CI attestation.** GitHub reports the designated workflow's
   `test` and `docker-build` as `success` for exactly this SHA, read with the
   release-control credential. Unreadable, pending, missing or failed all
   refuse. The real-router E2E is part of `test`, so this is what makes it a
   gate rather than a convention. The attestation read is stored in the
   revision as `ci_evidence`.
6. **The prior target is safe to supersede**
   (`certificationSafeToSupersede`). For every certification run of the
   current binding's target:
   - no pending command;
   - every catalogue fixture it created is `CLOSED` and `HIDDEN`;
   - no payment is unresolved (no `CREATE_UNKNOWN`, nothing awaiting provider
     reconciliation);
   - no captured amount remains unrefunded;
   - no refund obligation is open, and no refund is pending or reconciling.

   A recorded failure is not the reason; this state is. Today's production
   state satisfies it plainly. The base run did nothing. `-a2` made one
   fixture, recorded only `CREATE_OCCURRENCE`, and never published or opened
   it. That fixture is closed and hidden, and there are zero orders, zero
   payments and zero checkout idempotency rows.
7. **No live capability blocks the new one.** The session holds no unspent
   capability that has not expired. Such a capability would make the final
   issuance step fail after production had already moved, so this refuses
   before any migration or ref movement. A spent capability does not occupy
   the live slot and does not block. Attempt 5's last capability (`6a259177…`)
   expires 2026-09-24T07:29:00Z.

### New revision: order

```text
lock; claim the session (takeOverExpiredLease; a live holder is refused)
→ admission 1–7
→ apply the candidate's migrations                  [durable, see seam below]
→ appendForwardTarget(revision N)                   [durable: the target commitment]
→ CAS production-deploy
→ Coolify deploy frontend, admin, commerce
→ bounded topology convergence to revision N        (PR #150's waiter)
→ bounded readiness for revision N's candidate
→ issue certification run -r<N> + capability
→ session stays RECOVERY_REQUIRED, gate closed; yield lease
→ exit 13 AWAITING_OPERATOR
```

Then the existing `certify <session>`, resolving the current binding, and
then `verify`.

### Resume revision

Once revision N is recorded, its binding is the authority, including the CI
evidence already read. Resumption never re-asks whether the candidate is still
`main`'s tip, and never re-reads GitHub. If `main` moves while revision N's
Coolify deploy is running, revision N must still be finishable.

Re-running `forward-deploy` with revision N's candidate resumes it from
durable state:

| Durable state found | Resumption |
|---|---|
| candidate's migrations applied, **no revision N** | No target has been committed. Re-run the migrations (idempotent), re-run **new-revision admission** in full, then append. A later `main` may be chosen instead, but only if it descends from the current target and its migration inventory contains every migration already applied. |
| revision N; `production-deploy == from_sha` | CAS `from_sha → target_sha`, continue |
| revision N; `production-deploy == target_sha` | already moved, continue |
| revision N; `production-deploy` is anything else | refuse `FORWARD_DEPLOY_REF_DIVERGED` |
| ref at target, runtime not converged | redeploy through Coolify, then continue |
| converged, no `-r<N>` run | readiness, issue, 13 |
| `-r<N>` run exists | nothing to do; 13 (`certify` owns it) |

The CAS is never taken from whatever happens to be at the ref, only from the
revision's own `from_sha`.

A different candidate while revision N's run is not terminal is refused.
After revision N's certification fails, a newer candidate creates revision
N+1 through new-revision admission, including
`certificationSafeToSupersede` for revision N. There is no automatic retry.
Every revision is an explicit, current-main, CI-attested release.

Rollback stays forbidden throughout: the session is `NEW_LINEAGE_ONLY`, and
both the append guard and the table's triggers refuse any session that is not.

## Migrations

The candidate's migrations are applied while the *previous* target is still
serving. So they must be **predeploy-compatible expand migrations**: they may
add, but may not invalidate or change the meaning of any write the running
target can perform. That includes triggers on existing tables, which an
"additive" label would let through.

For the first forward release, that means the new table and its own triggers,
and nothing on existing tables. The previous target (`fed1638`) reacts to an
unknown applied migration only by halting email dispatch
(`EMAIL_DISPATCH_HALTED_UNKNOWN_MIGRATIONS`), which is harmless behind the
fence.

**Crash seam.** Migration comes before the revision. A crash between the two
leaves the candidate's migrations applied, no revision, and production still
on the previous target. That is safe: rollback is already forbidden, the
previous target keeps its behaviour under an expand migration, and no target
has been committed. The first row of the resumption table owns it.

## What the runtime fix PR must contain

Its gate is `real-router-e2e.test.ts` reaching `COMPLETE`, run through the
real app. The known defects, fixed structurally:

- **Quote behind the fence.** A certification quote path scoped to one run's
  own occurrence behind its owning fence. `checkoutContext()`'s public gate is
  not weakened. The path requires a valid claim, whose capability is bound to
  the fence's session and the serving release. It also requires that the
  occurrence is this run's catalogue-ledger fixture and that the run is in the
  phase that quotes. Anything else gets the ordinary gate.
- **Claim wire format.** An unambiguous encoding, for example three separately
  base64url-encoded fields joined by `.`, or a JSON object in one base64url
  field, parsed by one shared function used by both runner and runtime. No
  special case for "four pieces".
- **Whatever else the E2E finds** past those two, fixed before production.

Forward supersession is not implemented until that test proves the candidate
runtime is certifiable end to end.

## Out of scope

- Any retry of `fed1638` certification (`-a3`): that target is uncertifiable,
  so more retry machinery around it is dead end.
- Opening sales outside the release machinery.
- Generalising forward supersession beyond `MAINTENANCE_CUTOVER` sessions that
  are armed and stuck.

## Sequence

1. This note, reviewed.
2. Runtime fix PR: the E2E drives fixes until `COMPLETE`. This is the hard
   stop condition before step 3.
3. Forward-supersession PR: migration, `currentReleaseBinding`,
   `appendForwardTarget`, `ForwardSupersessionAdmissionGuard` with the CI
   attestation, `certificationSafeToSupersede`, and `forward-deploy`. It needs
   regressions through the real composition root, covering resumption from
   every row of the table above and refusal on every admission rule.
4. Merge, CI green, publish the `MAINTENANCE_REQUIRED` candidate, stage the
   runner.
5. `forward-deploy e4cb1a91… <candidate>` → 13.
6. `certify e4cb1a91…` (attended) → `verify` → gate opens.
