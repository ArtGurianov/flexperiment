# Review corrections, 19 October 2026

Implement the reviewed ART-357/373/375/374/199/275/339 corrections in the existing PRs.
C2 is the single browser-context authority; C1 links arrivals through it. LAB lifecycle and
seat admission precede durable checkout intents. Refref deadlines, stable order identity,
and typed definitive refusals must survive replay. Unknown payments retain their fence.
Schema fingerprints qualify the final migration chain; old backup hashes remain explicit.
Mikluha conformance pins an exact candidate and does not imply mutable-HEAD qualification.
Regression tests cover the reviewed boundaries. No production migration, sales activation,
merge, or live payment is part of this change. An unspecified privacy duration requires an
explicit policy; it must not be invented as a migration default.

Follow-up CI review: do not import the Platform/Next type graph into the root Commerce test target.
Keep the public API privacy regression under commerce-v2 and exercise the metadata HTTP fixture in
apps/platform/test with its own alias/Next compiler scope. Run both compiler targets and full lint.

LAB buyer preview returns its frozen occurrence, including a private confirmed venue or a TBA
announcement deadline. The public catalogue continues to hide a private venue. Browser purchase
UI and E2E remain ART-379/384. Migration 0028 is the existing TOTP migration; LAB is 0029.

Intents follow LAB as migration 0030. All 0001–0030 DDL is requalified for erasure/retention.
Late authoritative payment read-back may correct post-confirm terminal observations; it never
returns an intent to pre-confirm state. Closed paid-test scope remains its explicit safety policy.

Follow-up CI review: inventory fixtures use Pick<LabOccurrenceRow,...>, never explicit any.
The closed paid-test profile still enforces its exact approved live offer price/scope; the normal
issued-quote guarantee does not weaken this separate acceptance-only safety gate. RC.2 lost-answer
replay requires the original handoff token supplied again by the caller; its digest is no autonomous
recovery credential. vNext removes that transitional token dependency.

Stack integration follows repository squash policy: squash the base PR, then rebase/replay only the
dependent PR's delta onto the new main and rerun schema/replay/privacy qualification. Do not merge
the old dependent stack unchanged after a base squash, and do not require merge-commit history.

Owner confirmed and updated ART-373 on 2026-10-19; read-back verified the two-stage acceptance.
Dedicated tests cover pre-confirm schedule, venue address/status edits and fresh preview; after
confirm the same changes preserve pending payment, frozen order agreement and its seat.


Round-four review: use an append-only 0031 trigger, rather than a new monotonic contract-version
column. Every material schedule/timezone/buyer-venue/lifecycle mutation atomically expires only
unconsumed DRAFT/RESOLVING/CUSTOMER_ACTION_REQUIRED/REVIEW intents, with a durable failure reason.
Returning the fields to their old values cannot revive them. A rolled-back edit rolls back expiry.
Title, offer price and venue_public do not alter the buyer's frozen agreement. The upgrade expires
existing pre-confirm LAB quotes once, since their earlier mutation history cannot be proven; no
consumed payment intent is touched. Quote consumers must apply 0031 before serving this guarantee.
Stale, expired and cancelled refusals use CheckoutConflictError and HTTP 409; unknown failures remain
503. Confirm retains its BEGIN IMMEDIATE final admission, while resolving late answers observes
the persisted terminal state. No order/seat/attempt is cancelled by a schedule/venue mutation.
The shared error class lives in checkout-conflict.ts to avoid a checkout/lab module cycle.


Round-five review: checkout admission returns CheckoutConflictError for the declared LAB
not-found/started/venue-missing/sold-out/cancelled refusals and offer unavailable/free/closed,
acceptance/ownership refusals. Shared fiscal, sales-activation and promotion guards keep their
Control Room error types; checkout wraps only FISCAL_POLICY_NOT_QUALIFIED,
SALES_ACTIVATION_REQUIRED and CHECKOUT_QUOTE_STALE. An unexpected DB failure is rethrown, never
rewritten as a final fiscal refusal. Administrative edit/cancel errors stay ordinary Error.
The HTTP adapter already maps CheckoutConflictError to 409 + no-store, so its generic fallback
and payment-uncertainty handling do not change. Regressions use two real HTTP customers with
pre-issued quotes for the last LAB seat, started preview, withdrawn offer, retired/replaced fiscal
policy, revoked activation, stopped promotion and an injected unknown SQLite fault. This is a
classification-only change: no migration, new DDL hash or change to quote/payment lifecycle.


Merge-stage P2 hardening: checkout preview/confirm return their stable route-specific unavailable
codes for unknown exceptions. Known typed business refusals and consent keep 409/403; locally
authored static CommerceConfigurationError codes (including PAYMENTS_DISABLED) keep 503.
The ordinary diagnostic is deliberately redacted: operation code and ERROR/NON_ERROR only; no
raw message, SQL, upstream response, token, cause or stack is logged. Regression fixtures contain
sensitive-looking DB/upstream messages and non-Error throws. No schema/lifecycle changes.
