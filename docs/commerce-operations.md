# Commerce runtime operations

The public Next.js app remains a static export. The separately deployed single
Hono runtime owns all `/v1/*` requests, SQLite WAL data, and recovery work.
The static frontend calls the Commerce runtime at `https://api.flexperiment.ru`
using `NEXT_PUBLIC_COMMERCE_API_URL`, which must be set when the static frontend
is built. The API accepts browser CORS only from `https://flexperiment.ru` for
public Commerce routes. It must receive a proxy-authenticated client address in
`X-Commerce-Trusted-Client-IP` and must not use wildcard CORS.

`admin.flexperiment.ru` is a second same-origin pair. Its `fx_admin_session`
cookie is host-only, `HttpOnly`, `Secure`, and `SameSite=Strict`; do not change
its Domain attribute or proxy it through `flexperiment.ru`.

## Canonical public API catalogue

```text
GET  /v1/public/tour
GET  /v1/public/cities/:city/occurrences
GET  /v1/public/occurrences/:id
GET  /v1/public/legal-config
POST /v1/public/referrals/eligibility
POST /v1/public/checkout-context
POST /v1/public/checkouts
GET  /v1/public/checkout-status/:statusId
GET  /v1/public/ticket

POST /v1/webhooks/tochka
POST /v1/webhooks/unisender
```

The two webhook paths are provider callbacks, not browser-facing endpoints.
They remain in this catalogue so the deployed API surface is complete.

## Local development

Copy `.env.example` privately, set `COMMERCE_PROVIDER=mock`, then run:

```sh
COMMERCE_SEED_DEVELOPMENT=true pnpm exec tsx commerce/src/seed.ts
pnpm commerce:dev
```

The seed creates only the immutable city mirror and a clearly development-only
legal release. It creates no public occurrence. Production data is introduced
only through the audited Admin flow after legal releases are published and
verified.

Never use `commerce/src/seed.ts` in production. The production-only legal
bootstrap is `pnpm commerce:legal-release:publish`. It requires an approved,
checked-in `commerce/legal/production-manifest.json` (see the adjacent example)
with real immutable archive URLs. It verifies the four shipped legal document
hashes, publishes exactly one active release, and writes a durable publication
event. A reused version with a different manifest fails closed.

## Provider runtime and Phase 0 gate

The runtime reads the provider configuration names listed in `.env.example`.
They are runtime-only values: never place live values in source, fixtures,
logs, test output, or operations tickets. `COMMERCE_PROVIDER=mock` is local
development only and must not be set in production.

For Coolify, create a Docker Compose resource from this Git repository. Set
the production values in Coolify Environment Variables; do not create or mount
a repository `.env` file. `commerce` is the only migration owner: it applies
migrations before `/readyz` can become healthy. `commerce-worker` waits for
that health check and must not run migrations itself. Both services mount the
same persistent `commerce-data` volume, and the worker receives no Admin
password or session secret.

Tochka uses JWT bearer authorization and only the receipt-payment command at
`/acquiring/v1.0/payments_with_receipt`. The command always uses the frozen
USN/VAT-exempt, full-payment/service profile, card/SBP modes, a 20-minute TTL,
and immutable order fiscal snapshots. Provider calls happen after the durable
SQLite command commit. An uncertain response is `CREATE_UNKNOWN` and must be
reconciled; it must never cause another create-link call.

`POST /v1/webhooks/tochka` only accepts a `text/plain` RS256 JWT, validates it
against Tochka's rotating public JWK, and checks the operation, payment-link,
customer, merchant, amount, payment type, and successful status before it can
confirm a booking. Mismatches are quarantined for provider-drift review.

Unisender Go sends code-rendered HTML/plaintext with the stable outbox
idempotence key and persistent `outbox_id` metadata. Its known one-minute
duplicate window is not exact-once delivery. A response lost before `job_id`
remains `SEND_UNKNOWN`; the confirmed contract has no lookup by idempotence key
or metadata, so this implementation does not invent one.

Before traffic is enabled, run the production 1-RUB Tochka payment, verify the
receipt and signed callback, issue and reconcile a refund, and exercise an
actual Unisender send plus each configured callback status. Back up the SQLite
volume consistently and keep ticket encryption keys in a separately restorable
encrypted store.
