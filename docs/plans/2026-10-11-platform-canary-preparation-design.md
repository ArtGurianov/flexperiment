# ART-165 / ART-166 / ART-179 / ART-41: Platform canary preparation

## Design and boundary

Reuse Dockerfile.platform and its immutable identity, Payload transactions and
existing auth UI. Chosen over a second gateway or production-app reuse: opt-in
`PLATFORM_V2_CANARY=true` fails closed against exact approved origins, canary-only
Commerce UUID/port, separate SQLite path, runtime credentials, disabled jobs,
payments and marketing. No production fallback. This PR prepares an artifact;
it grants no app creation, deploy, ingress change or legal/content admission.

During preparation Payload collection create/update/delete access is disabled
(including initial author creation); media S3 writes are unconfigured. This is
backed by beforeChange/beforeDelete hooks ahead of existing manifest hooks and
custom mutation endpoint refusals, including Local API overrideAccess. This is
not a SQL write firewall: do not run owner commands or internal publish endpoints. A separately
reviewed author bootstrap/editorial qualification is required before opening CMS.

Alternatives: a separate proxy adds a control plane; blanket origin changes alter
other environments. Both are unnecessary. Existing non-canary configuration
remains supported; the canary flag must be explicitly installed and verified.

## Candidate configuration (not installed)

Build only: SOURCE_COMMIT (exact green admitted main SHA), PLATFORM_ORIGIN =
https://canary-platform.flexperiment.ru. Never build with runtime secrets.
The pinned pnpm manager is hydrated during build under /opt/corepack, readable
by the node user; Corepack network access is disabled at runtime. Boot cannot
depend on downloading a package manager. Actual-image CI probes this offline.

Runtime only:

- PLATFORM_V2_CANARY=true, PAYLOAD_JOBS_ENABLED=false, PAYMENT_MODE=disabled,
  MARKETING_BROADCASTS_ENABLED=false, DEPLOY_ENV=staging.
- PLATFORM_ORIGIN=https://canary-platform.flexperiment.ru;
  LAB_ORIGIN=https://canary-lab.flexperiment.ru;
  ADMIN_ORIGIN=https://canary-admin.flexperiment.ru;
  API_ORIGIN=https://canary-api.flexperiment.ru.
- COMMERCE_INTERNAL_ORIGIN=http://<verified canary Docker name>:3002. Only UUID
  xzuy7pk5y6ywjr9kh6nsk5ap or its timestamp suffix is syntactically admitted;
  syntax is not DNS/identity proof.
- PLATFORM_EXPECTED_COMMERCE_SHA: independently observed admitted Commerce
  canary SHA (currently 47eecb65a2a60e4c710b5c6b0b8e55130727fbc0).
  Platform /readyz checks this exact SHA, normal mode, DB, Refref and disabled
  payments via credential-free GET; transport/identity mismatch yields 503.
- PAYLOAD_DATABASE_URL=file:/var/lib/flexperiment-platform-canary/platform.sqlite.
  Dedicated new canary editorial volume mounted there; never Commerce or prod.
- PAYLOAD_SECRET: independent owner-held >=32-byte entropy secret, runtime-only.
- PLATFORM_COMMERCE_SERVICE_TOKEN: existing approved canary service credential,
  runtime-only, never NotiSend/provider credentials. No S3_BUCKET initially.
- BUILD_IDENTITY_FILE=/app/.identity/identity.json, baked, read-only.

Private owner escrow must be verified for both secrets and recovery key before
execution; this source preparation has not verified or installed those values.
No public domains/host ports/auto deploy. Keep all four public HTTPS 403 guards.

## Proxy and upstream lifecycle

Only auth/me/lessons/checkout/email/legal roots; foreign Host/Origin, legacy,
partner and traversal paths refuse before fetch. Host and forwarded HTTPS are
derived from approved origin, spoofed forwarding stripped. Preserve method,
body, query, Cookie, Set-Cookie and same-origin Location; no redirect following,
wildcard CORS or cache. Bounded transport errors return a fixed 503, not raw URLs.
Engineering tests are not real magic-link/cookie E2E.

Do NOT restart Commerce to invent a stable alias. After EVERY Commerce replacement:
verify Docker DNS from each frontend network, compare resolved container/app/source
identity, read Commerce /readyz; reconfigure timestamp upstreams through reviewed
Coolify env staging, then check LAB, admin and Platform /readyz/proxy before admitting
the replacement. Bare UUID previously NXDOMAIN; healthy frontend alone is not proof.
This remains a mandatory operational checkpoint, not an automated deploy guarantee.

## Editorial recovery admission (still pending live)

The editorial backup CLI uses read-only SQLite online backup (includes committed
WAL), checks Payload migration table, excludes Commerce schema, verifies integrity,
encrypts with public age recipient, fsyncs ciphertext before reporting hash/size.
Dedicated private backup mount /var/lib/flexperiment-platform-canary-backups.
No private recovery key in app. Ciphertext namespace must be
flexperiment/platform-v2/canary, separate from Commerce.

Before ingress: admit exact image/identity, separate writable volumes, retained
keys, actual Cloud.ru upload + independent SHA256 download, Mac isolated restore
in Russia, integrity/migration/schema/content comparison and restart persistence.
Install editorial scheduler only after independent review and restore PASS;
retention 7 local/100 remote, six-hour cadence, freshness <=8h and delivered external
failure notification are required. Existing Commerce scheduler/timers unchanged.
No live restore, escrow, scheduler or editorial persistence PASS is claimed here.

ART-232 Stage A texts, ART-169 real courseRefs, real inbox/captcha/browser E2E and
external backup alerts remain blockers. No synthetic legal/course data; no F9.
