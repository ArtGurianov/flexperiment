# City-interest lifecycle operations

## Two notification purposes

City-interest remains a city-level purpose with its own twelve-month expiry.
`occurrence_notification_requests` is a separate consent purpose: one email,
one selected occurrence and no city fallback. It has no clock-based expiry;
the worker deletes it at occurrence start or cancellation, on withdrawal, or
after provider-evidenced `DELIVERED`. One active request and one active intent
are database invariants. A newly unavailable occurrence suppresses a pending
intent and leaves the request available for a later eligible sweep. The legacy
city-interest repair commands are intentionally not extended: the new tables
were created with the referential and uniqueness invariants those scripts repair.

`city_interest_requests` is purpose-limited data. Its purpose is completed only
by a provider-evidenced Unisender `DELIVERED` event for the city-specific
notification. A durable enqueue, Unisender `ACCEPTED`, or `SENT` is not purpose
completion.

`expires_at` is exactly twelve calendar months after the explicit submission's
`consent_accepted_at`. A repeated explicit, CAPTCHA-protected submission for the
same email and city renews the legal evidence and starts a new twelve-month
period. It retains an existing non-terminal notification intent rather than
creating a second email; worker sweeps, visits, and email retries never do.

If the current intent has a final unsuccessful outcome (`hard_bounced` or local
`FAILED`), a new explicit CAPTCHA-protected submission starts a new consent
epoch. Commerce creates a new source request, marks the prior intent and source
request superseded, and redacts the old request's normalized email and email
hash in the same transaction. The old row remains only as a non-PII foreign-key
anchor for immutable outbox/provider evidence; it links durably to the new
request epoch. Exactly one non-superseded request remains for an email/city
identity. Commerce never reuses or resets the failed outbox.
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

## Controlled delivered-orphan repair

For a previously observed cleanup orphan, use the explicit local command only
with the exact opaque request ID and a matching confirmation value:

```bash
COMMERCE_CITY_INTEREST_REPAIR_REQUEST_ID='<request-id>' \
COMMERCE_CITY_INTEREST_REPAIR_CONFIRM='<request-id>' \
pnpm commerce:city-interest:repair-delivered
```

It deletes a request only when all durable predicates hold: a `DELIVERED`
`CITY_INTEREST_AVAILABLE` outbox has the exact `payload_ref` lineage to that
request, a `DELIVERED`/`delivered` provider event exists, the outbox was not
suppressed, and no intent remains for the request. The command is idempotent;
it makes no provider calls and returns `repaired: false` when the proof is not
complete. Do not use it for age-, city-, or email-based cleanup.

## Controlled superseded-failure repair

For a historical request that was durably superseded by a failed-epoch renewal
but whose source PII was not redacted, use the separate local-only command:

```bash
COMMERCE_CITY_INTEREST_SUPERSEDED_REPAIR_REQUEST_ID='<request-id>' \
COMMERCE_CITY_INTEREST_SUPERSEDED_REPAIR_CONFIRM='<request-id>' \
pnpm commerce:city-interest:repair-superseded
```

It redacts only a request with all of these independent durable predicates: a
recorded successor request link, an active successor in the same city, a
superseded old intent, and an old `FAILED` or authoritative `hard_bounced`
without `DELIVERED` evidence. It never deletes a request, calls a provider, or
infers identity from age, city, or email text. A legacy row with no durable
successor link—including the known request `9b9c6c4a-2622-4f9e-973c-02d453a78b8a`
unless such evidence exists after migration—must return `repaired: false` and
remain untouched; it cannot be safely repaired by this procedure.

`soft_bounced` is temporary provider non-delivery, so Unisender continues its
own delivery attempts. `hard_bounced` and generic local `FAILED` do not complete
the purpose; the request remains until withdrawal or expiry. `spam` is retained
as exact provider evidence and must not reverse a previously committed
`DELIVERED` outcome. The outbox aggregate `BOUNCED` status is therefore not a
city-interest purpose-completion predicate.

## Email dispatch recovery

A received Unisender HTTP response that rejects a send is authoritative local
failure evidence: Commerce records only a bounded, redacted provider code and
message, marks the outbox `FAILED`, and never automatically replays it. It does
not retain an API key, recipient, or request payload in error evidence. A new
city-interest notification after that state is possible only through a new
explicit CAPTCHA-protected submission, which creates a new consent epoch.

Only an ambiguous transport outcome after the provider request begins (for
example a timeout or network loss) becomes `SEND_UNKNOWN`. It retains the
stable provider idempotence key, uses an exponential persisted backoff, and
stops automatically after eight attempted sends as a terminal local `FAILED`
state. A known provider job is never resent; its unresolved reconciliation is
also backoff-scheduled while it waits for durable provider evidence instead.

For the single historic deployment signature `SEND_UNKNOWN`, more than 5,250
attempts, no job ID, and exact error text `Unisender send was not accepted
(HTTP 403).`, Commerce performs an idempotent local-only reconciliation to
`FAILED` with `HTTP_403_LEGACY` evidence. It does not send or call Unisender,
and it intentionally does not reinterpret other historical `SEND_UNKNOWN`
rows.

## Operator withdrawal procedure

An authenticated Admin operator receives a withdrawal at `art@flexperiment.ru`
and calls `POST /v1/admin/notification-consent/withdraw` with:

```json
{ "email": "subject@example.test", "reason": "Consent withdrawal received" }
```

The legacy `POST /v1/admin/city-interest/withdraw` path remains an alias. The
command deletes both matching notification purposes by the normalized email's
HMAC hash and returns separate aggregate counts. In the same transaction it records a durable suppression marker on each
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
