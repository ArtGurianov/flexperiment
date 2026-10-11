# Platform V2 canary — private execution plan

Version 1, 2026-10-11. Existing issues: ART-165, ART-166, ART-179, ART-41.

Deployment source: `b0ba13a3f58e5649afcc771da385959b14a06539` (PR #192 squash merge).
Approved head: `9c054bfb7a13debc2d3cdce376264f3ecc5ea055`.
Identical tree: `eb2ff67b53de0498eee50a32c11ad60c026498cf`.
[Exact merge-SHA CI](https://github.com/ArtGurianov/flexperiment/actions/runs/38108535612):
`test` and `docker-build` SUCCESS. This local documentation commit is not a new
deployment source, execution GO, or proof of live Platform readiness.

## Decision and authority

Use one isolated Next.js/Payload Platform app and the existing Coolify control
plane. Production-app reuse breaks isolation; a second gateway or adaptation of
the Commerce/V1 controller adds unnecessary machinery. No new release workflow.

Current authority covers merge, CI verification, read-only inventory and this
plan only. No Platform app, secret, volume, deployment or routing mutation has
been performed. A future reviewed single GO may cover the ordered private cycle
below: creation → runtime-only custody and new volumes → initial schema migration
and private deployment → independent editorial recovery and persistence proof.
No extra routine approval between those steps; STOP on error, ambiguity or drift.
An app-creation-only GO does not authorize the later steps.

Registration, authoring, legal releases, offers, payments and public ingress stay
CLOSED. No production promotion, V1/Refref changes, provider operations, real
emails, public routing or F9 cutover. Preserve existing LAB/admin/Commerce,
volumes, backup timers and all four HTTPS 403 guards. Historical Commerce
`STOP_AFTER_FINISHED` remains UNKNOWN; accepted independent API-only evidence
does not retroactively make that controller successful.

## Read-only baseline observed during this preparation

- No Platform-named Coolify application exists. Before POST recheck the proposed
  name and repository/Dockerfile; do not adopt an unrelated app.
- Project `wclu2wovf4ctpbgam3h7grzb`; environment `canary-v2`, UUID
  `mvbfdgijw9rhza2qfcwjzwuj`, numeric ID 6.
- Server `1460ru9bxuxzrqnswauxqxhc`; destination `5gwzwaau6dfwx3xrqgahstzi`,
  standalone Docker destination/network `coolify`, confirmed through existing
  LAB's destination relation. The server-detail DTO's absent destination list
  is not proof of zero destinations.
- GET `/github-apps`: GitHub App ID 5, UUID `7fh7m5ngea7lywcq5tuvenkj`,
  name `flexperiment`. Installed controller confirms POST
  `/applications/private-github-app`, requiring `github_app_uuid`; include
  `destination_uuid` explicitly.
- Commerce canary `xzuy7pk5y6ywjr9kh6nsk5ap`, LAB
  `ch8gumpvpriflqsct7clqafr`, admin `v2w4tnlkkt8pj2fnfspyn5l5` and isolated
  Commerce production `gzngatkipv7dv3rkpuaigjg5` are healthy.
- Commerce canary container `xzuy7pk5y6ywjr9kh6nsk5ap-20261010T152433` remains
  present. Accepted Commerce SHA: `47eecb65a2a60e4c710b5c6b0b8e55130727fbc0`;
  revalidate actual identity and DNS from the new Platform network before use.
- Both Commerce backup timers ACTIVE; freshness checks FRESH.
- All four canary HTTPS origins return 403 with TLS verification enabled.
  `/data/coolify/proxy/dynamic/flex-v2-canary-closed.yaml` SHA256 remains
  `2af21f0754922986de39a1bca7a272ca606e13fdd5a53c41c2afbd33ce8d0653`.

These are observations, not Platform deployment, custody or recovery proof.

## 1. Preflight and one private app creation — after future GO

Re-read exact source CI, app absence, control IDs, deployment queue, protected
baselines and upstream identity/DNS. Do not silently substitute a newer main SHA.
Use the existing root-owned 0600 Coolify credential at
`/root/flexperiment-v2-owner/coolify-api.token` inside its approved VPS environment;
never print or export it. Recheck the installed contract if Coolify has changed.

Proposed nonsecret POST `/applications/private-github-app` body:

```json
{
  "name": "flexperiment-platform-v2-canary",
  "project_uuid": "wclu2wovf4ctpbgam3h7grzb",
  "environment_uuid": "mvbfdgijw9rhza2qfcwjzwuj",
  "server_uuid": "1460ru9bxuxzrqnswauxqxhc",
  "destination_uuid": "5gwzwaau6dfwx3xrqgahstzi",
  "github_app_uuid": "7fh7m5ngea7lywcq5tuvenkj",
  "git_repository": "ArtGurianov/flexperiment",
  "git_branch": "main",
  "git_commit_sha": "b0ba13a3f58e5649afcc771da385959b14a06539",
  "build_pack": "dockerfile",
  "dockerfile_location": "/Dockerfile.platform",
  "base_directory": "/",
  "ports_exposes": "3001",
  "domains": null,
  "autogenerate_domain": false,
  "instant_deploy": false,
  "is_auto_deploy_enabled": false,
  "is_preview_deployments_enabled": false,
  "health_check_enabled": true,
  "health_check_path": "/readyz",
  "health_check_port": "3001"
}
```

POST once; record only UUID and safe status/error category. Independently GET the
new app and queue: exact source/Dockerfile/destination, no FQDN or host-port
mapping, no custom labels/run/start/pre/post command override, auto/preview deploy
OFF, no queued job. Uncertain POST means STOP and GET-only reconciliation,
never blind retry. Secrets are not prerequisites for an empty app, but are
mandatory before any deployment.

## 2. Private custody, configuration and editorial volumes

Verify independent PAYLOAD_SECRET and protected owner/offline escrow. Under
future explicit custody authority only, generate 32 cryptographically random
bytes if no canonical secret exists; do not rotate existing credentials. Privately
verify the existing canary PLATFORM_COMMERCE_SERVICE_TOKEN and its escrow.
Do not copy production/provider/NotiSend/CAPTCHA credentials into Payload.

Verify an owner-approved age public recipient and corresponding private-key
recovery on the owner Mac in Russia. Only the public recipient enters Platform.
Actual Platform secret/escrow/key sources remain pending; no filepath is invented.

Build variables: SOURCE_COMMIT = exact deployment SHA; PLATFORM_ORIGIN =
`https://canary-platform.flexperiment.ru`. No runtime secrets during build.

Runtime configuration:

- PLATFORM_V2_CANARY=true; PAYLOAD_JOBS_ENABLED=false; DEPLOY_ENV=staging.
- PAYMENT_MODE=disabled; MARKETING_BROADCASTS_ENABLED=false.
- PLATFORM_ORIGIN=https://canary-platform.flexperiment.ru.
- LAB_ORIGIN=https://canary-lab.flexperiment.ru.
- ADMIN_ORIGIN=https://canary-admin.flexperiment.ru.
- API_ORIGIN=https://canary-api.flexperiment.ru.
- COMMERCE_INTERNAL_ORIGIN=http://<verified canary hostname>:3002.
- PLATFORM_EXPECTED_COMMERCE_SHA=<independently verified accepted canary SHA>.
- PAYLOAD_DATABASE_URL=file:/var/lib/flexperiment-platform-canary/platform.sqlite.
- BUILD_IDENTITY_FILE=/app/.identity/identity.json; NODE_ENV=production; PORT=3001.
- PAYLOAD_SECRET and PLATFORM_COMMERCE_SERVICE_TOKEN: runtime-only, no build/preview.
- PLATFORM_BACKUP_AGE_RECIPIENT=<verified public recipient>, runtime-only.
- No S3_BUCKET/S3 credential, provider, Kinescope, IndexNow or email credential;
  no additional revalidation credential. The existing service-token fallback
  for internal revalidation is authority, not a read-only guarantee.

Allocate TWO new Platform-only named volumes after checking names are absent:
proposed `flexperiment-platform-v2-canary-editorial` and
`flexperiment-platform-v2-canary-backups`, mounted at
`/var/lib/flexperiment-platform-canary` and
`/var/lib/flexperiment-platform-canary-backups`. Refuse overlap/reuse with any
Commerce, production or V1 mount. Require node ownership, directories 0700,
SQLite/WAL/SHM/ciphertext 0600, startup umask 077. Never recursively chmod/chown
an existing or broad directory.

age encrypts snapshots/escrow, not live SQLite. Do not claim live volume at-rest
encryption from age; verify any host disk-encryption requirement separately
before admitting real personal/editorial data.

## 3. Private deployment and runtime qualification

Re-read staged source/build/env/storage before queueing. Use the installed
Coolify POST `/deploy?uuid=<new-app-uuid>&force=false` with the existing owner
mechanism; record and wait for that exact deployment UUID. Do not repurpose the
Commerce two-app controller or deploy any existing app. Initial Payload migrations
write only the NEW editorial schema/system state; no unapproved course/legal/
author seed, and no reset of any existing database.

Require baked `/identity` service=platform and exact merge SHA, matching image and
immutable descriptor. `/readyz` must pass actual Payload transaction checks and
real credential-free Commerce readiness. The transaction probe rolls back;
initial schema/system writes are not a zero-SQLite-write claim.

Verify privately:

- No public domain/host port/auto deploy; all four guards still 403.
- Actual canary-only upstream DNS/identity, without guessing a stable alias.
- `/v1/me` unauthenticated refusal with exact Platform Host; foreign Host/Origin
  and forbidden legacy/partner/internal proxy paths refuse.
- Forwarded HTTPS, no-store, manual redirects, no unexpected provider/production
  calls. This is not real browser-cookie or magic-link qualification.
- Established disabled-checkout probe refuses; verify no nonfinancial Commerce
  state change. Do not initiate registration, consent, login or payment here.
- Author creation, editorial mutations and custom mutation endpoints refuse.
  Do not create an author/session solely to test privileged routes.
- Observe across an actual five-minute boundary: no new scheduled job/execution;
  retain the admitted real Payload/Croner regression and negative control.

Manual Local API queue/run/handleSchedules, owner publish commands and authenticated
internal revalidation are forbidden in this phase. Injected jobs/search collections
are not covered by a universal collection firewall. Authenticated GET video-upload
status can poll a provider and mutate Commerce; test unauthenticated refusal only.
Keep editorial users empty. Privileged custom side effects require later admission.

Before separately authorized networking work, do not restart Commerce to invent an alias. After every future Commerce replacement,
revalidate LAB/admin/Platform DNS, upstream identity and readiness before admission.

## 4. Actual editorial snapshot, independent recovery and persistence

Record actual schema/migration journal, relevant counts and canonical content
hashes privately; no raw editorial/auth secrets in evidence. Use the admitted
image's existing exporter:

```text
python3 /app/scripts/v2/platform-backup.py
```

It performs read-only online SQLite backup with committed WAL, editorial schema
checks, age encryption and fsync. Record safe archive name/size/SHA256 and exact
source identity. Keep source database and both volumes intact.

Use approved host-side Cloud.ru transport/credentials, not the Commerce scheduler
unchanged. Upload to the separate `flexperiment/platform-v2/canary` namespace.
Independently download the exact object on the owner Mac, verify size/SHA256
before decrypting, then restore into isolated private storage in Russia, with
no bank connectivity/provider credentials.

Compare SQLite integrity, full schema, actual migration journal and canonical
source/restore contents, and absence of Commerce tables. Six migrations/empty
editorial state are engineering expectations, not substitutes for the live journal.
Verify recovery of retained key generations/secret escrow without revealing values.
No artificial source rows to manufacture proof.

After a valid snapshot, restart/redeploy only THIS Platform app at the same SHA
once, retaining both volume identities. Independently compare lineage, migrations,
relevant facts and readiness; no content marker needed.

The exporter is NOT a host scheduler/remote uploader. Platform regular backups,
7 local/100 remote retention, six-hour cadence, <=8h freshness and independently
delivered alerts remain concrete gaps before public/editorial admission. Do not
install an unreviewed scheduler or call Commerce timers Platform coverage.
Commerce timers must remain ACTIVE/FRESH.

## STOP and report

STOP on control/SSH ambiguity, source/image/config drift, missing escrow/key,
wrong/shared storage, unsafe permissions, upstream mismatch, public exposure,
guard/protected-service drift, failed persistence/upload/hash/decryption/restore.
No automatic rollback, database reset, volume deletion, credential rotation or
protected-app changes. Preserve private resources, ciphertext and the journal
for reconciliation; never blindly repeat a creation/deployment mutation.

Return one report: application/deployment UUIDs, source/image SHA, private identity/
readiness, volume lineage, zero automatic jobs, guarded routes, remote object hash
and independent restore comparisons. Report Platform scheduler/alerts and real
auth/legal/catalog qualification separately. Update only ART-165/166/179/41;
no duplicate issues or premature closure.

Current milestone: `PLATFORM_CANARY_APP_CREATION_READY` — plan/request ready,
not execution authority. Later distinguish app-created, private-runtime PASS and
editorial-recovery PASS. None implies public registration, authoring, magic-link
E2E, sales activation or F9 readiness.

## Version 2 — risk-based canary execution, 2026-10-11

The owner now authorizes autonomous canary diagnosis/fixes/green-CI merges,
private deployments/restarts, non-destructive migrations, backups/restores and
canary networking. Earlier future-GO statements above are historical checkpoints,
not new prerequisites. Production, V1, Refref, public guards, real money, legal
approval and business catalogue facts stay outside this authority.

### Executed and independently verified

- Metadata drift resolved by exactly reproducing the original app fingerprint
  with only common `updated_at` changed; the old container fingerprint matched
  once a transient backup client exited. Original baselines retained.
- Platform app `ks8c2wmlle1kvdfuwbiwthe1`, deployment
  `llb5uwiyc3b9ut4iakcdiya8`, FINISHED on approved `b0ba13a…`; actual image
  `sha256:5a36aa667c0ffcdcb65756f520376fa34b05b9ab72ce919426d41c53b2928369`.
  Identity/readiness PASS; 12/12 live private HTTP/security checks; 6 Payload
  migrations, WAL, zero users/content/jobs. Full table hashes unchanged across
  361 seconds including a cron boundary. This observes automatic inactivity;
  it is not authorization to invoke manual Local API jobs.
- Encrypted live editorial snapshot: 676200 bytes, ciphertext SHA256
  `352ecb154d6a7e7deaa894b2626964976cad1df6f96d00ef93aefb07ba3de6ed`.
  Cloud.ru isolated `art-backups/flexperiment/platform-v2/canary` read-back and
  independent object download/restore on owner Mac in Russia PASS: all 22 tables,
  all 6 migration records and schema SHA256
  `939b014e3d7c5bf5cc74b5c55e4afc20b7043d747b845524593ec3e61ad10f4e`
  match. Private recovery identity remains off-VPS.
- One Platform restart: caller timeout was shorter than Docker's graceful stop;
  independent `StartedAt=2026-10-11T04:37:05.492101103Z`, unchanged image/mounts,
  readiness and full DB read-back established the completed action, without retry.
- Canary-only native Coolify `custom_network_aliases`: bare Commerce UUID plus
  `xzuy7pk5y6ywjr9kh6nsk5ap-20261010T152433` as persistent compatibility alias.
  Coolify setter stores a JSON array but API getter returns comma-separated text;
  the initial read-back parser failure was reconciled without repeating PATCH.
  Deployment `mk1ito3hxqigjkgpghxwljpd` replaced the container with
  `xzuy7pk5y6ywjr9kh6nsk5ap-20261011T043958`, same source `47eecb65…`, same image,
  all 46 table hashes and volumes. Both aliases belong only to the replacement;
  IPv4/IPv6 DNS resolves to its network addresses. LAB/Admin/Platform readiness
  recovered through existing dynamic DNS. No client credentials/env changed.
  New clients should use the bare UUID; existing clients no longer depend on the
  survival of the old container. Revalidate after every replacement nonetheless.
- Protected production/V1/Refref configurations, containers and guards unchanged.

### Bounded implementation decision

Adapting frozen V1 components would perpetuate retired tour/capability/notification
APIs; translating `/v1/public/*` inside the proxy would obscure incompatible
contracts. Instead build a separate `apps/lab-v2` entrypoint in the existing
canary-only LAB image. Legacy `apps/lab`, Dockerfile.frontend and F7 checkout core
remain unchanged. A typed `/v1/lab/catalogue` read model projects actual PUBLIC,
non-withdrawn, non-ended LAB offers without allowlists, personal data, guessed
capacity or availability. Authenticated history uses existing customer-owned
`/v1/me/orders`; confirmed Better Auth sign-out clears local account state.
No new checkout/payment/refund/ticket implementation or synthetic live data.
Registration remains closed; actual legal/CAPTCHA/email/browser session admission
is still required. Legacy notification/ticket/refund links fail closed rather than
silently calling V1. This is not a claim of complete commercial LAB qualification.

Use a separate Platform-only host scheduler/unit/namespace. Reuse the existing
pinned, hardened S3 transport without changing Commerce/production units. Stage
ciphertext into root-owned 0700/0600 storage because cap-drop=ALL intentionally
cannot traverse the app's 1000-owned private volume. Verify uploaded ciphertext
before retention, preserve the current proven object, retain 7 local/100 remote,
and record IN_PROGRESS/FAILED rather than letting old SUCCESS attest a new failed
attempt. Install only after exact-SHA CI and off-VPS recovery; six-hour timers and
8-hour freshness are not external alert delivery. Alerting remains PENDING until
an actual operator notification is delivered.

Tests cover V2 DTO isolation, closed/acceptance/withdrawn/ended offers, no read
writes, owned history/logout, malformed-contract refusal, actual browser bundle
absence of V1/production consumers, real nginx proxy and scheduler source/storage/
transport isolation. Exact-source CI is mandatory before merging/deploying the
new artifacts. Content and real auth workstreams remain blocked only by genuine
owner-approved legal/course prerequisites; do not manufacture those facts.
