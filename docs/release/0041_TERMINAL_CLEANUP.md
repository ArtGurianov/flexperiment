# HISTORICAL - DO NOT EXECUTE: 0041 terminal cleanup

0041 is terminally complete. Repo-side cleanup removed the dedicated Gen1
bridge command, v1 receipt readers/verifier, 0041 recovery workflow, and the
accidentally inherited `.release/maintenance-only` marker from `main`. The
immutable maintenance artifact
`d899d0a2ee1e1b618fe10403ca83aacf7018db93` is not changed and retains its
maintenance-only marker as forensic evidence.

## Required operator cleanup after this change is merged

Perform these only with the emergency sales latch still `true`:

1. Remove the protected production variable
   `GEN1_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA`.
2. Remove production secrets `GEN1_OFFLINE_BRIDGE_SSH_PRIVATE_KEY` and
   `GEN1_OFFLINE_BRIDGE_SSH_KNOWN_HOSTS`, then revoke the associated host
   credential.
3. Remove `/root/flexperiment-0041-tools/node` if it has no other reviewed
   owner, and remove the dedicated maintenance worktree/artifact from the
   host.
4. Read production status and prove Gen2 is still deployed with candidate
   `COMPLETE` / sequence `7`, ATTEMPT authority open at revision `8`, and no
   release or dispatch owner.
5. Confirm no production workflow, repository script, or host artifact retains
   an executable 0041 bridge or recovery route.

Do not remove the emergency latch as part of this checklist. Its eventual
`true -> false` change is a separate final authorization after the checks
above complete.
