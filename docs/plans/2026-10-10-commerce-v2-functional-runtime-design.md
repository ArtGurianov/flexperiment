# Commerce V2: normal-runtime qualification before F9

Existing issues only: [ART-162](https://linear.app/art-gurianov/issue/ART-162)
(readiness), [ART-179](https://linear.app/art-gurianov/issue/ART-179) (Better Auth),
[ART-169](https://linear.app/art-gurianov/issue/ART-169) (seed),
[ART-224](https://linear.app/art-gurianov/issue/ART-224) (checkout),
[ART-41](https://linear.app/art-gurianov/issue/ART-41) (cutover).
[ART-165](https://linear.app/art-gurianov/issue/ART-165) is the separate
Next.js/Payload runtime, not the Commerce API.

## Smallest code change

Use the existing normal `server.ts`, real Better Auth and existing F7. Wire the
already-qualified read-only Refref ops probe into normal application readiness.
Do not introduce a second runtime or extend the restricted foundation server.
Production and a Refref rail require an explicit allowed readiness URL; a
configured staging URL is also probed. Local/test and unconfigured staging
image smoke may run without Refref, reporting `not_required`, not connectivity
qualification. Configuration is validated before opening the database.

`normal-runtime.test.ts` imports the actual server composition. Only the socket,
SQLite filename and external IO are replaced: a real migrated in-memory SQLite,
real seed, actual Hono routes, Better Auth and encrypted outbox are exercised.
Tests cover dependency loss, secret admission, service-token isolation, legal
consent, signed-in private account/order reads and payment-disabled refusal.
The existing Vitest glob and required `test` job include the suite. They are
engineering proof, not a real proxy/cookie, NotiSend inbox or live canary proof.

PR #180 independently supplies the real NotiSend transport. This change does
not copy or replace it; the synthetic legacy relay in this test stays valid
after #180 through its supported relay mode. No production email is sent.

## Verified operational blockers, 2026-10-10

Read-only owner API/runtime inventory against deployed source
`a0f0f696b8f6c7b030bc0301760d19b22c62b4c9`:

- Canary app `xzuy7pk5y6ywjr9kh6nsk5ap` and isolated production app
  `gzngatkipv7dv3rkpuaigjg5` remain foundation mode, payment disabled,
  marketing disabled, no domains/host ports or automatic deployment.
- Both SQLite databases have 22 applied migrations, but zero cities, products,
  offers, customers, orders, legal releases and projected courses. Foundation
  completion did not imply seed/content/auth qualification.
- Canary lacks explicit platform/LAB/admin/API origins and NotiSend settings.
  Both apps lack Better Auth secret/outbox key, SmartCaptcha server key,
  Control Room session secret/admin hash and campaign unsubscribe secret.
  Do not switch to normal mode until runtime-only private inputs are installed.
  Reuse existing approved custody; do not invent origins or publish legal facts.
- Production has runtime-only NotiSend API key; PR #180 is still open at
  `049ceb18609c183c68e75467b2c1d779643f0bb8`, exact-head test/docker-build green.
- No V2 systemd unit/timer is installed. Existing legacy
  `flexperiment-recovery-backup.service` last exited 1. Its presence and the
  successful manual V2 snapshot/restore are not regular V2 backup admission.
- The accepted catalogue seeds cities and a CLOSED bundle, not real courses.
  Complete stable course refs/content and the Stage A legal release separately.

No configuration, runtime, database, routing, banking or email mutation was
performed for this inventory. Foundation evidence remains accepted.

## Executable remaining path

1. Merge/release the reviewed NotiSend PR #180 and this readiness delta through
   ordinary exact-source CI/review. Prepare explicit canary origins and private
   runtime-only auth/Captcha/admin/email inputs. Preserve both SQLite volumes.
2. Qualify normal canary with `PAYMENT_MODE=disabled`, marketing disabled.
   Apply the approved V2 seed once (exact replay is NO_OP); publish actual
   Stage A legal evidence. Verify real proxy magic-link/cookie/revocation,
   `/v1/me` no-store, service-token authority, catalog/order APIs, paid checkout
   503 and zero payment attempts. No mock rail in the live canary.
3. Before replacing V1, install independent scheduled V2 backups using online
   SQLite snapshots, age encryption and off-VPS storage in Russia. Require
   separate canary/production namespaces, retained recovery keys, verified
   remote SHA-256, defined retention and failure/freshness alerting. Restore a
   scheduler-produced archive independently; a manual restore is not a timer
   proof. The foundation-only storage CLI is not a normal-runtime backup command.
4. Finish Next.js/Payload/LAB dependencies (ART-165 and existing F9 blockers),
   including separate editorial SQLite/backup, content/media/legal admission.
   Then take the final encrypted V1 archive and prove its off-VPS restoration
   (ART-235). Adopt the existing fresh V2 SQLite lineage rather than deleting
   the already-qualified volumes (ART-236); seed does not import V1 customers.
5. Qualify the full exact-source application set before public routing changes
   (ART-237/238). Execute ART-41 only once its real prerequisites pass. Retire
   V1 after V2 verification, retaining its final owner archive off VPS.
6. ART-12 / R10 and ART-240 then qualify one separately authorized controlled
   Tochka payment → real webhook → entitlement → full refund. Public sales
   remain closed; neither a free Stage A launch nor READY authorizes money.

No new issues, no F9 cutover or real financial operations in this PR. Keep code
completion and production qualification separate in Linear evidence.

## Normal-canary follow-through, 2026-10-10 (ART-165 / 166 / 179)

Observed normal Commerce canary is `47eecb65a2a60e4c710b5c6b0b8e55130727fbc0`.
Its independent API-only read-back is accepted, not a complete controller or
magic-link qualification. Production remains the separate foundation runtime;
regular Commerce backups are qualified and must not be rebuilt. External
failure notification delivery remains pending for F9.

Prepare frontends against the same admitted application source, without reusing
production apps or removing the current HTTPS 403 guard:

| Target | Existing artifact / required preparation |
| --- | --- |
| `canary-platform.flexperiment.ru` | `Dockerfile.platform`, port 3001; independent editorial SQLite volume, private runtime `PAYLOAD_SECRET`, exact source identity, staging origins and `PAYLOAD_JOBS_ENABLED=false` initially. Configure canary-only `COMMERCE_INTERNAL_ORIGIN` and the existing canary service credential as `PLATFORM_COMMERCE_SERVICE_TOKEN`; never point at production. Editorial backup/restore is separate from Commerce SQLite proof. |
| `canary-lab.flexperiment.ru` | Separate `Dockerfile.frontends-v2`, build arg `V2_FRONTEND_SERVICE=lab-v2`, port 80; approved canary LAB origin baked in. The V2-only proxy does not translate the existing LAB's legacy `/v1/public/*` calls: those refuse, and full LAB functional qualification remains pending. |
| `canary-admin.flexperiment.ru` | Separate `Dockerfile.frontends-v2`, build arg `V2_FRONTEND_SERVICE=admin-v2`, port 80. Only the canary admin host, login/session/logout and `/v1/admin/v2/*` reach Commerce V2; partner, legacy admin and foreign hosts refuse. Working V1 config remains unchanged. |
| `canary-api.flexperiment.ru` | Existing normal canary, port 3002. Keep access guard; readiness alone is not permission to expose registration. |

`AccountClient` calls relative `/v1/auth/*`, `/v1/me` and `/v1/legal/*` with
same-origin credentials. Platform therefore also needs a qualified same-origin
Commerce proxy, not merely an API-origin environment variable. Reuse its existing
`app/v1/[...path]/route.ts` allowlisted proxy; `auth.ts` already rewrites the
magic-link URL onto the selected storefront host. These are code-level facts,
not live proxy/cookie proof, and do not justify writing a replacement auth flow.
Verify the actual magic-link verification URL lands on the same host that owns
the secure host-only cookie; do not solve this by setting `.flexperiment.ru` as
a cookie domain. Test exact trusted origins, no-store, logout/revocation and access gates
before per-host removal of any closed router rule. No matching canary frontend
apps currently exist in Coolify; existing production frontend/admin apps are
not staging substitutes.

Stage A owner inputs remain absent (ART-232 / ART-169): four approved document
texts/versions/URLs, and actual stable course/section/lesson refs, editorial
content and merchant access/offer facts. Compute hashes from approved bytes;
do not invent versions, activate synthetic legal releases, concatenate inferred
course purposes or modify the immutable seed to overwrite existing data.
Registration, offers, payments and broadcasts stay closed. Actual inbox,
CAPTCHA and browser cookie E2E remain unqualified until these dependencies are
met; configured transport is not delivery evidence.

### Canary-only static frontend preparation (ART-165 / ART-166 / ART-179)

`deploy/v2/frontends/` is a separate nginx boundary, not a change to either V1
Dockerfile or nginx config. Both artifacts bake `/identity` from exact
`SOURCE_COMMIT` (0444); a runtime env override cannot change that descriptor.
They require explicit `V2_COMMERCE_UPSTREAM` with the existing canary application
UUID `xzuy7pk5y6ywjr9kh6nsk5ap`, optionally its Coolify timestamp suffix, and
port 3002. Missing, arbitrary, production and legacy port-3001 targets refuse
before nginx starts. No API/provider credential is installed in static images.

The 2026-10-10 read-only Docker inventory exposed only the current container
name as a network alias (`xzuy7pk5y6ywjr9kh6nsk5ap-20261010T152433`), not a stable
application alias. Before any future frontend deployment, independently verify
its private DNS target and current app identity; do not assume the bare UUID
resolves. Use the verified current canary name or establish a reviewed stable
canary alias at an authorized rollout. Recheck after Commerce replacement.
This preparation does not restart Commerce merely to add an alias.

Proxy requests preserve URI/query, method, body, Origin, cookies, status,
Set-Cookie and Location, set the qualified storefront host and HTTPS scheme,
and overwrite spoofable forwarded identity headers. There is no cookie-domain
rewrite, CORS wildcard or cache. `/readyz` actually propagates the read-only
Commerce readiness response, including 503; it is not a full frontend/auth
readiness claim. It is also available to private Coolify probes without the
storefront Host; foreign-host application/API routes still refuse. Access/error
logs are disabled to prevent logging magic-link
query tokens, including malformed/oversized requests. Fixed diagnostic counters
may be added later without logging URLs or bodies.

Required CI runs real nginx on an internal synthetic Docker network and reruns
the same contract against both actual built images: exact immutable identity,
host/API isolation, request/response/cookie preservation, no permissive CORS,
upstream 503, oversized/error paths, token-free logs and invalid upstream refusal.
This proves the seam, not NotiSend delivery, real Better Auth cookie attributes,
CAPTCHA, legal admission, catalogue content or a live browser session.

No frontend is deployed or made public by these build/tests. The existing four
403 guards remain authoritative until matching admitted apps, editorial storage
and backup, legal admission and live access controls pass. Platform reuses its
existing dynamic Next/Payload artifact and proxy. Do not claim the static LAB
export is V2-complete: migrating its remaining V1 public API consumers is a
concrete application prerequisite, not something nginx can fix or silently
route into V1. Historical `STOP_AFTER_FINISHED` remains UNKNOWN; #188 improves
future observation only and does not require repeating the healthy API deploy.
