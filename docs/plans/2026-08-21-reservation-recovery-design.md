# Reservation recovery

An abandoned payment attempt can retain a `RESERVED` booking, so capacity must
be released only from a provider-authoritative terminal failure or an explicit,
audited technical-abandonment command. `CREATE_UNKNOWN` remains occupied until
reconciliation supplies authoritative evidence.

`GET /v1/admin/orders/:id/evidence` exposes only existing order, payment,
booking, ticket, outbox, and abandonment facts. It deliberately omits a stored
payment URL because the runtime has no authoritative expiry proof for it.

`POST /v1/admin/orders/:id/abandon-reservation` requires Admin authentication,
an idempotency key, and a reason. It cancels only an unpaid `RESERVED` booking
and records an abandonment row plus audit evidence. A later successful payment
cannot re-confirm that booking; it creates a full refund obligation in
`REVIEW_REQUIRED` and records the late-payment review state. Provider-confirmed
payment failure releases a reserved booking automatically in the worker loop.
