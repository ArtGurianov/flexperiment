# Forward supersession of an armed cutover session

Status: design, for review before implementation. Nothing here is built yet.

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
| only one non-terminal session may exist, and this one owns the gate | `deploy_sessions_single_non_terminal_idx` |
| `FIX_FORWARD_ONLY` is a plan kind with no executor | `planResume()` |
| the runtime judges certification against `deploy_sessions.target_sha` | `performCertificationCatalogueCommand()` |

## Principle

**The session's original target is a historical fact and stays one.** What
changes is a separate, monotonic record of the session's *current forward
target*. The session keeps its identity, its gate, its rollback authority
and its pre-deploy snapshot. It gains a history of which releases it has been
carried forward to.

Nothing certified for one target counts for another. `fed1638`'s certification
runs and capabilities stay as forensic history. Each forward target gets its
own run and capability, bound to the same session, its own release SHA and its
own forward revision.

## Model

A new table, shipped as an additive migration in the forward release:

```sql
CREATE TABLE deploy_session_forward_targets (
  session_id   TEXT NOT NULL REFERENCES deploy_sessions(id),
  revision     INTEGER NOT NULL CHECK (revision >= 1),
  from_sha     TEXT NOT NULL,   -- the target this one supersedes
  target_sha   TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
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
  gate closed, with no `bootstrap_rollback_id`. The schema refuses a forward
  target for a session that could still roll back, or that is not stuck.

The **current target** of a session is the `target_sha` of its highest
revision, or `deploy_sessions.target_sha` when it has none. That one function
(`currentTarget(session)`) replaces every read of the target in code that
decides anything:

- orchestrator: `requireTargetTopology`, `requireReadiness`, `completeTarget`
- CLI `certify`: which candidate, which certification driver
- `verify`: what the runtime must be serving
- runtime `performCertificationCatalogueCommand`: `serving` must equal the
  fence's *current* target

`completeTarget()` settles only against the current target. The frozen
`target_sha` keeps meaning "what this cutover first set out to deploy".

### Certification identity per target

Run ids become revision-scoped: `certification-<session>` for revision 0 (the
original target, unchanged, so existing rows keep their meaning), and
`certification-<session>-r<revision>` after that. The runtime already binds
every command to the run named in the capability, and a capability to
`(session, release_sha)`, so the runtime needs no new certification identity.

The live-capability slot is per session. Issuing the new target's capability
retires an expired prior one through the existing store and database-clock
guard. A prior target's capability that is still live blocks issuance with
`CERTIFICATION_CAPABILITY_ALREADY_LIVE`, and it is never retired early.
Attempt 5's last capability (`6a259177…`) expires 2026-09-24T07:29:00Z, long
before any forward release can be ready.

`certification_catalogue_shut_before_release_succeeds` already joins every
capability of the session to its fixtures. So the session cannot settle while
any target's fixture is open, including `fed1638`'s `-a2` fixture, which is
already closed and hidden. That stays the schema backstop.

## The command

```text
flexperiment-release forward-deploy <session-id> <candidate-id>
```

A new command, not `deploy`. `deploy` creates sessions. This one carries an
existing session forward, and the two must not share an entry point.

### Admission (all read-only, all before anything changes)

1. The session exists and is `RECOVERY_REQUIRED`, `NEW_LINEAGE_ONLY`, with the
   gate closed and owned by it, and no rollback reserved.
2. The candidate is published, and admitted by the existing consumption guard
   (it must be `main`'s tip).
3. The candidate is a forward successor: the session's current target is an
   ancestor of it (`merge-base --is-ancestor`), and it is not the current
   target.
4. The runner's installed tree is the candidate's. Because of (2), this is the
   same check the other launch commands already make.
5. **The real-router certification E2E is part of the candidate's CI**, so (2)
   (published only against its own green CI) covers it. Admission does not
   re-run tests. It relies on publication having refused a red candidate.
6. The session's current target has no certification run that is mid-flight.
   Every run for it is terminal (failed or complete), and none has a pending
   command. This prevents carrying a session forward over a payment that is
   still resolving.

### Order

```text
lock + claim the session (takeOverExpiredLease; refuse a live holder)
→ apply the candidate's migrations                         [durable]
   (additive only; fed1638 halts email dispatch on an unknown
    migration, which is harmless behind the fence)
→ insert forward target revision N (from = current target)  [durable, the point of commitment]
→ CAS production-deploy: current target → candidate
→ Coolify deploy frontend, admin, commerce
→ bounded topology convergence to the candidate             (PR #150's waiter)
→ bounded readiness for the candidate's expectation
→ issue certification run -r<N> + capability for the candidate
→ session stays RECOVERY_REQUIRED, gate closed, lease yielded
→ exit 13 AWAITING_OPERATOR
```

Then the existing `certify <session>`, which now resolves the current target,
and then `verify`.

### Failure and resumption

Everything after the forward-target insert is resumable from durable state
alone, and re-running `forward-deploy` with the same candidate resumes it:

| Durable state found | Resumption |
|---|---|
| revision N exists for this candidate, ref not moved | CAS, then continue |
| ref at candidate, runtime not converged | redeploy through Coolify, then continue |
| converged, no `-r<N>` run | readiness, issue, 13 |
| `-r<N>` run exists | nothing to do; 13 (certify owns it) |

A different candidate while revision N's run is not terminal is refused.
After a revision's certification fails terminally, a further `forward-deploy`
with a newer candidate creates revision N+1. There is no automatic retry.
Every revision is an explicit, published, CI-gated release.

Rollback stays forbidden throughout: the session is `NEW_LINEAGE_ONLY`, and
the table's triggers refuse forward targets on any session that is not.

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

## Out of scope

- Any retry of `fed1638` certification (`-a3`): that target is uncertifiable,
  so more retry machinery around it is dead end.
- Opening sales outside the release machinery.
- Generalising forward supersession beyond `MAINTENANCE_CUTOVER` sessions that
  are armed and stuck.

## Sequence

1. This note, reviewed.
2. Runtime fix PR: the E2E drives fixes until `COMPLETE`.
3. Forward-supersession PR: migration, `currentTarget`, `forward-deploy`, with
   a regression through the real composition root. It must include resuming
   from each row of the table above, and refusal on every admission rule.
4. Merge, CI green, publish the candidate, stage the runner.
5. `forward-deploy e4cb1a91… <candidate>` → 13.
6. `certify e4cb1a91…` (attended) → `verify` → gate opens.
