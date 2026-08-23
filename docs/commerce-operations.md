# Commerce runtime operations

The public Next.js app remains a static export. The separately deployed single
Hono runtime owns all `/v1/*` requests, SQLite WAL data, and recovery work.
The static frontend calls the Commerce runtime at `https://api.flexperiment.ru`
using `NEXT_PUBLIC_COMMERCE_API_URL`, which must be set when the static frontend
is built. The API accepts browser CORS only from `https://flexperiment.ru` for
public Commerce routes and must not use wildcard CORS. Its trusted client-IP
boundary is `Internet -> Coolify Traefik -> commerce:3001`: Commerce reads a
validated, single-value standard `X-Forwarded-For` only after the sole Traefik
ingress has sanitized client-supplied forwarded headers. The Compose resource
deliberately uses `expose: 3001`, not a public host-port `ports` mapping. Keep
Commerce on the private Docker network with Traefik; if another proxy/CDN is
added, review the forwarded-header trust model before release.

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

## Audited catalogue bootstrap

Once a production legal release is active, the only supported way to create
catalogue data is the authenticated Admin API:

```text
POST  /v1/admin/cities
POST  /v1/admin/occurrences
PATCH /v1/admin/occurrences/:id
```

Both `POST` commands require an Admin session, `Origin:
https://admin.flexperiment.ru`, JSON, and a fresh `Idempotency-Key`. A city
payload is `{ "name", "slug", "reason" }`; `name` is stored as the internal
city title. An occurrence payload also requires its `city_id`, title, start and
end instants (RFC 3339 UTC or numeric-offset form), IANA timezone, positive
price and capacity, one complete venue-disclosure shape, and `reason`.

Creation is deliberately non-public: the server rejects supplied
`visibility`/`sales_status` fields and persists every occurrence as `HIDDEN`
and `CLOSED`. Verify it in `GET /v1/public/tour`, then publish deliberately
with the existing PATCH command, supplying `sales_status: "OPEN"`,
`visibility: "PUBLISHED"`, and a reason. The transaction records the command
actor, entity, reason, idempotency-key hash, and request hash in the durable
admin audit log. Retrying a POST with the same key and exact payload returns
the same entity; changing the payload for that key fails closed.

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

`CREATE_UNKNOWN` is an ambiguous create boundary, never permission to repeat
`POST /payments_with_receipt`. The worker performs bounded, read-only payment
list lookups by the unique local `paymentLinkId` within the creation window. A
single matching operation reconnects normal payment reconciliation; no match
remains unknown, while duplicate or inconsistent provider evidence becomes
`REVIEW_REQUIRED` with a provider-drift record.

Unisender Go sends code-rendered HTML/plaintext with the stable outbox
idempotence key and persistent `outbox_id` metadata. Its known one-minute
duplicate window is not exact-once delivery. A response lost before `job_id`
remains `SEND_UNKNOWN`; the confirmed contract has no lookup by idempotence key
or metadata, so this implementation does not invent one. For city-interest,
`ACCEPTED` and `SENT` remain intermediate facts; only a correlated provider
`DELIVERED` event completes the narrowly scoped notification purpose. See
[`city-interest-operations.md`](city-interest-operations.md) for withdrawal,
expiry, and webhook-subscription requirements.

Before traffic is enabled, run the production 1-RUB Tochka payment, verify the
receipt and signed callback, issue and reconcile a refund, and exercise an
actual Unisender send plus each configured callback status. Back up the SQLite
volume consistently and keep ticket encryption keys in a separately restorable
encrypted store.

## Controlled full-refund fulfilment repair

A successful refund whose cumulative amount reaches the captured payment amount
automatically cancels a confirmed booking with `FULL_REFUND` and voids its
valid ticket in the same transaction. No manual repair is needed for new
refunds.

For a legacy order where durable evidence already proves `payment.status =
REFUNDED`, successful refunds cover the captured amount, but the booking is
still `CONFIRMED`, use this local-only command with the exact opaque order ID:

```sh
COMMERCE_FULL_REFUND_REPAIR_ORDER_ID='<order-id>' \
COMMERCE_FULL_REFUND_REPAIR_CONFIRM='<order-id>' \
pnpm commerce:full-refund:repair
```

It makes no provider request and sends no email. It returns `repaired: true`
only after all of those predicates are independently true, then atomically
cancels the booking and voids a valid ticket. A replay, an unknown order, a
partial refund, or a non-`REFUNDED` payment returns `repaired: false`.

## Controlled CREATE_UNKNOWN absence repair

Use this only after an operator has independently established provider absence
for the exact local order and payment. It performs no provider call:

```sh
COMMERCE_CREATE_UNKNOWN_REPAIR_ORDER_ID='<order-id>' \
COMMERCE_CREATE_UNKNOWN_REPAIR_PAYMENT_ID='<payment-id>' \
COMMERCE_CREATE_UNKNOWN_REPAIR_CONFIRM_ORDER_ID='<order-id>' \
COMMERCE_CREATE_UNKNOWN_REPAIR_CONFIRM_PAYMENT_ID='<payment-id>' \
pnpm commerce:create-unknown:repair
```

The command requires a pending `CREATE_UNKNOWN` payment with no provider ID,
capture, successful refund, or ticket, plus its still-`RESERVED` booking. It
atomically changes the payment to `CREATE_FAILED/CANCELLED` and releases that
booking with `CREATE_UNKNOWN_PROVIDER_ABSENCE_CONFIRMED`. Any failed predicate
or replay returns `repaired: false`.
