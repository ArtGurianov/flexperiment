# ART-200: merchant-local LAB seat holds

Implements the accepted quote/confirm boundary in
[commercial admission design §2](2026-10-18-commercial-admission-lab-editions-design.md#2-quote-guarantee-lms-and-lab).

The hold belongs to the existing durable purchase intent (`checkout_quotes`).
`seat_hold_ref` and `seat_hold_expires_at` are immutable and duplicated in its
frozen line snapshot. This avoids a second reservation lifecycle or an external
reservation service. Courses have no hold. Refref receives neither these local
fields nor `inventoryReservation`/`latePaymentPolicy`.

New-quote admission, expiration of superseded unconfirmed LAB intents in the
same verified admission scope, capacity admission and the new intent/hold write
share one `BEGIN IMMEDIATE`. Failure rolls back replacement too. Guest admission
scopes remain order-bound; an anonymous mailbox never replaces another guest's
hold. Repeating the same intent reuses its hold and original deadline, including
when another process committed while this request awaited payment read-back.

Hold expiry is the earlier of intent creation plus 15 minutes and occurrence
start. Refref/promotion deadlines may shorten the reviewed quote. Only live,
unconsumed intents count as quote holds. Expired, refused, replaced and materially
invalidated quotes cannot be confirmed. Inventory includes holds in catalogue,
Control Room and operator capacity/reserve checks. Cancellation may invalidate
unconfirmed holds; started orders still require the separate ART-203 workflow.

Confirm verifies the original hold, frozen agreement and admission gates under
the same write lock as order/attempt creation. It sets `consumed_at` as the order
takes the seat: inventory never counts both. Ordinary offer close and price edits
preserve the issued quote. Refref attempt creation happens after commit. Started
orders retain their seat through lost answers and beyond every quote deadline;
existing authoritative reconciliation controls their final outcome.

Migration 0033 expires old unconfirmed LAB quotes because they never reserved
capacity. It preserves consumed intents and existing order seats. The reviewed
schema fingerprints in erasure/retention include the added intent columns and
triggers; customer ownership and erasure targets remain those of the intent.

Validation covers two independent SQLite processes contending for the last seat,
concurrent identical requests, replacement rollback, expired hold reuse, frozen
hold identity, reserve bounds, pre-confirm cancellation, migration of old quotes,
and lost attempt answers with the original request/order/attempt and no new hold.
Local verification and CI do not authorize deployment, production migration,
real payments or LAB sales activation.
