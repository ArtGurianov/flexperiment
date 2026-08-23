# City-interest lifecycle operations

`city_interest_requests` is purpose-limited data. Its purpose is completed only
by a provider-evidenced Unisender `DELIVERED` event for the city-specific
notification. A durable enqueue, Unisender `ACCEPTED`, or `SENT` is not purpose
completion.

`expires_at` is exactly twelve calendar months after the explicit submission's
`consent_accepted_at`. A repeated explicit, CAPTCHA-protected submission for the
same email and city renews the legal evidence and starts a new twelve-month
period. It retains an existing notification intent rather than creating a
second email; worker sweeps, visits, and email retries never do.

If the current intent has a final unsuccessful outcome (`hard_bounced` or local
`FAILED`), a new explicit CAPTCHA-protected submission starts a new consent
epoch. Commerce retains the old outbox and intent as immutable history, marks
that intent superseded, and may create one new outbox for the current request.
`hard_bounced` is authoritative when its durable provider evidence exists and
no `DELIVERED` evidence exists; later non-delivery callbacks do not erase that
fact. It never reuses or resets the failed outbox. `PENDING`, `SENDING`,
`SEND_UNKNOWN`, `ACCEPTED`, `SENT`, `soft_bounced`, `spam`, and suppressed
intents cannot be renewed in place. A normal `DELIVERED` intent has already
deleted its source request and redacted its PII; any later explicit submission
is therefore a separate fresh request, not a renewal of the delivered intent.

The Commerce worker performs a bounded batch of expiry deletions and eligible
notification-intent creation each regular sweep. Its aggregate log line contains
only deletion counts, never email addresses, hashes, CAPTCHA tokens, or IPs.

An eligible occurrence is the earliest future occurrence for the selected city
whose `visibility = PUBLISHED` and `fulfillment_status = SCHEDULED`. Sales state
is deliberately irrelevant. In one SQLite transaction Commerce inserts a
`CITY_INTEREST_AVAILABLE` outbox row and exactly one
`city_interest_notification_intents` relation. The source request remains until
the earliest of provider-evidenced `DELIVERED`, expiry, or withdrawal. The
relation uses opaque database IDs, not email text or payload parsing.

`DELIVERED` atomically records/deduplicates provider evidence, marks the outbox
delivered, deletes the source request, and redacts the outbox recipient, hash,
and payload snapshot. Late duplicate callbacks remain processable through
`outbox_id` metadata and non-PII provider evidence.

`soft_bounced` is temporary provider non-delivery, so Unisender continues its
own delivery attempts. `hard_bounced` and generic local `FAILED` do not complete
the purpose; the request remains until withdrawal or expiry. `spam` is retained
as exact provider evidence and must not reverse a previously committed
`DELIVERED` outcome. The outbox aggregate `BOUNCED` status is therefore not a
city-interest purpose-completion predicate.

## Operator withdrawal procedure

An authenticated Admin operator receives a withdrawal at `art@flexperiment.ru`
and calls `POST /v1/admin/city-interest/withdraw` with:

```json
{ "email": "subject@example.test", "reason": "Consent withdrawal received" }
```

The command deletes all matching source requests by the normalized email's HMAC
hash. In the same transaction it records a durable suppression marker on each
related outbox, suppresses every non-delivered row as `SKIPPED`, and redacts
local outbox PII. Expiry uses the same suppression and redaction path. The
worker rechecks the durable relation and expiry inside its send claim
transaction, so an orphaned or expired outbox cannot begin a new provider call.

An already `SENDING`, `ACCEPTED`, or `SENT` request may have reached Unisender
before withdrawal/expiry wins. Commerce cannot recall that external message; it
does not retry it and redacts locally available PII. A late `send()` result may
retain only its opaque provider job ID; it cannot restore the local outbox to
`ACCEPTED`. A later webhook is still accepted using opaque `outbox_id`
correlation and recorded as provider evidence, but only a late `DELIVERED`
outcome may change the suppressed aggregate status. The command is naturally
idempotent: a repeat returns success with zero deleted rows. The audit record
stores only the operator, reason, and aggregate deleted count; it does not
retain the email or its hash.

## Production Unisender webhook gate

The production webhook must target:

```text
POST https://api.flexperiment.ru/v1/webhooks/unisender
```

Unisender's authenticated `webhook/set` URL check makes a parameterless GET
and requires `200 OK`. Commerce exposes `GET /v1/webhooks/unisender` as the
stateless `200 {"ok":true}` verification response with `Cache-Control:
no-store`. It has no delivery semantics, creates no evidence, and does not
weaken the callback boundary. A real delivery callback is still a JSON `POST`
carrying the documented raw-body MD5 `auth`; an unsigned or empty `POST`
deliberately returns
`401 UNISENDER_WEBHOOK_AUTH_INVALID`.

The Unisender Go configuration API exposes the POST-only
`/ru/transactional/api/v1/webhook/set.json` endpoint and requires its API key.
Use that authenticated path for a controlled subscription configuration rather
than weakening the callback receiver. The confirmed GET check is satisfied by
the verification response above. Do not change Commerce to return `200` for an
arbitrary unsigned POST: such a request is indistinguishable from a forged
delivery callback.

It must be active, use JSON POST (not gzip unless Commerce is extended), and
subscribe at minimum to `delivered`, `soft_bounced`, `hard_bounced`, and `spam`.
Also enable `accepted`/`sent` when available for the configured Unisender
account so intermediate evidence is visible. The repository verifies raw-body
MD5 authentication and event deduplication; it cannot prove the provider-side
subscription.

Before enabling traffic, inspect the webhook in Unisender, send a controlled
test message, verify `outbox_id` correlation and one durable provider-event row,
resend the exact callback to prove dedupe, and confirm that the provider has not
stopped the webhook after delivery failures.

## Trusted IP production gate

Commerce resolves a CAPTCHA IP only from a validated standard
`X-Forwarded-For` value at the sole production boundary
`Internet -> Coolify Traefik -> commerce:3001`. With the current Traefik safe
forwarded-header defaults, Commerce accepts exactly one IPv4/IPv6 literal and
omits SmartCaptcha's optional `ip` parameter for an absent, malformed, or
multi-value header. It never forwards a placeholder such as `unknown`.

Before production use, verify that Commerce has no direct public ingress and
that Traefik strips client-supplied forwarded headers before proxying. Run the
controlled normal/forged-header verification in
[`smartcaptcha-operations.md`](./smartcaptcha-operations.md#controlled-production-verification).
If a CDN or another reverse proxy is added ahead of Traefik, reassess the
trusted-header model before enabling the form.
