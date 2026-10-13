# ART-337 · Canary erasure admission requalification

**State of this procedure: review candidate.** The live canary hard cut is HOLD.
No command in this document authorizes execution. Obtain independent review of
the exact PR head and a separate owner **GO TO EXECUTE** before stopping a
runtime, writing the admission journal, or starting a replacement image.

## Authority and fixed identity

This is a one-time, canary-only transition from predecessor source
`84b1a6abcb43e9abf8f781e830f84822207c0dca` to deployment source
`08523bdf38eeddf5e745ce04d05e1f980a7ced93`. The *controller* is the
reviewed commit containing `scripts/v2/art337_erasure_requalification.py` and
`scripts/v2/owner-rpc.py`; its SHA and file hashes are recorded separately.
Never substitute the controller SHA for the deployment source. Never use the
current tip of `main` as recovery authority. The protected installation ID is
`6982499b-1567-46e4-b9e7-ab54416d8b8d`; the reader binding digest is
`c41e2f717c83275cb4d4d5206b50b3994324c7f58f1c496126edee0b428a8490`.
The predecessor journal SHA-256 is
`eb60e0b11769e3f263c4e0e9bbb48fd8431f571ffba25a77fb0a37e8d7a352dc`.
Its original bytes must remain in root-only history. These constants are
intentional refusal points, not suggested values for other environments.

The 13 October isolated target proof used image
`sha256:58c732fc25990d9ee5bbe316b423e54c3f76446d2070c0c2b5277363c81e4116`.
It read the then-current remote ledger and passed synthetic schema 0025,
synthetic schema 0026, and current copied schema 0026 restores. It also opened
only a **copied** CLOSED fence by target `prepareErasureRuntime`. This is not a
live admission or a substitute for a fresh read and proof at execution time.
The live fence was CLOSED, sequence 1, zero leases; `/readyz` was 503.
Its original closure cause was not established.

## Required preflight before any mutation

1. Confirm the two exact canary application UUIDs from the root-only owner
   config, installed images, source identities, mounts, SQLite paths, timers,
   and absence of production overlap. Confirm predecessor journal bytes and
   protected installation/reader binding. A mismatch is HOLD.
2. Capture a fresh WAL-aware, read-only inventory of **both** SQLite databases.
   Independently classify every new or unknown row, active legacy operation,
   unfinished upload, user and order against ART-329. The prior owner decision
   for one synthetic `DRM_TOKEN_INVALID / PLAYBACK_TOKEN_MALFORMED` row does not
   classify future rows. Any unknown data or operation is HOLD.
3. Before stopping the installed runtime, obtain encrypted backups and
   independent remote read-backs of both SQLite databases and the previous
   backup chain. Confirm restore keys, ledger/fence custody and qualified
   recovery procedure. Preserve all archives. No reset, importer or backfill.
4. Rebuild and inspect the **exact target** image from the exact source archive;
   record immutable image ID and read its baked identity. Re-run restore proof
   against fresh copied schema 0025/0026 and the current merchant snapshot,
   plus copied-fence boot proof. Both schema fingerprints must be accepted:
   `158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030`
   (0025) and `c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39`
   (0026). A local Docker proof does not replace remote custody read-back.
5. Obtain a fresh `flexperiment-erasure read` result from the independent
   current remote authority. Compare sequence with the signed mirror and live
   fence head. Verify all runtime verification keys and reader permissions.
   Any stale packet, sequence divergence, unknown lease or owner is HOLD.

The reviewed proof entrypoints are
[`art337-proof-restores.mjs`](../../scripts/v2/art337-proof-restores.mjs) and
[`art337-proof-boot.mjs`](../../scripts/v2/art337-proof-boot.mjs). Run them
inside the exact target image with `node --import tsx`, mounting the proof
directory at `/proof` and the protected **read-only** runtime keys, reader,
mirror and copied installation marker at their expected `/etc` paths. The
proof directory contains separately copied `synthetic25.sqlite`,
`synthetic26.sqlite`, `current26.sqlite` and, for boot, a separate copy of the
merchant database plus CLOSED fence. Give UID 1000 access only to these
copies. Allow egress only to the configured remote read authority; do not
mount live merchant or fence directories. Capture sanitized JSON stdout to
root-only files. The `qualification` JSON joins the restore JSON, exact image
ID, source SHA, fresh Commerce snapshot SHA, SHA-256 of both reviewed proof
scripts (`proofScriptSha256` and `bootScriptSha256`) and the actual UTC
`recordedAt`;
its `result` must be the byte-equivalent parsed restore result. Never set
`recordedAt` after the proof ran merely to pass the freshness check.

The inventory report's generated `STOP_REVIEW_REQUIRED` is deliberate: table
counts cannot make the owner decision. Put the explicit classification and
its Linear evidence link in the sealed execution record. The manifest's
`ownerDecision` is the reviewer-approved classification, not a way to turn a
new unknown row into an automatic pass. The script also freezes every nonzero
table count to the 13 October approved scope: Commerce `cities=3`,
`deployment_durability=2`, `launch_seed=1`, `offers=1`,
`playback_access_events=1`, `products=1`, `schema_identity=1`,
`schema_migrations=25`; Payload `payload_migrations=6`; all other tables
must be empty. A new user, order, upload or any other nonzero table refuses
automatically. Manual inspection of the one telemetry event remains required
to prove its exact classification; counts alone never prove that.

## Recovery and journal transition after separate GO

The stopped-writer check is mandatory for every admission mutation. If the old
canary is still fenced CLOSED, first recover **the exact predecessor source**
under its existing admission: identify its old image and baked source, take
the backups above, stop it through the owner controller, wait for Coolify and
`exclusive-canary` to report no runtime/RW mount/writable SQLite FD, and use
the existing bounded owner `deploy` operation for that same old source. Its
normal startup must call `prepareErasureRuntime`, re-read the remote ledger,
apply erasures and open the fence; no manual `OPEN`, direct container restart,
new ledger or altered `recovery=PASS`. Verify the live fence, `/readyz`, remote
ledger and archives independently. If exact-source recovery cannot be proved,
HOLD. Then repeat the **full ART-337 preflight** before target admission.

The target admission step is a distinct operation. Stop the predecessor via
the bounded owner controller and require `exclusive-canary` again. Recheck
current ledger, mirror, fence sequence/head/owner/leases, target image and all
proof reports. An OPEN fence on a stopped and lease-free predecessor is allowed:
the script does not change fence state. The new target runtime alone will
perform `prepareErasureRuntime` and reopen after applying current erasures.

Prepare a root-owned `0600` JSON manifest with the exact fields below. Each
`files` entry is an absolute path to a root-owned `0600` JSON artifact plus its
independently calculated SHA-256. The inventory and `qualifiedAt` must be
within one hour of execution. Do not place credentials or customer values in
this manifest. Keep it and the archived artifacts outside the application
volumes and backups.

```json
{
  "version": 1,
  "scope": "canary",
  "sourceCommit": "08523bdf38eeddf5e745ce04d05e1f980a7ced93",
  "previousSourceCommit": "84b1a6abcb43e9abf8f781e830f84822207c0dca",
  "installationId": "6982499b-1567-46e4-b9e7-ab54416d8b8d",
  "readerBindingSha256": "c41e2f717c83275cb4d4d5206b50b3994324c7f58f1c496126edee0b428a8490",
  "ledgerSequence": 1,
  "mirrorSha256": "<fresh 64-character SHA-256>",
  "imageId": "sha256:<exact target image ID>",
  "schemaFingerprints": {
    "0025": "158654c61bd97be4dbcab4348651722fe105587f6ff202ad4db821512774e030",
    "0026": "c99f9ed0db449a2c13f2e51fa3b28a1ba44e367dd263185c99eddfec8c2d3b39"
  },
  "ownerDecision": "ZERO_REAL_DATA_CONFIRMED_WITH_CLASSIFIED_SYNTHETIC_EVENT",
  "qualifiedAt": "<current UTC ISO 8601 timestamp>",
  "files": {
    "inventory": {"path": "<absolute path>", "sha256": "<64 hex>"},
    "qualification": {"path": "<absolute path>", "sha256": "<64 hex>"},
    "restore": {"path": "<absolute path>", "sha256": "<64 hex>"},
    "boot": {"path": "<absolute path>", "sha256": "<64 hex>"}
  }
}
```

Run the reviewed script from a pinned, clean controller checkout, under the
privileged owner account. Record its SHA-256 and the controller commit in the
execution log. Do not print raw proof files, bundle, credentials or journal.

```sh
sudo -n python3 scripts/v2/art337_erasure_requalification.py --manifest /root/flexperiment-v2-owner/art337-execution-manifest.json
# Inspect the sanitized QUALIFICATION_READY output and independently verify all inputs.
# Only under the separate GO TO EXECUTE:
sudo -n python3 scripts/v2/art337_erasure_requalification.py --manifest /root/flexperiment-v2-owner/art337-execution-manifest.json --commit
```

`--commit` first writes the byte-identical predecessor journal into
`/root/flexperiment-v2-owner/erasure-admission-history/`, then archives the
four exact evidence files, then atomically publishes a version 2 journal.
Files and parent directories are fsynced, and the script reads back the
journal and every archived hash. It refuses drift, a foreign history file or
an abandoned pending file. If the result of a write is uncertain, inspect the
exact old/new journal hashes and history before retrying; do not delete a
pending record merely to make a retry pass. Never edit `sourceCommit` or
`recovery` in place.

The reviewed `owner-rpc.py` additionally verifies the v2 predecessor hash,
archived evidence hashes, exact schema fingerprints, mirror SHA and current
remote sequence on every target admission. This controller must be installed
and pinned separately from deployment source `08523bdf…`; an older pinned
controller can parse the compatibility fields but does not enforce the new
evidence chain. **HOLD target deployment until the reviewed controller is
active and the deployment path proves separate controller/source identities.**
Keep a clean source checkout at `08523bdf…` as the working directory and a
second, immutable controller checkout at the independently reviewed PR head.
Stage that controller's `owner-rpc.py` under the protected
`/root/flexperiment-v2-owner/controllers/08523bdf…/owner-rpc.py` path, then
read back its exact SHA-256. Invoke the reviewed controller's
`scripts/v2/deploy-cli.mjs` **from the source checkout** with
`V2_SOURCE_SHA=08523bdf…`, `V2_DEPLOYMENT_MODE=normal-canary`,
`V2_RPC_SHA256=<reviewed controller file hash>`, the existing owner SSH
transport inputs, and the repository/CI inputs required by that CLI. The CLI
validates the working checkout as target, while its imported code and pinned
RPC come from the reviewed controller. Record both full SHAs. A dry-run or
isolated controller test must first prove this split; the workflow that copies
RPC from its own source checkout cannot serve as that proof.

`admitRelease` also requires the exact target to remain current `main` with
successful exact-SHA CI. Merging this PR before the target cut would move
`main` and make the existing gate refuse. Keep this PR unmerged until the
reviewed procedure has executed, or revise the controller through another
independently reviewed exact-source recovery path. Never weaken the CI gate
or substitute a later `main` SHA. If either checkout, pinned RPC hash or
current-main condition differs, HOLD before target deployment.

## Stop conditions and postconditions

Any failure of current remote verification, image identity, either schema,
restore proof, inventory classification, backup read-back, installation
binding, erasure lease/owner, competitor census, archived evidence or
atomic read-back is **HOLD**. Do not clear the fence/journal or use an old
Commerce DB over a newer publication. Preserve all old archives.

After the reviewed controller admits target, the bounded canary deployment
must prove exact source/image digest, migrations, normal `prepareErasureRuntime`
startup, independent ledger, live fence `OPEN`, `/readyz` 200, all ten retired
routes 404, Control Room, backups and closed 403 guards. Then repeat the full
ART-337 preflight. Only those read-backs can support
`ART-337_CANARY_HARD_CUT_PASS`. Kinescope callback, protected browser E2E,
ART-336/ART-36 and production remain separate gates.
