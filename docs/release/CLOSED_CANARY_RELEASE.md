# Closed canary: prerequisites for the next release from main

## Owner decision, 23 October 2026

Do not create a separate readiness-only image release on the installed
Commerce `56f864ee` / Platform `80a11bde` bases. Keep the installed compatibility
helper and incident alerts; readiness fixes ship with the next ordinary,
qualified canary release from main. This decision authorizes no runtime change.

The backport retries readiness up to three times. A 10% per-attempt failure
rate would produce 0.1% failure after three independent attempts; that is a
conditional estimate, not a measured backup failure rate. Correlated S3
outages can exhaust every attempt. Unverifiable erasure authority must keep
readiness and backup closed, including with the new application deadlines.

## Mandatory release conditions

These are release prerequisites independent of the notification incident.
The observed source is `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; re-derive
the exact target's contract when preparing a later release.

| Condition | Required evidence before and after replacement |
| --- | --- |
| Schema admission matches the target | Canonical `scripts/v2/fast-cut.py` still requires `count(*) == 28` and the schema fingerprint beginning `40ede1d9`. Main adds migrations 0029–0035. Qualify a corrected canonical helper against the target's complete migration history and schema fingerprint, including refusal of missing, modified or unknown migrations. Prove migration of a current WAL-consistent copy, integrity/FK and preserved data. Do not weaken admission to a lower bound or edit the expected count on the VPS. |
| Storefront switch exists before the new Commerce starts | Follow the [storefront switch runbook](../storefront-switch-runbook.md): install both host directories with both storefronts CLOSED, add the exact read-only switch and journal binds, then verify permissions and runtime generation/digest. Do not omit the guard or open sales as part of this release. |
| Retire the compatibility helper with its old vector | The [installed backport](../../deploy/host/canary-readiness-backport/README.md) admits only its pinned old source/digest vector. Replace it with the reviewed, target-qualified canonical helper together with qualified per-role descriptors and release expectations. Preserve rollback bytes. Do not extend the temporary pin or accept an old-source backup status for the new Commerce. |
| Requalify Control Room networking | `control-room-network.json` binds both Admin and Commerce container IDs, network identity and addresses. Replacing Commerce invalidates it even when Admin is retained. Requalify actual socket peers, exact network membership, trusted proxy configuration and source/forged-header rejection; replacing Admin also requires this. Do not replay the old receipt or widen trusted IPs. |

The existing [canary upgrade procedure](ART-338_CANDIDATE_UPGRADE.md) contains
historical source/schema proposals; it is not a current target manifest.
Prepare and independently qualify the new exact source/digest vector, helper,
schema transition, backup/restore and rollback plan before runtime mutation.
Keep controller and application source identities separate. Preserve the
current database lineage, keys, signed remote ledger and ACTIVE/UNKNOWN fence
blocks; normal qualified boot alone may reopen admission.

Host helper, mounts, switch state and network receipt changes are
`CUSTODY_IMPACT: YES`. Update the infrastructure inventory/runbook and obtain
fresh external capture/mirror and isolated restore evidence under the shared
host contract. Publishing an artifact or passing CI does not establish this.
This document-only change is `CUSTODY_IMPACT: NO`.

## Observe the current backport until that release

Read only the `flexperiment-fast-cut-canary-backup.service` journal and its
systemd result/invocation, the timer's state, and the existing `check-backup`
freshness result. In particular, track:

- `FAST_CUT_READINESS_RETRY`: role/stage, attempt and fixed reason, grouped by
  backup invocation; retries followed by SUCCESS are recovered attempts.
- `FAST_CUT_HOLD`: fixed failure stage/reason and invocation time; distinguish
  an invocation still running from one that finished unsuccessfully.

Compare completed backup outcomes and freshness, not just individual HTTP503s.
Repeated polling must not emit duplicate incident reports. Quiet successful
runs need no notification. A failed backup after bounded retries, new HOLD,
stale backup, or loss of monitoring requires an actionable report with bounded
diagnostics. Reconsider a separate release with the owner if backups still fail;
do not deploy one automatically. Logs may not establish independence of retries.

Monitoring never starts/retries a backup, restarts containers, changes a
helper/vector/receipt, modifies fencing or calls notification providers. Keep
raw private descriptors, credentials, cookies and upstream bodies out of reports.
