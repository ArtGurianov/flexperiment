# 0041 terminal cleanup checklist

Run this checklist only after a separately authorized `COMPLETE` has committed
and its durable head, open gate, and dispatch proof have been independently
read back. No runtime auto-cleanup is permitted.

## Retired now

- the Gen1-to-Gen2 host bridge is a fail-closed historical stub;
- the Gen2 deploy-only GitHub workflow has been removed;
- no remaining 0041 workflow can deploy, start, restart, or read Gen1.

## Retained until COMPLETE

- `scripts/read-0041-offline-bridge-receipt.sh` and
  `scripts/read-0041-offline-bridge-receipt-from-pinned-volume.sh` remain for
  audit and forensic SQLite/receipt proof only;
- `commerce/src/assert-gen1-to-gen2-offline-bridge.ts` remains their read-only
  verifier;
- this historical bridge record remains for incident reconstruction.

## Explicit post-COMPLETE operator actions

1. Remove the remaining v1 receipt readers and Gen1-to-Gen2 bridge verifier
   in a reviewed cleanup change; retain only a historical, non-executable
   incident record marked **HISTORICAL — DO NOT EXECUTE**.
2. Remove the dedicated production variable
   `GEN1_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA`.
3. Remove production secrets `GEN1_OFFLINE_BRIDGE_SSH_PRIVATE_KEY` and
   `GEN1_OFFLINE_BRIDGE_SSH_KNOWN_HOSTS` if no other controller references
   them; revoke the associated host credential.
4. Remove `/root/flexperiment-0041-tools/node` if it has no other reviewed
   owner, and remove the dedicated maintenance worktree/artifact from the host.
5. Remove stale execution wording from this and related runbooks; historical
   records must stay explicitly marked **HISTORICAL — DO NOT EXECUTE**.
6. Confirm no production workflow retains a `workflow_dispatch` route for the
   bridge or deploy-only recovery and no artifact can restart/deploy Gen1.
7. Remove the accidental inherited `.release/maintenance-only` marker from
   `main` before the next ordinary deployable runtime candidate. Do not alter
   historical maintenance artifact
   `d899d0a2ee1e1b618fe10403ca83aacf7018db93`: it remains immutable and must
   retain its marker as maintenance-only evidence.

The credential and host removals are deliberate operator actions, not a side
effect of `complete`.
