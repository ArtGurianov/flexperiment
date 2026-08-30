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

| durable phase | exit available | how |
|---|---|---|
| `PAUSED` / `DEPLOYED_READ_ONLY` | back | `abort` |
| `CERTIFICATION_ONLY` / `_IN_FLIGHT` | forward | certification retry, or certification defect |
| `CERTIFIED`, authority `LEGACY` | forward | `classify_pre_activation_defect` → replacement |
| `CERTIFIED`, authority `ATTEMPT` | forward only | finish: `unfence`, then `complete` |

**`abort` is narrower than it looks.** `abortCandidate()` refuses any generation
that was *ever* `CERTIFIED`, and otherwise permits only `PAUSED` or
`DEPLOYED_READ_ONLY`. Since `prepare` activates the certification lease from
`DEPLOYED_READ_ONLY`, the generation leaves abort's reach before the operator
ever runs `certify`. Do not plan a rollback around abort past that point; plan it
around the recovery transitions above.

Everything provable is proven before `activate`, which is why the real 1-RUB
certification sits ahead of it: it establishes that the candidate binary
transacts correctly while a forward recovery is still cheap.

## Recovering a certified candidate whose activation refused

This window previously had no controller path in either direction — `abort`
refuses an ever-certified generation, readiness classification only handles
`PAUSED`, and replacement adoption requires `RECOVERY_REQUIRED`. So a candidate
that certified cleanly and then failed its activation preconditions could go
neither forward nor back, with attempt authority still safely `LEGACY`.

```text
stage=classify_pre_activation_defect
  target_sha=<initial>
  pre_activation_defect_class=ACTIVATION_PRECONDITION | ACTIVATION_SCHEMA | ACTIVATION_STORE
  pre_activation_defect_code=<the exact OUTBOX_ACTIVATION_* refusal>
```

It is deliberately narrower than a weaker `abort`: it opens only while attempt
authority is still `LEGACY` **and** the dispatch fence still belongs to this
release, so it cannot walk back anything that actually moved. The certification
binding survives byte for byte — what failed is the step after certification, and
the money it moved is not un-moved. The defect code is bound to the vocabulary
the activation transaction actually returns, so a recovery cannot be justified by
an invented reason.

The generation lands in `RECOVERY_REQUIRED`. From there, dispatch `prepare` with
`replacement_sha` as usual.

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

Post-`prepare` stages take the runtime source from the **durable candidate
head**, not from `target_sha`. `replacement_sha` is accepted only on `prepare`,
so a later independent stage would otherwise be looking at the original SHA and
would refuse the very generation it exists to drive. `RELEASE_ID` stays derived
from the initial `target_sha` throughout — it is the epoch's durable identity —
and the dispatch epoch is derived from it, which is what keeps the fence owned
across a generation bump.

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
| `NO_QUEUED_CERTIFICATION_MAIL` | the certified order's mail is missing or already started | checked BEFORE activation, so nothing irreversible has happened. If a send already started, the fence was not doing its job |
| `ATTEMPT_DISPATCH_NOT_OBSERVED` | the certified order's own attempts did not settle after unfence | mail is flowing again either way; investigate the worker. `complete` will refuse until this proof passes |
| `DISPATCH_PROOF_MISSING_BEFORE_COMPLETE` | the data-plane proof never succeeded | re-run `unfence` (it reconciles) or investigate; do not complete an epoch whose proof failed |
| `EFFECTIVE_SOURCE_*` | the durable head's source is unreadable or unreachable | the candidate head is the authority for what is deployed; fix that before anything else |
| `REPLACEMENT_NOT_FORWARD_ONLY` | the replacement is not a descendant of the recovering source | forward-only means forward in Git, not only in the generation counter |
| `PRE_ACTIVATION_NOT_RECOVERABLE` | authority moved, or the fence is not ours | recovery is forward only from here: finish with `unfence` then `complete` |

## Recovering an aborted cutover that left the fence held

`abort` releases the release gate and deliberately does **not** lift the fence:
mail stays stopped until an operator decides which way the cutover is going. The
run prints `ABORT_DISPATCH_FENCED` and warns.

The recovery unfence requires the candidate to have actually let go —
`ABORTED` or `RECOVERY_REQUIRED`. A still-`LEGACY` store is not sufficient on its
own: mid-cutover, during `CERTIFICATION_ONLY`, the store is also `LEGACY`, and
opening dispatch there would resume mail under a half-migrated epoch and strand
the run, because the `fence` stage then refuses a runtime that already carries
the attempt store.

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

`adoptCandidate()` checks the generation, the state hash and the applied-migration
prefix. It has **no ancestry concept**, so the workflow enforces the Git half:
the recovering generation's `source_commit` must be an ancestor of the
replacement, and the replacement must be reachable from the controller. A lost
adopt response reconciles against the exact adopted generation rather than
retrying into `RELEASE_STATE_STALE`.

From `RECOVERY_REQUIRED`, dispatch `prepare` with `replacement_sha`. The release
ID and the dispatch epoch are both derived from the original `target_sha`, so the
fence stays owned by this cutover across the generation bump. That is why the
dispatch epoch deliberately carries no generation: binding it to one would make
the fence unowned by its own cutover the moment a recovery happened.

## After completion

The post-cutover resting state is `COMPLETE` with the emergency latch still on,
sales closed, and mail flowing under `ATTEMPT` authority. Verify the public site,
then clear the latch from the admin dashboard. No workflow ever clears it.
