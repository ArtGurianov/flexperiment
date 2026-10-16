# LAB V1 retirement — executed

Status: **LAB_V1_RETIRED / LEGACY_ROUTES_GONE**.
Final independent host read-back:16 October 2026, 19:52 Novosibirsk (UTC+7).

The owner explicitly authorized technical retirement and confirmed every V1
buyer/user is a test. No new charge/refund, order migration or public V2 launch
was authorized or performed. This supersedes the earlier compatibility
instruction to keep V1 confirmation routes running.

## Actual retired scope

The serving V1 source was `3ad07cfcb53e861fc481c44d806b91743eb239c6`.
The real public LAB was `flexperiment.ru`, with separate API and old Admin
hosts; it was not a serving LAB at `lab.flexperiment.ru`.

| Coolify application | Processes stopped | Final control-plane status |
| --- | --- | --- |
| `flexperiment-lab` | V1 static frontend | `exited:unhealthy` |
| `commerce` | V1 HTTP service and background worker | `exited:unhealthy` |
| `admin-web` | V1 Admin | `exited:unhealthy` |

The `unhealthy` suffix describes stopped resources, not a claimed healthy V1
runtime. There are zero running V1 containers and zero legacy Docker-provider
routers. All three applications have auto-deploy and preview deployment
disabled. Stop requests went through Coolify with `docker_cleanup=false`;
no global Docker cleanup, volume deletion, reset or schema migration occurred.

## Financial and historical admission

The current original ledger has three captured test payments/300 kopecks and
three successful full refunds/300 kopecks. All refund obligations are fulfilled,
bookings cancelled and tickets void. Nine emails are delivered; provider
webhooks are applied. No active deploy session, checkout attempt, outstanding
refund entitlement or valid customer confirmation token remains. Four unfinished
certification records are historical test phases, not unresolved bank work.

Admission used the actual serving payment `status` and refund facts, not the
obsolete `payments.state=CREATED` column. The owner's test-only attestation and
existing historical closure evidence are retained. No fresh bank authentication
was enabled and no new bank payment/refund request was made. Final read-back
confirmed the complete original order/payment/refund/obligation/booking/ticket
rows are unchanged.

The original SQLite volume and primary-file inode are preserved, with integrity
and foreign-key checks passing. Historical orders are not represented as fake
V2 customer/refund cases. Any later genuine historical case is located through
the archived original identities and provider/ledger, with fresh owner authority
for any new financial effect or reactivation.

## Static public boundary

The static host service is independent of V1 and runs as a confined dynamic
user on the existing private Coolify bridge. It reads no ledger or credentials,
executes no token and logs no request URI/body. An explicit-host file-provider
route retains TLS and excludes all canary V2 and Refref hosts. No shared proxy
restart or network-policy expansion was needed.

Installed source: `8c7dad8e1218c505f319d92c8e50452756556c0d`.
Its own exact-head [CI 38900337951](https://github.com/ArtGurianov/flexperiment/actions/runs/38900337951)
passed test and docker-build before activation. This is a separate host artifact,
not an update of a V1 application image or a move of `production-deploy`.

| Installed file | SHA256 |
| --- | --- |
| `retired_server.py` | `fb9937ce6ecf8e847e4b638fc30aa2ddb973f294cb6b764bc321890e794c1314` |
| service unit | `f9af9e20954571a5bc266237cd7d0ed8874a6a9dae4a2ddfefb1111d79858be5` |
| Traefik route | `d2999c82ec232bf47d43a7c28f5f2669c288f1c4e9f5446ba18e12c4ea7e7bb7` |

The initial public-code directory inherited0700 from the operator's restrictive
umask. It was corrected to explicit0755 before any public route was activated;
source/file bytes and service isolation were unchanged. Backend readiness was
proved from the actual proxy network; a host-local direct probe was unreachable
and was not made a reason to widen network access.

Independent Mac verification passed 36 HTTP/TLS probes both before and after
Coolify shutdown across root/www/API/Admin. Representative GET/HEAD/POST requests
to `/refund`, `/refund/confirm`, ticket and legacy refund API paths return410,
the static marker/body, no redirect and no cookie. Dummy probes contained no
real capability. The real browser confirmed the static page after normal reload
of an old cached document. New request tokens do not appear in service logs.

Support intentionally retains `art@flexperiment.ru`. The unverified
`refunds@flexperiment.ru` contact is not published by this boundary.

## Archive and independent recovery

Fresh encrypted custody includes 55 files: consistent current and historical
SQLite snapshots, serving source, original runtime/recovery configuration and
keys, Coolify application definitions and exact original-provider identities.
Provider GET/hash passed; Mac independently decrypted, checked every file,
restored the primary SQLite snapshot read-only and verified all table counts,
schema, financial closure and required secrets without logging values. No
restored writer/provider was run. Owned temporary plaintext was removed.

* Cipher SHA256: `d67ba2f41e45f0e0d4daed5f43c13de3492ad96bb68d3191c628a400c95062b2`,7204104bytes.
* Restored primary snapshot SHA256: `dd0b1f950d2ff2dc066204910a3f6aa463ebbd72c8cb47dd3b01081161ff6d6c`.
* S3 custody is in the dedicated `flexperiment/recovery/lab-v1-retirement/`
  namespace. No automatic expiry is introduced by this retirement; the final
  archive is not eligible for the old runtime-bundle cleanup pattern.
* Ciphertext was transported after the VPS's authenticated provider GET;
  decryption/restore were independently performed on Mac. This is not a claim
  of a direct Mac→S3 network probe.

A Coolify volume-backup schedule could stop and then restart V1. Its30previous
executions are successful, with no pending stop recovery or S3 cleanup. That
specific schedule is disabled through the native Coolify model, with its
preimage/after-state recorded; this installed version exposes no API for volume
schedules. The obsolete V1 runtime-key backup timer is disabled after custody.
Existing historical backups and configuration remain; V1 is not restarted to
make a retired backup job pass.

## Preserved boundaries and remaining ART-224 work

All 24 unrelated running containers retain their IDs, images and start times.
Closed V2 source/image/RootFS admission, schema 27, erasure fence OPEN/sequence1/
drained leases, fresh backup and four external 403 guards pass. Other proxy
configuration bytes are unchanged. V2 backup/freshness and production backup,
Refref PostgreSQL/base/WAL and Coolify backup timers remain active.

PR #246's manual email-intake code was separately merged as
`1294b4faa9ae88f90293ee5b036238c272da3ce8`, after exact-head `d30b0bf`
[CI 38898998158](https://github.com/ArtGurianov/flexperiment/actions/runs/38898998158)
passed. It is **not installed** by V1 retirement. Its client request API remains
compatible and does not itself execute a bank refund. The operator must still
verify actual email ownership/evidence, not only a typed sender field.

ART-224 stays In Progress for mailbox receipt, the next genuinely approved legal
contact revision, normal V2 installation admission and the email→Admin→separate
decision acceptance without a real financial execution. Accepted review.4 is
immutable. ART-39/83/338 remain Done; public F9 and ART-36/351 remain separate and
closed/unresolved as previously recorded. No new Linear issue was created.

See [the host runbook](../../../deploy/host/lab-v1-retired/README.md),
[current refund flow](../../release/REFUND_FLOW.md) and
[the completed financial E2E](../2026-10-16-paid-checkout-financial-e2e/README.md).
