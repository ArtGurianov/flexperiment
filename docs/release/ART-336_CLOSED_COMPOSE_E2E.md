# ART336/36/338 — closed Compose qualification

Owner15October closes delivered ART337; ART351 owns pre-F9 reader resilience.
Live tests require healthy/OPEN/current backup and stop on CLOSED/UNKNOWN.
No automatic restart, manual fence-open or old DB restore. Application images
remain the three source085 immutable digests, separate from this controller.

## Ingress boundary

The dedicated closed-e2e Compose adds two nginx services using the qualified
Admin digest. The callback bridge has no host port, only coolify+canary networks,
and passes the exact API host/POST/DRM path to Commerce. Other paths/methods
reject, body16KiB, no-store/timeouts/no logs. Existing Traefik matching and
rate/timeouts stay: change only its backend URL to
`http://flexperiment-canary-drm-bridge:80`. Preserve the old route and readbacks.
Guard file SHA256 remains
`2af21f0754922986de39a1bca7a272ca606e13fdd5a53c41c2afbd33ce8d0653`.
No shared proxy restart/network reconfiguration.

Tester nginx has only the canary network and `127.0.0.1:8446:443`. It proxies
API/Admin/Platform using their original HTTPS hosts; unknown and unused LAB
hosts deny403. Host/cookies/HTTPS scheme are preserved; no token logs.
Only the private Platform host serves four approved-source legal Markdown
documents under `/__closed_legal/`, from a readonly root-owned mount; GET/HEAD
only. Hash bytes must match the owner-approved proposal. Other hosts deny.

## Private TLS and browser

Extract only the existing certificate whose SAN set equals the four canary
hosts from root0600 `/data/coolify/proxy/acme.json`. Store fullchain/privkey
under `/etc/flexperiment-closed-e2e/tls` (root0700/key0600). Verify key/cert match,
all names, validity and system trust. No whole ACME store/other service key in
Git/evidence/Mac/app runtime. Only tester receives this readonly TLS mount.

Install configs under `/opt/flexperiment-closed-e2e/deploy/v2/closed-e2e`.
Run config/TLS checks, then the dedicated gateway Compose; do not up/down the
fast-cut stack during ingress setup. Verify actual image IDs/native identity,
network boundaries and loopback binding. Exact public POST401/400/403/413;
other methods/paths/hosts and four roots403. These are negative HTTP probes,
not Kinescope-origin callback evidence.

SSH forwards the VPS loopback listener to Mac localhost9446. An isolated Chrome
profile maps only three canary hosts to127.0.0.1:9446 using resolver rules.
Browser URL/Origin/SNI must stay normal443 origins, proven by real TLS/network
and cookies. Chromium [HostMappingRules source](https://chromium.googlesource.com/chromium/src/+/master/net/base/host_mapping_rules.cc)
supports replacement ports; actual browser qualification remains required.
No certificate/CORS/origin/SameSite/consent bypass, global DNS or default
profile change. Provider traffic uses public routing. DevTools/tunnel stay
loopback and profiles private.

## Commerce setup and real E2E

Preserve current env privately, verify existing source/volumes/erasure bindings
and an OPEN drained fence. Set only canary API token from the existing private
owner file, verified lesson parent ID and protected mode. Preserve Basic/signing
identities, disabled payments/marketing. Same immutable image/lineage and normal
prepareErasureRuntime boot. No project PUT/encryption change. Recheck actual
runtime and redacted project GET; on CLOSED stop dependent tests.

Normal operator browser authors/publishes a minimal real course/section/lesson;
Tus uploads owner tour.mp4 and polls READY, private binding readback. Use an
authorised controlled email, real delivered magic-link/CAPTCHA and authenticated
consent. Current legal release is absent; the prepared canary-only activation
proposal is docs/plans/2026-10-15-canary-legal-activation-proposal.json. Owner
15October explicitly approved this canary-only activation and supplied the
controlled mailbox/public widget key. Verify all four served HTTPS hashes,
then invoke the existing fenced internal legal-release API once, retaining
intent/outcome and independent current-release readback. No public legal/F9
admission or candidate-delta activation, synthetic consent/account/grant.

Live Control Room init exposed regional upload endpoint rejection; PR226 fixes
the bounded provider contract and runtime public SmartCaptcha key configuration.
Keep source085 installed until independent review/new artifact admission. Use
SMARTCAPTCHA_CLIENT_KEY for runtime public-key injection; preserve server secret.

Playback grant comes from normal Commerce endpoint and player drmauthtoken.
Observe actual provider callback/license/playback, foreign/expiry/revoke/
withdrawal denial, reload/resume. Record sanitized decisions/origin/path/status,
no cookies/JWT/credentials. ART336/36/338 close only after actual acceptance.
F9/production is independently blocked by ART351 and other release gates.

## Qualification and limits

Four real nginx/TLS contracts cover exact callback routing/auth passthrough,
body cap/no-store, private Host/scheme/Secure-cookie and manifest port/network
boundaries, plus exact legal bytes/host/method isolation. CI uses public nginx base; local run also uses the qualified Admin
digest. Fixture TLS uses --cacert, never --insecure. No app/provider E2E claim.
The read-only15min desktop heartbeat records and notifies health/CLOSED/backup
changes without restart; it depends on desktop host/SSH availability and is
not production alert qualification. Final resilience/alerts belong to ART351.
