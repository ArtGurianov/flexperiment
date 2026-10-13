# ART-336 · Scoped canary Kinescope DRM ingress

2026-10-13. The owner authorized work on ART-336 and a manual project-scoped
Kinescope `PUT` once the callback was configured. After project encryption was
enabled, both project and workspace `GET /v1/drm/auth` still returned
`404 / 400404`: absent configuration, not a failed `PUT` entitlement test.
The project PUT and redacted GET read-back subsequently succeeded.

## Design

Use the existing Commerce handler `POST /v1/kinescope/drm/authorize` and a
separate Traefik file router on `canary-api.flexperiment.ru`. The router matches
the exact host, method and path with priority above the existing four-host 403
guard. It forwards to the verified Commerce canary service on the internal
`coolify` network. The guard file and all other routes remain unchanged. Add a
16 KiB request-body cap, bounded rate, no-store response and upstream timeouts.
Commerce validates Basic Auth, the signed short-lived playback token, the bound
video and current entitlement. With Kinescope `strict: true`, any missing/failed
backend response must not issue a license. `POST /v1/webhooks/kinescope` is a
separate status notification route and is not opened by this change.

For private browser testing, use an owner-controlled SSH tunnel into the VPS
loopback listener and local DNS mapping that preserves the four original HTTPS
hostnames and port 443. The existing loopback allowlist then admits only that
tunnel; no public source range is added. The Mac-side tunnel and DNS mapping
must be verified separately before browser E2E, including cookie origins and
TLS hostname validation. Do not lift the four-host guard to test a player.
Payments and marketing remain disabled. ART-36 owns actual provider license,
revocation and playback qualification.

## Live admission, ordered

1. Verify the actual Commerce canary container and image source SHA, its
   `coolify` network alias, and `/identity`. Confirm the accepted deployment
   identity; do not infer it from `main` or from a previous plan.
2. Restore the independent erasure authority/fence via its owner runbook if
   necessary. Require `/readyz` to report `erasure: qualified`, and a private
   callback POST to reach the handler. Do not bypass or reset the fence. A
   `503 ERASURE_RUNTIME_CLOSED` is a stop condition.
3. Provision distinct canary-only `KINESCOPE_DRM_USERNAME`,
   `KINESCOPE_DRM_PASSWORD` and a protected signing keyring in Commerce runtime
   custody. Set `KINESCOPE_API_TOKEN` and `KINESCOPE_DELIVERY_MODE=protected`
   only as part of a reviewed exclusive Commerce replacement. No secret in Git,
   shell history, Linear, CI logs or proxy files. Verify the replacement's
   identity, `/readyz`, and private callback refusal before routing.
4. Render `deploy/v2/canary-drm-ingress.yaml.template` with the verified Docker
   alias. Validate the YAML and Traefik load before placing it in the watched
   dynamic directory. Preserve the 403 guard file and its checksum. Observe
   public HTTPS: exact POST without Basic returns 401; wrong method, path,
   another host, and `/v1/webhooks/kinescope` remain 403; oversized body is
   rejected. All four origin roots remain 403. Unexpected 2xx is a stop.
5. Only then perform the project-scoped Kinescope `PUT` for
   `6964ab60-0ba1-4738-82d2-eada67792e0b`, callback URL
   `https://canary-api.flexperiment.ru/v1/kinescope/drm/authorize`, the same
   Basic credentials, and `strict: true`. Use a hidden API-token input or
   protected secret source. `python3 scripts/v2/configure_kinescope_drm_auth.py
   --apply --owner-files` on the owner VPS first probes the callback with those
   Basic credentials and requires
   the authenticated malformed-payload response `400`, then performs one PUT
   and a redacted project GET read-back. If the PUT outcome is unknown, GET
   manually before any retry. Never log raw provider responses.
6. Test provider-origin callback with a protected canary video and an actual
   signed grant, then denied, expired and revoked access. Keep provider E2E
   unqualified until ART-36 captures license enforcement evidence.

If the upstream is unavailable or times out, Traefik returns an error; the
provider must use `strict: true` so an error cannot grant a license. Monitor
5xx/timeout and denied counts without logging credentials or tokens. Rotate
Basic credentials by provisioning Commerce first, then updating the Kinescope
project configuration; a mismatch temporarily denies licenses. Rotate the
signing keyring per `docs/kinescope-playback-signing.md`.

## Observed execution

- Actual canary Commerce source: `84b1a6abcb43e9abf8f781e830f84822207c0dca`.
- Canary Commerce lacked `KINESCOPE_API_TOKEN`, DRM Basic credentials and
  playback signing keyring; delivery mode was `open`.
- Independent fence was initially `CLOSED` (sequence 1, no owner or leases);
  private callback POST returned `503 ERASURE_RUNTIME_CLOSED`. Owner-only
  read returned `REMOTE_VERIFIED` at sequence 1. The current canary container
  was directly restarted once to requalify boot; `/readyz` then returned 200,
  `erasure: qualified`, and a no-Basic callback returned 401. This direct
  restart bypassed the v2 owner controller's installed-erasure restart guard;
  it is recorded here as an operational deviation, not the replacement method.
- Distinct canary-only Basic credentials and playback signing secret were
  provisioned to Coolify runtime-only rows. The Basic pair remains in a
  root-owned 0600 owner file for Kinescope configuration; the signing-secret
  staging copy was removed after verified runtime read-back. Installed
  Coolify 4.4.6 unexpectedly mirrored each new row into preview; the three
  preview copies were deleted by UUID, and read-back confirmed only main rows.
- Owner controller hash matched the exact deployed source. A fresh age-encrypted
  canary backup (`sha256 ffa049e508f3ac1b84bcc8520a41b3f249c3da2d0abc9d94fa1c61d9005e107f`)
  was archived independently. Coolify stop and exclusive-writer checks passed;
  deployment `pldblrzpgw0tfxckuxwo17ju` finished at the same source SHA.
  New container and `/readyz` were healthy, erasure qualified, payment disabled.
  Production snapshot hash remained
  `63e676f92d4d889eab416049bff8902b347f6d8171dab963ec00e71e7a404062`.
- Four public canary HTTPS origins returned 403. The existing guard file SHA256
  remained `2af21f0754922986de39a1bca7a272ca606e13fdd5a53c41c2afbd33ce8d0653`.
  The separate route file SHA256 is
  `2364071afa273cca39dfb7a2f8697fcb7a5332d804028da23c255c2d4b22a1eb`.
  Over verified TLS, exact POST without Basic gave 401, with correct Basic and
  malformed body 400, wrong Basic 401, invalid signed token 403, and body
  >16 KiB 413. Wrong method/path,
  webhook POST, another host and all four canary roots gave 403.
- Project-scoped Kinescope PUT returned 200. Independent GET returned project
  200 with the expected callback host and `strict=true`; workspace GET remained
  404/400404. No raw response or credential was published. Delivery mode in
  canary Commerce remains `open`; read-only SQLite checks found zero video
  bindings and zero published course projections. No protected grant or
  Kinescope-origin license callback has been observed. ART-336 remains in
  progress and ART-36 remains unqualified.
