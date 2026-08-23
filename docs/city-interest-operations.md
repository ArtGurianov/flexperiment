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
hash. In the same transaction it suppresses each related `PENDING` or
`SEND_UNKNOWN` outbox from future local provider attempts and redacts local
outbox PII. Expiry uses the same suppression and redaction path. The worker
rechecks the durable relation and expiry inside its send claim transaction, so
an orphaned or expired outbox cannot begin a new provider call.

An already `SENDING`, `ACCEPTED`, or `SENT` request may have reached Unisender
before withdrawal/expiry wins. Commerce cannot recall that external message; it
does not retry it and redacts locally available PII. A later webhook is still
accepted using opaque `outbox_id` correlation. The command is naturally
idempotent: a repeat returns success with zero deleted rows. The audit record
stores only the operator, reason, and aggregate deleted count; it does not
retain the email or its hash.

## Production Unisender webhook gate

The production webhook must target:

```text
POST https://api.flexperiment.ru/v1/webhooks/unisender
```

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

Commerce accepts the CAPTCHA IP only from `x-commerce-trusted-client-ip`. Before
production use, verify in Coolify/Traefik that Commerce has no public ingress,
the trusted proxy strips any client-supplied instance of this header, and then
sets it from the actual connection address before proxying to Commerce. Verify
with a request through the public host and a forged header that the validation
request receives the proxy-derived value, not the forged value. The repository
reference Caddyfile does not establish this header itself.
