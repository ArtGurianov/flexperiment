# Closed-canary host readiness backport

Temporary compatibility lane for the **currently installed** closed canary.
Canonical `scripts/v2/fast-cut.py` and its storefront-mount guard stay intact.
This directory is an installation artifact; it is not selected automatically
by main, CI or a deployment workflow.

## Provenance and scope

`provenance.json` records the exact installed base, reviewed host improvements,
output SHA-256, unchanged AST and the only admitted release vector.
AST hashes use `nonempty-fields-json-v1`: node kinds, nonempty named fields,
ordered lists and typed constant values, with no location attributes. This
avoids version-dependent `ast.dump` output and newly added empty `type_params`.
Base/upstream hashes are derived independently from their pinned Git objects;
the helper's complete byte hash remains a separate check.

- Base helper: source `56f864ee5b5325acd2ed5c5ad6ea756182326bf7`, SHA-256
  `9ce826f47e8e07e1ea124fadc7ec39dcde5e4c52efe2094d9e80c4812a435583`.
- Host improvements: PR273–275 at `b2702c6597da8d487322a1fee7a713d2d77d2de4`.
- Commerce/Admin source: `56f864ee5b5325acd2ed5c5ad6ea756182326bf7`;
  Platform source: `80a11bde55c38973bcde99b4a92ee9e09c5dc6ad`.
- All three immutable image references must match the manifest exactly.
  Missing release.json, a different source or image refuses the compatibility
  lane before snapshot/upload. Existing private descriptor, RootFS, runtime,
  network, schema, fence and remote-ledger checks still apply.

Only host probes change: commerce10s, platform15s, admin20s; subprocess30s;
at most three fresh readiness attempts per role with5s pauses. Identity,
database, fence, ledger, snapshot and upload are not retried. Only allowlisted
stage/reason/detail/status reaches journals. There is no cached-success fallback.

The timeout drop-in is 90 min. The full subprocess budget is 74 min: identity
2,520 s, readiness/pauses 300 s, ledger 180 s, snapshot 900 s, copy 180 s,
upload 180 s and readback 180 s. This leaves 16 min for local work/scheduling;
it does not bound disk or CPU stalls. Tests derive command counts and timeout
values from the helper and existing transport. Timeout/JSON failures receive
fixed diagnostic codes without reflecting commands or upstream data.

The current containers retain their existing deadlines and healthchecks. This
does **not** install the8s Commerce deadline, fix Platform's internal3s wait,
reduce S3 healthcheck load, recreate containers or install PR276 alerts.

## Local validation

```sh
python3 -B deploy/host/canary-readiness-backport/test_backport.py -v
```

The suite includes the existing isolated Docker/nginx fixture. It never uses
production endpoints, secrets or database files. The canonical helper is not
imported by this suite.

## Installation boundary

Preparation is `CUSTODY_IMPACT: NO`: no deployed host change.
An installation is `CUSTODY_IMPACT: YES`, not inferred from green CI. The
shared host's [custody contract](https://github.com/ArtGurianov/adman-vps-infrastructure/blob/main/AGENTS.md)
requires exact-operation owner authorization, inventory/runbook updates and
fresh capture/restore evidence. Until those are complete report `CUSTODY_PENDING`.

Resources for a future approved installation:

| Resource | Authority/owner |
|---|---|
| `/opt/flexperiment-fast-cut-canary/scripts/v2/fast-cut.py` and retained predecessor | This reviewed compatibility artifact; Flexperiment host controller |
| `/etc/systemd/system/flexperiment-fast-cut-canary-backup.service.d/readiness-backport.conf` | `backup-timeout.conf`; Flexperiment systemd configuration |

No credentials or keys are added. Keep existing runtime descriptors, images,
database/WAL, signed ledger, fence, status/archive files and alert drop-ins.

### Before apply

1. Pin the reviewed controller commit and its own green CI. Read the manifest
   from that commit, not a mutable branch tip. Controller identity is separate
   from all application source SHAs.
2. Re-read the installed helper and require its SHA-256 to equal the base above.
   If already equal to the candidate, classify it as installed and inspect the
   timeout drop-in; never overwrite an unrelated helper. Any third SHA is HOLD.
3. Reclassify release vector, containers, qualified image identities, schema,
   OPEN/no-owner/zero-leases and current signed ledger. The compatibility pin
   is additional scope restriction, not replacement authority.
4. Read actual timer and service state. Wait for an active backup to finish;
   do not kill it. Preserve the exact prior timer enabled/active state before
   any approved temporary isolation. Never disable notifications to hide a hold.
5. Verify candidate SHA-256 against provenance.json. Load only its check and
   check-backup functions for read-only candidate qualification. Candidate
   backup must not run from a temporary directory: its transport module is
   the existing sibling `scheduled-backup.py` at the final installation path.

### Apply and read-back, only under the separate installation GO

Preserve a root-only predecessor of the helper and any predecessor drop-in.
Atomically replace only the helper at its existing path with root ownership
and the existing executable mode. Install backup-timeout.conf as the single
named drop-in above, then daemon-reload. Preserve all existing OnFailure hooks.
Restore only previously active schedules after candidate check/check-backup
succeed. No container restart, image or mount change is part of this operation.

Read back helper SHA-256, release vector, effective timeout90min, alert hooks,
timer state and next triggers. Compare container IDs/start times/images and
configuration to the pre-apply record. A new manual backup is a separate
snapshot/upload operation; do it only when that operation is authorized.
Calendar SUCCESS and the following freshness result are independent evidence.
No status.json rewrite, old-database restore, fence edit or admission reopen.

### Rollback and retirement

Owner decision on 23 October: retain this installed lane until the next normal
canary release from main; do not create a separate readiness-only image line.
The [mandatory release prerequisites](../../../docs/release/CLOSED_CANARY_RELEASE.md)
cover schema admission, storefront mounts, canonical-helper replacement and
Control Room network requalification. Monitor retries and final backup outcomes;
revisit the decision if backups fail despite bounded retries.

After any active backup finishes, restore the exact recorded helper predecessor
and only the prior named timeout drop-in (or remove that one file if absent
before). Daemon-reload and restore prior schedules. Do not reset failed units
as proof of health or touch archives/database/authority. Rollback returns the
old readiness sensitivity; it does not fix the original incident mechanism.

After the storefront runtime is separately admitted, this lane must refuse
its changed vector. Use the fully qualified canonical helper and retire this
directory in a later reviewed cleanup; never extend its pin automatically.
