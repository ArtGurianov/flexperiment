# ART-337: continuation from journal v2 and Commerce schema 0026

**Engineering preparation only. Live execution HOLD.** Independent review of
the new controller and a new owner GO TO EXECUTE are required. Do not run the
original `requalification --commit` or `requalified-canary` deployment again.
Do not restore schema 0025 or merge PR #222.

## Durable starting point

| Authority | Required value |
| --- | --- |
| Deployment source / current main | `08523bdf38eeddf5e745ce04d05e1f980a7ced93` |
| Parent admission version | 2 |
| Parent admission SHA-256 | `3496ccc7d51c691cb65035c6e09b69ac44ef24a1358d2021fc49ae88652a2a0b` |
| Parent owner-rpc file SHA-256 | `3501e388c0d300d6cec871fd88cd65b40c77d946671e5b6b16539a66bb4c4d6f` |
| Commerce schema | 0026; `c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39` |
| Installation | `6982499b-1567-46e4-b9e7-ab54416d8b8d` |
| Reader binding | `c41e2f717c83275cb4d4d5206b50b3994324c7f58f1c496126edee0b428a8490` |
| Original Commerce UUID | `xzuy7pk5y6ywjr9kh6nsk5ap` |
| Payload/Platform UUID | `ks8c2wmlle1kvdfuwbiwthe1` |
| Existing stopped Commerce UUID | `irskrskdhh2addt3xbkpbnrr` |
| Successful create intent SHA-256 | `b12c7c025fd44edc98cb0cb14d354a3cfc5915b63d4926909069964ea4b41dba` |
| Successful create outcome SHA-256 | `96f176e1e48ac998238dd4e3f4f2a5ba16320f2585914e3dbd36db8292ac096f` |

The original v2 `imageId` is historical evidence. It is never changed to the
installed mismatching image or to a newly qualified image. Preserve the
entire admission history, all original evidence, the Payload archives and the
post-stop schema-0026 encrypted archives and remote chain. The original apps
remain stopped; timers remain in their confirmed disabled/inactive state.
New unknown records, queues, leases, schema/lineage drift or lost custody HOLD.

## Delivery choice and compatibility

Installed Coolify **4.4.6** was inspected read-only. Its PATCH validator uses
`BuildPackTypes` without `dockerimage`; unsupported in-place conversion is
not used. Its Dockerfile job explicitly disables `restart_only` for Dockerfile
and Docker Image resources. A restart is therefore not an immutable-delivery
repair. Deployment `vqdxaybzu5e22xsm6ryaekey` contains a second Docker build.

The separate **stopped Docker Image** resource already exists. Do not replay
`POST /applications/dockerimage`, delete it or replace its create evidence.
The controller CLI now unconditionally refuses `create`. Original
environment/project/server/destination are checked during reconciliation. No Git checkout/rebuild, public
ports/domains, instant deployment, previews or automatic deployment. Its new
UUID is bound in journal v3. Creation explicitly encodes and read-back requires
`docker_registry_image_name=repository` and
`docker_registry_image_tag=sha256-<64 lowercase hex>`. The installed deployment
job resolves that pair as `repository@sha256:<hash>`. The same shared encoder
is used by create, configuration and validation; a bare hash field is rejected
before provisioning or deployment. See the captured 4.4.6 source fixture for
API normalization (which can also change an image name for bare hash input).

It receives the old Commerce UUID as an internal
network alias; the stopped old resource retains its UUID and history.

Native persistent-storage API prefixes a new UUID. Consequently the new
resource uses seven native **Directory** bindings: the two exact existing
Docker-volume Mountpoints as RW binds, the existing RW fence directory and
four existing RO erasure directories. No volume is recreated, copied/reset,
deleted or mounted somewhere else. Name, absolute path, device and inode are
checked against custody and then independently against installed mounts.
Kernel RO mounts, UID 1000 reader files and required installation marker stay
unchanged. Preserve old resource storage records as custody references.

The existing scheduled-backup inspector already supports directory binds.
Its owner `deploy-config.json` canary lookup is adopted **after** independent
new-runtime verification, with the old config archived byte for byte. Only
`apps.canary` changes; production and all other fields are preserved. A real
scheduled encrypted backup, independent remote SHA read-back/decrypt and
freshness check are mandatory afterwards. The old deployment RPC continues
to refuse journal v3 and is not retargeted as a deploy authority.

Sources: [Coolify Docker Image](https://coolify.io/docs/applications/deployments/docker-image),
[Docker digest pulls](https://docs.docker.com/reference/cli/docker/image/pull/).
Installed source inspection, rather than an assumption from those documents,
is the basis for the API compatibility decisions above.

## 1. Build once, publish, pull and qualify by digest

Use a clean detached deployment checkout at the exact source and a separate
clean controller checkout at the independently reviewed controller SHA. Verify
main and both `test`/`docker-build` SUCCESS on **both** exact commits. The new
controller repeats these admissions before mutation/queueing and checks its
own files against GitHub blobs at the controller commit. Public immutable file
bytes are downloaded from raw.githubusercontent.com at the exact40-character
commit and hashed as Git blobs. Mutable main and latest exact-head CI are still
fresh REST reads on every admission; no cache or credential export is used.
This avoids exhausting the anonymous REST quota on repeated immutable files.

Use an existing owner-approved private registry and authentication. Neither
registry visibility changes nor creation of credentials is part of this
procedure. Never put credentials in command arguments, runbook, Linear or CI.
If the approved registry/authentication is unavailable, HOLD.

Registry preparation was separately authorized for the three
`ghcr.io/artgurianov/flexperiment-{commerce,platform,admin}-v2` packages.
Owner PAT publication uses temporary Docker authentication and does not install
Coolify/server pull credentials or grant execution. Private visibility must
be independently read back; a public workflow's GITHUB_TOKEN inherits public
repository visibility. Registry setup is not a live admission record.

Exact source085 native identity contracts are service-specific:

| Resource role | Path | Exact native contract |
| --- | --- | --- |
| commerce-v2 | `/app/.identity/identity.json` | build-identity/1, service commerce-v2, sourceCommit target |
| platform-v2 | `/app/.identity/identity.json` | build-identity/1, service platform, sourceCommit target |
| admin-v2 | `/usr/share/nginx/html/release.json` | source_commit target, admin_contract_version sales-availability-v1 |

The qualifier records the actual native JSON and derives a role only from the
complete exact contract. It does not add a synthetic identity file to Admin or
change the target image/source. Role, source, contract, digest, image ID and
RootFS drift all refuse. Native Admin/Platform cannot be used for Commerce
admission. This correction needs independent review of the new controller SHA;
the previous ec5fc435 review cannot authorize its live execution.

Example (variables contain public identities only):

```sh
docker buildx build --platform linux/amd64 --provenance=false \
  --build-arg SOURCE_COMMIT=08523bdf38eeddf5e745ce04d05e1f980a7ced93 \
  -f Dockerfile.commerce-v2 --tag "$ART337_REGISTRY_REPOSITORY:$ART337_BUILD_NAME" \
  --push "$ART337_DEPLOYMENT_CHECKOUT"
```

Resolve the registry's **single-platform manifest digest**. An OCI index,
`latest`, a mutable tag or a source SHA cannot be consumed as admission.
After publishing, use only `repository@sha256:<manifest digest>`.

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation artifact --reference "$ART337_DIGEST_REFERENCE" \
  > "$ART337_PRIVATE_DIRECTORY/artifact-descriptor.json"
chmod 600 "$ART337_PRIVATE_DIRECTORY/artifact-descriptor.json"
```

This performs a digest pull and checks exact registry manifest bytes, its
config and compressed-layer descriptors, Docker image ID, uncompressed
RootFS layer list, linux/amd64 and baked service/source. Qualify **this pulled
artifact**, not a prior locally rebuilt image. Preserve a Docker/OCI archive
and its SHA-256 outside Coolify cleanup; verify a second independent digest
pull/read-back before proceeding. No generic tag is an identity guarantee.

## 2. New stopped resource, isolation and fresh proofs

After execution GO only, stage reviewed controller files privately without
replacing the archived original owner-rpc. Keep their exact Git blob identity.
Preserve the original owner config and controller/source checkouts separately.

### 2a. Reconcile the known resource and isolate Commerce timers

Installed4.4.6 Docker Image creation removes the supplied auto-deploy field
from the application request and omits its settings-model assignment. The
captured migration default is **true**. The captured PATCH path persists
false. The PHP fixture now executes the literal creation/default/cleanup/PATCH
code; it does not invent a false GET. The known resource must initially have
true auto-deploy, false previews, no container/env/mounts/domains/mapped ports.
All create evidence hashes, UUID, topology and qualified digest must match.
Any other deviation HOLDs before the settings PATCH.

After independent review and **new owner execution GO** only:

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation reconcile-existing-resource --controller "$ART337_CONTROLLER_SHA"
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation isolate-timers --controller "$ART337_CONTROLLER_SHA"
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation repair-resource --controller "$ART337_CONTROLLER_SHA"
```

Reconciliation is read-only and grants no deployment admission. The settings
repair has a **separate** fsynced intent, one PATCH (auto-deploy/previews/instant
false) and independent GET before outcome. The readback repeats stopped/empty/
UUID/topology/digest/queue/journal/current snapshots/remote ledger checks.
Lost acknowledgements preserve evidence and never authorize an inferred retry.
Use `reconcile --name commerce-resource-settings-repair` for diagnostics;
it always returns HOLD, including when current settings appear false.

| Timer | Triggered service | Installed effect |
| --- | --- | --- |
| `flexperiment-commerce-v2-backup@canary.timer` | `flexperiment-commerce-v2-backup@canary.service` | status/lock writes, readonly snapshot, encrypted archive and remote transport/retention |
| `commerce-canary-backup-freshness.timer` | `commerce-canary-backup-freshness.service` | canary lock/status freshness check |

The installed helper writes status even before a failed backup attempt. Zero
merchant writers alone does not establish isolation. Their two existing canary
alert handlers are also checked for running/queued work; the controller does
not invoke or resend alerts. Shared unit files/helper and production instances
are not modified. The timer module pins all four fragment hashes, the canary
backup alert drop-in, installed helper hash, root ExecStart arguments, trigger
relationships, no extra drop-ins, and no unknown scoped units. It checks pending
jobs, PIDs/cgroups, orphan helper processes and alert jobs. An inactive timer
may be garbage-collected between systemd show calls; its empty dynamic reverse
edge is accepted only while that exact timer is disabled/inactive and its
hashed fragment still binds the service. Unknown or active missing edges HOLD.

Isolation is one recorded operation: disable/stop **only these two timers**,
repeat census, stop drained services, reset historical failed service states,
independently require disabled/inactive timers and inactive/no-job services.
An active or racing backup is HOLD; never kill it after possible remote side
effects. Partial command/fsync outcomes retain intent and block replay.

Save fresh read-only `--operation inspect-timers` output as private0600 evidence
for the manifest. It binds the completed isolation outcome hash and current
states. This permits later fresh preflight without replaying isolation or
rewriting its timestamp. Publish/deploy repeat actual isolation inside the DB
write barrier and immediately before queueing.

### 2b. Configure only after successful settings repair

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation configure --controller "$ART337_CONTROLLER_SHA"
```

Configuration copies only qualified runtime inputs and the seven existing
bindings, with separate fsynced intents/outcomes for every API write. Completed
settings repair and current false flags are mandatory. Topology/settings/timer/
queue checks repeat around every env/storage write; drift stops remaining
provisioning. No preview credentials are created and no secrets enter reports.
An uncertain PATCH/configure/isolation stops; never replay create, reset a
receipt, delete the partially created resource or blindly continue.

Repeat full fresh ART-329 online snapshots with WAL. For Commerce the approved
nonzero counts are unchanged except `schema_migrations=26`; Payload unchanged.
Compare inode/device/path and snapshot SHA to actual live DB under exclusive
control. No current users/orders/content/uploads or unidentified rows. The
classified single synthetic playback event is preserved. Fresh snapshot hashes
must also equal the independently recovered post-stop hashes (`38071e…` for
Commerce, `716826…` for Payload), not merely their counts. A replaced event or
changed seed at the same row count is HOLD; no widening/reclassification occurs
inside this controller.

Create new encrypted backups and independently remotely read back/decrypt
both; reverify the whole old chain, including post-stop schema-0026 archives.
Recover copied current26 SQLite from this ciphertext, not just a local main
file. Read newest ledger using the independent read-only provider identity.
Keep its copies separate from merchant/fence directories and preserve RO
permissions, installation binding and full sequence/head agreement.

Run `art337-proof-continue.mjs` in the digest-qualified target image with:

- `/proof/current26.sqlite`: pristine recovered current snapshot (not mutated).
- `/proof/merchant/current26.sqlite` and `boot26.sqlite`: exact private copies.
- `/proof/merchant/synthetic26.sqlite`: isolated erased-test-person fixture,
  already schema 0026; preserve its input hash separately.
- `/proof/artifact.json`: the exact qualified descriptor.
- `/proof/mirror/bundle.json`: independent current signed bundle.
- `/proof/fence`: copied, drained CLOSED fence; never live fence.
- Separate RO-mounted `/etc/flexperiment-erasure-keys` and
  `/etc/flexperiment-erasure-read` with the installed binding.

No live merchant/fence path may be mounted in the qualification container.
The proof verifies the fingerprint and count 26 **before and after** restore
and normal `prepareErasureRuntime`, including suppression of the erased test
person and refusal of unknown remote/lease states. It never runs a 0025→0026
migration on the installed DB. Save its restore/boot JSON output, actual
artifact hash, input snapshot hash, sequence, mirror hash and script hash.

## 3. Sealed continuation manifest and journal v3

Fresh private reports: `inventory`, `backup`, `restore`, `boot`, `artifact`,
`isolation`, `delivery`, `timers`. Every report is root-owned 0600, hash-bound and at most
one hour old. Inventory uses its `generated_at_utc`; others use `recordedAt`.
`artifact` wraps `artifact-descriptor.json` as `artifact` plus `recordedAt`.
`timers` binds the completed isolation outcome hash and a fresh read-only unit/
job/process snapshot. `isolation` must contain `commerceTimers=ISOLATED` and
`timerIsolationSha256` matching that report. Preserve/read back all parent
archives as well as the full previous chain and schema26 post-stop archives.

Manifest fields are version 3, scope canary, deployment `sourceCommit`, exact
`parentJournalSha256`, schema-0026 `schemaFingerprint`, installationId,
readerBindingSha256, **new** applicationUuid, separate controllerCommit,
current ledgerSequence/mirrorSha256 and `files` with absolute paths/hashes.
Each backup archive also binds `independentPlaintextSha256` to the fresh
source snapshot after independent remote ciphertext retrieval and decryption.
The old-chain set must include all parent-chain objects and the two exact
post-stop schema26 archives. See `validate()` for the exact report contracts; no unbound PASS flag is a
substitute for a missing input. Delivery report binds the new resource,
reference, secret-preserving runtime environment hash, storage API hash and
original volume name→path/device/inode. It must include independently checked
mount/namespace/backup compatibility PASS.

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation validate --manifest "$ART337_CONTINUATION_MANIFEST"
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation publish --manifest "$ART337_CONTINUATION_MANIFEST"
```

`publish` holds BEGIN IMMEDIATE through final online snapshot comparison,
v2/history/remote/fence/image verification, parent archival, new evidence
archival, atomic rename, directory fsync and read-back. New v3 references the
exact archived v2 parent; it does not overwrite the v2 historical imageId.
A partial intent/history/pending/publication requires HOLD and read-only
reconciliation. No cleanup or automatic retry.

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation inspect-publication
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation reconcile --name commerce-deploy
```

These deliberately return HOLD even when bytes appear published. They work
without treating expired proofs as fresh, and never authorize another call.

## 4. Queue once, independently observe, then adopt backup lookup

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation deploy --manifest "$ART337_CONTINUATION_MANIFEST"
```

The operation repeats exact source/controller admission, current ledger/fence,
zero queues/writers, schema26, both snapshots and private resource bindings.
A DB reservation remains held until the one deployment queue call returns and
its outcome is fsynced. `QUEUED_NOT_PASS` is not successful installation.
Wait by GET for the recorded deployment UUID; do not queue another deployment.
If API/SSH outcome is ambiguous, preserve intent/outcome and HOLD. If an
unexpected runtime starts, bounded `--operation stop` requests only the
recorded new resource; independently verify stopped/exclusive afterwards.
No rollback, schema downgrade or automatic second start.

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation observe --manifest "$ART337_CONTINUATION_MANIFEST"
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation adopt --manifest "$ART337_CONTINUATION_MANIFEST"
```

Observe verifies installed digest reference, image ID, RootFS/platform, baked
identity/mode, default process/user, exact seven binds/network alias and normal
Commerce readiness (payments disabled, erasure qualified, Refref/mail/captcha
capabilities). Adoption first repeats observe and the unchanged scheduled
backup inspector against the proposed config, archives old config and changes
only the canary lookup. Pending/unknown config publication is never retried.

### Qualified restoration of regular backups

Timers remain disabled through deployment and lookup adoption. Start the real
existing backup service **once**, after observe and verified adoption:

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation run-canary-backup --manifest "$ART337_CONTINUATION_MANIFEST"
```

The fsynced service-start outcome requires a **new** SUCCESS status from this
attempt, source085 and exact current ciphertext filename/hash/size. Neither an
old status nor successful service exit alone passes. The service timeout is
15min; the controller wait is bounded at930sec, with no implicit short retry.
Independently GET/decrypt this remote archive off VPS with the owner-held key,
then restore and boot a copied fence through the same qualified digest and
`art337-proof-continue.mjs`. Private keys never enter VPS or images.

The private0600 proof report has `version=1`, `scope=canary`, `sourceCommit`,
exact `applicationUuid`, fresh `recordedAt`, `backupStatusSha256`,
`archiveFilename`, `archiveSha256`, exact canary `remoteObject`, `remoteSha256`,
`independentPlaintextSha256`, and full fresh `restore`/`boot` reports from the
reviewed script. Those bind artifact, recovered plaintext input, schema26
before/after, integrity/FK, erased test-subject suppression and current ledger/
mirror/copied OPEN/no leases. The controller independently GETs remote SHA again.

```sh
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation restore-timers --manifest "$ART337_CONTINUATION_MANIFEST" \
  --backup-proof "$ART337_POST_CUTOVER_RECOVERY"
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation rearm-canary-backup --manifest "$ART337_CONTINUATION_MANIFEST"
# Independently recover the resulting latest archive and renew this proof.
python3 -B "$ART337_CONTROLLER/scripts/v2/art337_immutable_recovery.py" \
  --operation verify-restored-timers --manifest "$ART337_CONTINUATION_MANIFEST" \
  --backup-proof "$ART337_POST_CUTOVER_RECOVERY"
```

Restoration is a distinct fsynced one-shot: repeat recovery/readiness/lookup/
isolation, require a successful freshness-service run, enable/start only the
two timers. `ACTIVATION_RETURNED_REQUIRES_READBACK` is not completion. OnBootSec
may immediately trigger a legitimate automatic backup. A completed oneshot
service can also be garbage-collected while its timer is disabled: this can
leave an enabled timer `elapsed` without a recurring deadline. After activation
and readonly draining, `rearm-canary-backup` is a **separate fsynced one-shot**
start of the qualified backup service with the timer retaining its relationship.
It produces a second new archive; independently recover it. This is neither a
retry of the first known successful backup nor a retry of uncertain activation.
The read-only verifier
refuses pending/running jobs: observe completion without repeating activation.
If the latest archive changed, independently recover that archive and supply a
report bound to current status. Final timer readback requires enabled/active/
waiting, drained successful backup/freshness services and latest archive proof.
Its result remains `...NOT_HARD_CUT_PASS`; all remaining live gates still apply.
Uncertain backup/activation or failed recovery HOLDs; no receipt cleanup/retry.

## 5. Remaining hard-cut gates

Commerce recovery alone is **not** ART-337_CANARY_HARD_CUT_PASS. Platform and
Admin must also be digest-qualified and independently checked using the same
artifact descriptor contract. The remaining original hard-cut gates (Payload
mount/environment retirement without archive deletion, Platform/Admin
readiness/identity, schema26, live OPEN fence and remote ledger, ten legacy
routes 404 with valid service token, Control Room, backup/recovery and all
four external 403 guards) remain required. New resource namespace and backup
lookup adoption are part of the **new** owner execution scope, not the expired
old GO. No production/V1/Refref/DNS/provider/F9 changes.

After new authoritative publication, stale Commerce restore is prohibited;
forward-fix only. ART-336 / ART-36 / protected browser E2E are separate gates.

## Engineering evidence boundary

`test_art337_immutable_recovery.py` exercises schema26/parent/replay refusal,
unknown writes, rename/fsync faults, registry descriptor drift, release gates
and canary-only creation. Python 3.10 runs are wired into CI. The real local
registry test builds source085 separately, pushes once and routes the actual
controller create request through captured installed 4.4.6 PHP API/job code.
It executes the captured database defaults and settings PATCH, then writes that job's Compose image field and executes its captured Compose
pull/up commands before independently comparing the running image/rootfs/
platform/identity. Request persistence, non-image infrastructure and the inert
Node process are fixtures; this is not a full HTTP Coolify server deployment. It executes schema
restore/remote-reader contracts in that same image with synthetic fixtures.
This proves isolated artifact transport and runtime compatibility, **not** a
real Coolify installation or fresh live remote-ledger recovery. Those require
the future execution preflight and independent live read-backs above.
