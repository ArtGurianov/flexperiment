# 0041 post-bridge Gen2 email recovery

This is a controlled data-plane recovery for the fixed 0041 epoch. It is not
normal deployment behavior. The offline bridge and Gen2 deployment are already
complete; this controller must never replay either operation or run Gen1.

## Fixed state and identities

- release: `outbox-attempt-authority-v1:68f80a411b7f286928ef10826ed225228098d246`
- only runtime source: Gen2 `0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34`
- generation: `2`
- start state: `PAUSED`, sequence `0`, sales gate paused and owned, `ATTEMPT`
  authority fenced by this release at revision `7`

The original Gen1 certification `TICKET` attempt remains immutable evidence of
the UniSender `1588` refusal. It is neither retried nor overwritten. The
supported certification retry API applies only to a cancelled/expired payment
before certification, not to a terminal email provider refusal. Gen2 instead
uses a fresh fixture and a fresh real 1-RUB checkout to prove the corrected
contractual-mail payload.

## Stages

Every stage is one manual dispatch of
`controlled-0041-gen2-email-recovery.yml`; none advances into the next one.

1. `prepare_certification` proves deployed Commerce and worker are Gen2,
   `production-deploy` is Gen2, the gate remains paused, emergency latch is
   off, and ATTEMPT is fenced at revision 7. It changes only `PAUSED/0` to
   `DEPLOYED_READ_ONLY`, then creates a fresh 180–300 second fixture lease.
2. The operator immediately mints the quote and submits the real checkout with
   the fresh raw key, pays and refunds it. No raw key is sent to the workflow.
   Then `certify` records exact financial evidence and proves the new order's
   mail is queued and unstarted under the fence.
3. `unfence` admits only exact certified Gen2, uses a revision-7 CAS, and polls
   the exact certified order's durable `TICKET` attempt. Success requires an
   accepted ATTEMPT settlement started after `DISPATCH_UNFENCED`; population
   counters never substitute for this identity-bound proof. Sales remain paused.
4. If the proof does not succeed, do not complete. An explicit
   `contain_after_unfence_failure` dispatch requires the unsuccessful exact
   order proof, re-fences at revision 8 under the same epoch, and proves drain
   at revision 9. It preserves all attempt rows and leaves sales paused.
5. `complete` is a later, separately authorized boundary. It requires emergency
   latch **on**, certified Gen2, ATTEMPT dispatch open at revision 8, and a
   freshly reread durable accepted-dispatch proof. It is not part of this
   recovery's production action without a separate GO.

## Receipt v2 principle

Future offline bridges must write receipt schema v2 through
`scripts/write-offline-bridge-receipt-v2.sh`. A future reviewed controller must
hard-bind `COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID` to an immutable safe-basename
bridge identity; the v2 reader derives the exact sibling receipt name from it
and requires the receipt to bind it back. It contains
`database_storage_kind=docker_volume`, `database_volume_name`, and
`database_destination`, derived from the already-proved bridge substrate. The
v2 reader inspects only the controller-bound exact volume, rejects any live
Name or mountpoint reference, and invokes a bridge-specific SQLite verifier
read-only. It never scans Docker volumes or searches for a plausible database.

The committed 0041 receipt remains schema v1 and is never rewritten. Its
pinned-volume reader is historical compatibility evidence only.
