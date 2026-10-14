# ART-337 closed canary fast cut

Owner amendment in ART337 supersedes PR222 mutation choreography. Preserve
that PR, old journals/resources/receipts/archives; never replay unknown env
POST or claim a historical operation succeeded. This is temporary direct
Compose canary operation; production/V1/Refref/DNS/provider/F9 stay closed.

## One pre-cut control

Recheck no real/unknown data or writers, old apps stopped/auto-deploy off,
old canary backup/freshness timers isolated, schema26/current online snapshot
hashes and independent remote ledger/drained fence. Current input must match
the retained off-host restored snapshots; otherwise classify before reuse.
Keep all original SQLite, ciphertext, recovery keys and REQUIRED erasure
installation. Choose schema26 reuse (no reset/import/backfill here).

Use the three previously VPS-qualified private GHCR digest descriptors.
Fresh pull/readback must match registry manifest/config, native image ID,
RootFS and native source085 identity. A new infrastructure commit never
becomes the deployment source. Root Docker auth stays private and outside apps.

## Private configuration and start

Install this checkout under `/opt/flexperiment-fast-cut-canary`, root-owned.
Generate only new private inputs, without writing to old Coolify records:

```sh
python3 -B /opt/flexperiment-fast-cut-canary/scripts/v2/fast-cut.py prepare
```

`/etc/flexperiment-fast-cut-canary` is root0700; env/password/artifact files
root0600. Input generation uses GET only. Raw Compose env preserves dollars,
quotes and Unicode. New canary-only admin password is in `admin-password`;
original hash/provider/erasure inputs are preserved unchanged. Never print
`docker compose config`, inspect Env, raw HTTP cookies or private responses.
Place the three qualified descriptors as `{commerce,platform,admin}-artifact.json`.

```sh
docker compose -f /opt/flexperiment-fast-cut-canary/deploy/v2/fast-cut/compose.json config --quiet
docker compose -f /opt/flexperiment-fast-cut-canary/deploy/v2/fast-cut/compose.json up -d --wait --wait-timeout 180
python3 -B /opt/flexperiment-fast-cut-canary/scripts/v2/fast-cut.py check
```

No build, host port, production/Coolify network, Payload mount or Docker
credential mount. Commerce preserves both volumes and five erasure bindings;
normal boot verifies/replays remote ledger before readiness. Private bridge
allows required outbound ledger access. Native Admin gets readonly canary
nginx config; static native release identity remains independently verified.
Original Commerce alias exists only on this isolated network. Park old partial
resource with previews/auto-deploy off. Stop old canary Admin only after verifying
its exact canary identity. Do not change public ingress to this stack.

## One post-cut acceptance

Check actual three image IDs/RootFS/native identities and runtime readiness,
schema26/integrity/FK, REQUIRED erasure admission with remote verified current
ledger, OPEN/drained fence; run the ten retired routes with real service token
(404). Internal smoke uses normal admin login/read/logout through canary nginx,
private cookie/password in memory only. Capture outcomes, not credentials.
Four external hosts must still return403. No customer/course publication or
Kinescope E2E is required here.

```sh
python3 -B /opt/flexperiment-fast-cut-canary/scripts/v2/fast-cut.py backup
```

Native backup CLI reads SQLite only. Host ciphertext is normalized to root0600
before pinned rclone transport, unique namespace and SHA readback. Independent
GET/decrypt off-host then restore and normal copied-fence boot in the published
Commerce image is the acceptance proof; no private age key enters VPS/image.
Unknown PUT is never retried; retain its ciphertext for GET reconciliation.
No retention/deletion is performed by this temporary backup helper.

Install the four files in `deploy/v2/fast-cut` as systemd
`flexperiment-fast-cut-canary-{backup,freshness}.{service,timer}`. New backup
service points only at this stack; old timers/owner lookup remain archived and
disabled. Run services after the successful manual backup, enable timers and
independently require enabled/active/waiting with future realtime deadlines.
Calendar recurrence avoids unloaded-service OnUnitActiveSec ambiguity. Backup
freshness refuses failed, changed, future or >8h status. Failed scheduled runs
are visible in systemd journal; this interim path does not repurpose old alerts.

Return one `ART-337_FAST_CUT_PASS` packet including actual host readbacks,
backup/restoration and recurrence. Local/CI success alone is not live PASS.
Otherwise report specific `ART-337_FAST_CUT_HOLD`; resolve reversible local
configuration errors without escalating every API request. Never bypass erasure,
immutable source, unknown real data or public guards. ART338/DRM/F9 stay separate.
