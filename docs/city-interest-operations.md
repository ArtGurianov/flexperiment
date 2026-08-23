# City-interest lifecycle operations

`city_interest_requests` is purpose-limited data. A row is physically deleted at
the earliest of: a durable notification intent for an eligible occurrence in
its selected city, `expires_at`, or a consent withdrawal.

`expires_at` is exactly twelve calendar months after the explicit submission's
`consent_accepted_at`. A repeated explicit, CAPTCHA-protected submission for the
same email and city replaces the legal evidence and starts a new twelve-month
period; worker sweeps, visits, and email retries never do.

The Commerce worker performs a bounded batch of expiry deletions and eligible
notification consumption each regular sweep. Its aggregate log line contains
only deletion counts, never email addresses, hashes, CAPTCHA tokens, or IPs.

An eligible occurrence is the earliest future occurrence for the selected city
whose `visibility = PUBLISHED` and `fulfillment_status = SCHEDULED`. Sales state
is deliberately irrelevant. In one SQLite transaction Commerce inserts a
`CITY_INTEREST_AVAILABLE` outbox row and deletes the source city-interest row;
a crash commits both or neither. The ordinary durable outbox owns all later
send/recovery work. While a row is retryable (`PENDING`, `SENDING`, or
`SEND_UNKNOWN`) it retains the delivery address. Once the provider outcome is
known terminal, Commerce redacts the outbox recipient, hash, and payload while
retaining non-PII delivery evidence.

## Operator withdrawal procedure

An authenticated Admin operator receives a withdrawal at `art@flexperiment.ru`
and calls `POST /v1/admin/city-interest/withdraw` with:

```json
{ "email": "subject@example.test", "reason": "Consent withdrawal received" }
```

The command deletes all matching city-interest rows by the normalized email's
HMAC hash. It is naturally idempotent: a repeat returns success with zero
deleted rows. The audit record stores only the operator, reason, and aggregate
deleted count; it does not retain the email or its hash.

## Trusted IP production gate

Commerce accepts the CAPTCHA IP only from `x-commerce-trusted-client-ip`. Before
production use, verify in Coolify/Traefik that Commerce has no public ingress,
the trusted proxy strips any client-supplied instance of this header, and then
sets it from the actual connection address before proxying to Commerce. Verify
with a request through the public host and a forged header that the validation
request receives the proxy-derived value, not the forged value. The repository
reference Caddyfile does not establish this header itself.
