# 0041 offline Gen1-to-Gen2 bridge

This is a one-shot recovery for the fixed 0041 release only. It is not a
general deployment or replacement procedure. Until its separate production GO,
do not run the host bridge, the Gen2 deploy-only workflow, `complete`, a
certification retry, or a pre-activation classifier.

## Fixed identities

The durable source is Gen1 `68f80a411b7f286928ef10826ed225228098d246`; the
only deployment source after the bridge is Gen2
`0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34`. The maintenance artifact is never
a deployment target. Before any production execution, record the final,
reviewed PR #28 maintenance commit SHA in the protected production variable
`GEN1_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA`. It must name the exact
two-parent maintenance artifact (`6500586…` first parent, Gen2 second parent)
that carries `.release/maintenance-only`.

The host runner requires the same SHA as
`COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA`, proves its checked-out
worktree is clean and exact, and refuses any other tree before it disables a
restart policy.

## Fresh state-hash discipline

Immediately before offline exclusion, take one authenticated, read-only
authoritative Gen1 candidate-head read and record its `state_hash`. Pass that
64-character value to the host runner as
`COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH`. The runner validates its
shape before it changes Docker restart policy or stops either reader, and
passes it explicitly to the bridge transaction. The transaction then rereads
the Gen1 head inside `BEGIN IMMEDIATE`; the value remains a CAS condition, not
an operator assertion.

## Execution and recovery boundary

The host runner discovers the exact Gen1 Commerce and worker containers from
their Compose labels, source SHA, and shared SQLite volume. It disables both
Docker restart policies, stops both containers, and proves no running container
mounts that volume before it writes the ledger pair. It never starts a
container. A committed bridge writes a root-owned `0600` receipt beside the
database.

This is a rare incompatible-reader recovery, not the normal Flexperiment
deployment path. Once the bridge appends the first
`POST_ACTIVATION_EMAIL_PROVIDER_DEFECT`, Gen1
`68f80a411b7f286928ef10826ed225228098d246` cannot replay the durable history.
Therefore every Gen1 database/ledger reader must be stopped and denied a
restart path before that write. After the bridge commits, restarting or rolling
back to Gen1 is forbidden: only Gen2
`0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34` may be the next runtime reader.

### Maintenance-window semantics

For this recovery, downtime starts when the Gen1 readers stop and ends only
after Gen2 is deployed and passes its readiness convergence proof. Disabling
restart and stopping the containers, plus the atomic SQLite bridge transaction,
are expected to be small overhead. The meaningful maintenance window is the
whole interval:

```text
Gen1 stopped -> bridge committed -> production-deploy CAS -> Gen2 deployed
             -> Gen2 readiness converged
```

The prior Gen1 process cannot continue serving after the bridge because it is
no longer a compatible ledger reader. Consequently, zero-downtime blue/green
operation between these particular Gen1 and Gen2 sources is not possible. This
does not establish a timing SLA; image build/pull, deployment, startup, and
readiness convergence may dominate the window.

To minimize that window, Gen2 may be built, pulled, or otherwise prepared
before reader exclusion only if the preparation does not mutate production
durable state and does not start Gen2 against production SQLite. After stop and
commit, the remaining work is the exact `production-deploy` CAS, launch of the
prepared Gen2 runtime, and readiness proof. Neither preparation nor Coolify's
webhook replaces the host-level reader-exclusion proof.

The receipt is only a locator/checkpoint. Before `production-deploy` can move,
the deploy controller reads it from the stopped host, verifies its owner and
artifact identity, then invokes the exact maintenance worktree's read-only
SQLite verifier. That verifier recomputes the Gen2 head/state hash, checks the
last two ledger events, projection reconciliation, ATTEMPT/fence/revision 7,
and zero sending/leased rows. A receipt that does not match durable SQLite
state fails closed.

Only after that proof may the deploy controller CAS `production-deploy` from
Gen1 to exact Gen2 and invoke `controlled-coolify-deploy.sh` for Gen2. It never
rolls the pointer back to Gen1. Runtime API calls are permitted only after the
Gen2 deploy trigger, for the paused-state convergence proof.
