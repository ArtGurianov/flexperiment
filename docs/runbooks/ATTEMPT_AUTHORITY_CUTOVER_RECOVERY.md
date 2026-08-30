# Outbox attempt-authority (0041) cutover recovery

Classify durable state before any action. Do not use `HEAD` or `main` as
authority, do not manually reopen sales, and do not manually edit
`outbox_authority`.

Use the manual
[`controlled-outbox-attempt-authority-cutover.yml`](../../.github/workflows/controlled-outbox-attempt-authority-cutover.yml)
workflow only. Its controller SHA is not the deployment source: operators pass
the exact initial `target_sha`, and the durable identities remain
`outbox-attempt-authority-v1:<initial-sha>` for both the release owner and the
dispatch epoch throughout recovery, including after a forward-only replacement.

## What makes this epoch different

Every other controlled cutover is reversible until `complete`. This one contains
a step that is not.

| step | reversible? | how |
|---|---|---|
| `fence` | yes | `unfence` with `unfence_mode=recovery` |
| `prepare` | yes | `abort`, then move `production-deploy` back |
| `certify` | yes | `abort` |
| **`activate`** | **no** | there is no `ATTEMPT -> LEGACY`, by design |
| `unfence` | — | terminal; the only step that resumes mail |
| `complete` | — | ends the epoch |

Everything provable is therefore proven before `activate`, which is why the real
1-RUB certification sits ahead of it: it establishes that the candidate binary
transacts correctly while rolling back is still an option.

## The four durable states

Read them from `GET /v1/internal/release-control/outbox-authority` with the
release-control bearer credential. Never infer them from which stages have been
dispatched.

```text
A   attempt_authority LEGACY   email_dispatch_paused false   attempts null
    Production before the cutover. Start at stage=fence.

B   attempt_authority LEGACY   email_dispatch_paused true    attempts object
    0041 applied, authority NOT moved, mail stopped by this epoch.
    Between prepare and activate. Mail is DELAYED, not lost - rows stay PENDING.

C   attempt_authority ATTEMPT  email_dispatch_paused true    attempts object
    Activated, mail still stopped. Between activate and unfence.
    THE ONLY WAY FORWARD IS unfence. There is no way back.

D   attempt_authority ATTEMPT  email_dispatch_paused false   attempts object
    The terminal state. complete is now permitted.
```

`attempts: null` means the runtime has no attempt store, which before `prepare`
is correct and after it means the deployed binary is not the candidate. The
field's absence is a liveness signal, never a converged store.

## Stage sequence

```text
fence      target_sha
prepare    target_sha + the four certification fixture inputs
           (pay the 1-RUB order, then refund it, as in every certification)
certify    target_sha + certification_order_id
activate   target_sha
unfence    target_sha + unfence_mode=activated
           -- operator latches the emergency stop from the admin dashboard --
complete   target_sha
           -- operator clears the emergency stop --
```

The emergency latch ordering is the same as the 0040 epoch and is safety-critical
in both directions: OFF before `certify`, because a certification order is a real
payment and the emergency stop is absolute; ON before `complete`, because
`completeCandidate` clears the release gate.

## The two rules that have no workaround

**Never complete while dispatch is fenced.** The fence is owned by an epoch,
completing ends the epoch, and stranded-fence takeover is deliberately not built.
The workflow refuses with
`ATTEMPT_AUTHORITY_CUTOVER_DISPATCH_MUST_BE_RESUMED_BEFORE_COMPLETE`. If you
somehow reach that state, the only remedy is a new epoch that adopts the fence,
which does not exist — so the refusal is the recovery.

**Never edit `outbox_authority` by hand.** Its revision is the CAS token every
transition depends on, and its owner is what stops a second controller unfencing
in the middle of this one's migration.

## Refusals, and what each one means

| code | meaning | action |
|---|---|---|
| `FENCE_RUNTIME_ALREADY_ADVANCED` | the runtime already has an attempt store | you are past `fence`; read the durable state and resume from there |
| `DISPATCH_NOT_DRAINED` | a send is still in flight | wait; the worker sweeps every 30s. Persisting means a stuck lease — inspect before forcing anything |
| `DISPATCH_NOT_QUIESCENT` | drained once, not twice | something started a send after the fence. Do not proceed; the fence is not doing its job |
| `FENCE_REQUIRED_BEFORE_PREPARE` | deploying 0041 with mail flowing | run `fence` first |
| `ALREADY_ACTIVATED_BEFORE_PREPARE` | authority moved before the deploy | stop; this should be impossible and means state was edited outside the workflow |
| `ACTIVATION_CAPABLE_RUNTIME_REQUIRED` | candidate predates the activation layer | rebuild the candidate from a commit that contains `commerce/src/outbox-activation.ts` |
| `RUNTIME_NOT_READY` | convergence poll exhausted | read `status.json` in the run log; the failing clause names the fact |
| `ACTIVATE_REQUIRES_CERTIFIED_CANDIDATE` | activating before the reversible proof | certify first |
| `ACTIVATE_PRECONDITION_INVALID` | fence, owner, drain or attempt store wrong | read the printed authority document; do not retry blindly |
| `OUTBOX_ACTIVATION_SCHEMA_INCOMPLETE` | a 0041 enforcement object is missing | the error names it. The store is not safe to activate — do not proceed |
| `OUTBOX_ACTIVATION_UNEXPECTED_SETTLED_ATTEMPT` / `_SUCCESSOR_ATTEMPT` | a binary wrote attempt facts under LEGACY | stop. This is the old/new disagreement the cutover exists to serialize |
| `OUTBOX_ACTIVATION_UNEXPECTED_SHADOW_STATE` | a shadow attempt carries a lease expiry or exhaustion instant | stop and inspect; these have no legacy source |
| `OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH` | message and attempt #1 disagree about what was sent | stop. Resolving this by rewriting either key would risk a duplicate send |
| `STORE_NOT_CONVERGED` | post-activation defects non-zero | the activation transaction would have refused; investigate before unfencing |
| `NO_BACKLOG_TO_PROVE_DISPATCH` | nothing was queued under the fence | the run cannot prove ATTEMPT dispatch. Enqueue something real, or accept the proof is deferred and record that |
| `ATTEMPT_DISPATCH_NOT_OBSERVED` | backlog did not settle after unfence | mail is flowing again either way; investigate the worker before completing |

## Recovering an aborted cutover that left the fence held

`abort` releases the release gate and deliberately does **not** lift the fence:
mail stays stopped until an operator decides which way the cutover is going. The
run prints `ABORT_DISPATCH_FENCED` and warns.

To resume mail on a store that was never activated:

```text
stage=unfence  unfence_mode=recovery  target_sha=<the same initial sha>
```

The recovery mode asserts `attempt_authority` is still `LEGACY` and skips the
ATTEMPT-dispatch proof, because nothing was activated and there is nothing to
prove. It refuses with `RECOVERY_UNFENCE_ON_ACTIVATED_STORE` if authority has in
fact moved — in that case the normal `unfence_mode=activated` path is correct.

Then, if the candidate was deployed, move `production-deploy` back to the
previous runtime through the guarded helper. 0041 is additive and the control row
survives on a rolled-back binary; the old binary simply does not read the new
columns.

## Forward-only replacement

From `RECOVERY_REQUIRED`, dispatch `prepare` with `replacement_sha`. The release
ID and the dispatch epoch are both derived from the original `target_sha`, so the
fence stays owned by this cutover across the generation bump. That is why the
dispatch epoch deliberately carries no generation: binding it to one would make
the fence unowned by its own cutover the moment a recovery happened.

## After completion

The post-cutover resting state is `COMPLETE` with the emergency latch still on,
sales closed, and mail flowing under `ATTEMPT` authority. Verify the public site,
then clear the latch from the admin dashboard. No workflow ever clears it.
