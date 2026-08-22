Flexperiment Commerce — RC.8.3 (self-contained architecture freeze)

Context

RC.8 was accepted as an architecture freeze by the reviewer, but the reviewer's completeness pass on the RC.8→RC.8.1 draft found that trimming RC.7 down to RC.8 silently dropped two load-bearing pieces of domain model (the promo/reward configuration schema, and idempotency for the new PREPARED settlement command) and left the document dependent on a "RC.7 blockers remain required" pointer instead of being self-contained. RC.8.1 folded those pieces back in. A second reviewer pass on RC.8.1 found two blocker-level bugs newly introduced by that fold-in itself (an email-recovery rule that silently reintroduced blind-retry-on-crash, and a payment/booking race that could resurrect a cancelled booking) plus two smaller HIGH fixes — RC.8.2 corrected those. A third reviewer pass on RC.8.2 found one more genuine completeness gap left over from the original RC.7→RC.8 trim: the refund state machine was fully specified, but the persistent command/table that actually backs it — and the ordinary Admin compensation-refund endpoint that RC.7 had — never made it back into the document. RC.8.3 is a corrective patch for exactly that gap. It is not a new architecture review; payment, terminal-occurrence, refund-obligation, ticket-security, reward-balance and checkout-idempotency state machines remain frozen as accepted in RC.8.

Two decisions were confirmed with the user while drafting RC.8.1 and carried forward unchanged:

Network boundary: same-origin. flexperiment.ru/v1/* routes to the singleton Hono runtime, everything else to the static export. Admin is a second same-origin pair on admin.flexperiment.ru. No CORS is emitted or relied upon for normal public commerce operation.

Promo/agent disable cascade: derived, not physical. Disabling an agent does not mutate promo_codes.status. A promo linked to a disabled agent becomes derived-ineligible for new orders; re-enabling the agent makes it eligible again automatically. Historical orders/attribution/rewards are never touched.

The five RC.8.2 corrections (email SEND_UNKNOWN ambiguity, customer-cancellation late-payment race, withheld-expense refund derivation, email outbox recipient snapshot, settlement-idempotency replay status) are unchanged and retained below.

RC.8.3's one completeness fix, also self-derived — a missing table and endpoint the rest of the document already assumed exist, not a new product decision:

Blocker — refund states (REQUESTED…REVIEW_REQUIRED, §14) had no backing persistent row, and the consolidated Admin API had no ordinary compensation-refund endpoint (booking stays active) — only occurrence/booking cancellation, which void the booking as a side effect. Fixed with a refunds table (§14.2) that both refund_obligations (§4) and a new POST /orders/:orderId/refunds admin-compensation endpoint (§14.3) write into, plus an evidence-based REVIEW_REQUIRED resolution contract (§14.4) that does not reopen "no generic financial status editor" (§23).

This file is the complete RC.8.3 specification. It supersedes RC.8, RC.8.1, RC.8.2 and RC.7 in full — there are no remaining "see previous RC" pointers. It is written to be handed directly to an implementation agent.

Everything under §1–§3 (Core architecture, Occurrence/venue, Complete/cancel) and §10–§13 (Capacity/payment, crash recovery, webhook/public status) is materially unchanged from RC.8 — included here in full for self-containment, not because it was re-litigated. Changed/new material is marked [RC.8.1], [RC.8.2] or [RC.8.3].

Summary

RC.8.1 was a completeness pass on RC.8, which itself fully replaced RC.7. RC.8.2 was a corrective patch on RC.8.1 (five points, retained). RC.8.3 (this document) adds one more completeness fix — the persistent refund command model and admin compensation-refund endpoint — see Context above. Nine items changed RC.8 → RC.8.1, unchanged here:

promo_codes schema, agent reward-config defaults, and order-level reward/promo snapshots are restored [RC.8.1].

PREPARED settlement creation is now idempotent via Idempotency-Key [RC.8.1].

Promo eligibility is re-checked at order creation (PROMO_NO_LONGER_ELIGIBLE), using the same processing-order slot as the material-revision guard [RC.8.1].

Promo/agent disable cascade is specified as derived eligibility, never a status mutation [RC.8.1].

Public network boundary and CORS policy are specified explicitly (same-origin) [RC.8.1].

Email outbox schema with lease/job_id crash-recovery fields is specified [RC.8.1].

Customer-initiated cancellation gets an explicit Admin API contract, wired into the refund-obligation model via a new initial_source value [RC.8.1].

Checkout-status polling cadence is specified and the per-statusId rate limit is raised so the app's own success page cannot self-DOS [RC.8.1].

A consolidated Admin API catalogue and a consolidated, self-contained release-blocker list replace the "all RC.7 blockers remain required" pointer [RC.8.1].

All eight RC.7→RC.8 fixes (manual settlement PREPARED, blocked/prepared amounts in balance, permanent checkout idempotency, sessionStorage attempt recovery, material-revision guard, refund-obligation UNIQUE(payment_id), ATTENDED removal, rate limits) are retained unchanged.

Core architecture is unchanged: static city pages, occurrence-based commerce, provider-verified financial truth, immutable legal releases, professional promoters НПД/ИП, manual settlements, no payout engine, one commerce runtime replica.

1. Core architecture and invariants

Cities

/kemerovo
/novosibirsk
/novokuznetsk
/tomsk
/irkutsk
/krasnoyarsk

Canonical build-time city manifest immutable.

SQLite cities — verifiable mirror.

Admin does not create, delete or rename cities.

City → Occurrence[]; zero/one/many occurrences without public rebuild.

Static SEO/editorial content is separated from live commerce state.

Occurrence hard-delete is forbidden.

Participant

one checkout
= one adult self-purchasing participant
= one seat
= one order
= one booking
= one ticket

Checkout collects:

name
email

Required confirmations:

18+
ticket purchased for self
Public Offer accepted
separate PD Consent accepted

Third-party, gift, minor and group purchases do not exist.

Runtime

Next.js 16 static export.

Hono + TypeScript + Node 22.

Drizzle + better-sqlite3.

SQLite WAL, foreign keys on, busy timeout.

Exactly one commerce runtime replica.

Docker/Coolify, persistent volume.

BEGIN IMMEDIATE protects inventory, checkout idempotency, settlement-prepare idempotency and settlement allocation.

2. Occurrence and venue

Occurrence:

city_id
title
starts_at
ends_at
timezone

price_kopecks
currency=RUB
capacity

sales_status:
  OPEN
  PAUSED
  CLOSED

visibility:
  HIDDEN
  PUBLISHED

fulfillment_status:
  SCHEDULED
  COMPLETED
  CANCELLED

completed_at
cancelled_at
cancellation_reason
material_revision

Terminal state machine:

SCHEDULED
   ├──→ COMPLETED
   └──→ CANCELLED

COMPLETED/CANCELLED are irreversible. Terminal transition closes sales; visibility unchanged.

Booking statuses:

RESERVED
CONFIRMED
CANCELLED

ATTENDED removed. Attendance/check-in is a post-v1 feature.

Venue

venue_status:
  CONFIRMED
  TO_BE_ANNOUNCED

venue_name
venue_address
venue_public
venue_disclosure_text
venue_announce_by

Confirmed venue requires name/address.

TBD venue requires disclosure text/deadline.

venue_public=false hides the address only from the marketing page.

Checkout always discloses exact venue or the agreed TBD condition.

Order snapshots exact disclosure.

Material revisions

Material fields:

starts_at
ends_at
timezone
venue_status/name/address/disclosure_text/announce_by

Material edit requires reason, increments revision, stores before/after and notifies confirmed customers with remedy instructions.

Paid-after-order/reservation-revision race:

CUSTOMER_TICKET_WITH_EVENT_CHANGE

A new order from a stale quote is forbidden.

3. Complete and cancel occurrence

Admin endpoints:

POST /v1/admin/occurrences/:id/complete
POST /v1/admin/occurrences/:id/cancel

Both require authenticated singleton admin, strong confirmation and audit.

Complete

Requirements:

occurrence SCHEDULED;

current time >= ends_at.

Effects:

fulfillment_status → COMPLETED
sales_status       → CLOSED
completed_at       → server time

Unresolved RESERVED bookings become CANCELLED; payment reconciliation continues.

Late APPROVED:

payment PAID
booking remains CANCELLED
no ticket
no reward
full-refund obligation

Cancel

Payload:

reason
confirmation_text = "CANCEL <occurrenceId>"
Idempotency-Key

Effects:

fulfillment_status → CANCELLED
sales_status       → CLOSED
visibility         → unchanged

Confirmed bookings:

booking CANCELLED
ticket VOID
capacity released
reward zero
full-refund obligation
OCCURRENCE_CANCELLED email

Reserved/in-flight:

booking CANCELLED
capacity released
no ticket/reward
payment reconciliation continues

Late APPROVED records PAID truth, leaves booking cancelled and creates a full-refund obligation.

No runtime transfer of payment to another occurrence.

4. Refund obligations

refund_obligations
------------------

id
payment_id            // UNIQUE

initial_source:
  OCCURRENCE_CANCELLED
  LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE
  CUSTOMER_CANCELLATION_PARTIAL              // [RC.8.1]
  LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION   // [RC.8.2]

target_refunded_amount_kopecks
status:
  OPEN
  FULFILLING
  FULFILLED
  REVIEW_REQUIRED

created_at
fulfilled_at

Database constraints:

UNIQUE(payment_id)
target_refunded_amount_kopecks >= 0

Upsert rule:

target = max(existing target, newly required target)

Target never decreases.

Additional reasons/events:

refund_obligation_events
------------------------

obligation_id
source
provider_event_id?
admin_action_id?
created_at

For confirmed-paid organizer cancellation (OCCURRENCE_CANCELLED), target equals the full captured amount.

For CUSTOMER_CANCELLATION_PARTIAL [RC.8.2 — server-derived], target equals captured_amount − withheld_expense_amount_kopecks, computed server-side from the customer-cancellation Admin API (§14.1) — it is never an admin-entered refund figure directly, and it only exists when the payment was already PAID at the moment of cancellation. A later organizer cancellation of the same occurrence still upserts target = full captured amount (max-rule applies), superseding the partial figure.

For LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION [RC.8.2], target equals the full captured amount, with no expense-withholding. This source covers the case where §14.1 cancels a booking before its payment captures (booking RESERVED/CONFIRMED, payment PENDING/RECONCILING/CREATING) and the provider later approves the payment anyway. §11's entitlement gate keeps the booking CANCELLED in that case; this obligation is what guarantees the late-captured money is still tracked for refund. No documented-expense decision exists for this path because there was no completed order at cancellation time to attach one to.

Pending payment gets an obligation only after actual capture.

Successful previous refunds reduce outstanding amount.

An existing nonterminal refund completes reconciliation first.

The worker creates at most one next refunds row (§14.2) per payment, with source = REFUND_OBLIGATION and amount_kopecks = outstanding target — this is the concrete mechanism behind "the worker creates the next provider refund command," not a separate unspecified path.

Provider refund retains standard idempotency/unknown-state recovery (§14.2).

Duplicate webhook/admin/worker race cannot create competing obligations.

A failed obligation generates a refund-debt alert and never restores booking/ticket/reward.

5. Legal and consent authority

Immutable legal manifest:

document_id
version                 // YYYY-MM-DD.N
effective_at
sha256
current_url
archive_url
checkout_relevant

Documents:

PUBLIC_OFFER
PRIVACY_POLICY
PD_CONSENT
DISCLAIMER
DISSEMINATION_CONSENT_TEMPLATE
ANALYTICS_NOTICE
CHECKOUT_DISCLOSURE

Order evidence:

checkout_legal_release_id

public_offer_version/hash/accepted_at
privacy_policy_version/hash/presented_at
pd_consent_version/hash/accepted_at
checkout_disclosure_version/hash

eligibility_confirmed_at

Stale release:

409 LEGAL_VERSION_CHANGED

No order/reservation/provider command.

Legal documents cover dynamic price, self-purchase 18+, venue disclosure, organizer cancellation/full refund, material changes, actual providers, analytics and professional promoter settlements.

Activation:

publish static documents
→ verify URL/version/hash
→ activate matching API release

6. Public network boundary [RC.8.1]

flexperiment.ru is the sole browser-facing origin for the public site and the public commerce API.

The reverse proxy routes /v1/* to the singleton Hono commerce runtime and every remaining public path to the static Next.js export.

Public browser API calls are therefore same-origin, and CORS headers are neither emitted nor relied upon.

/v1 is reserved for backend routes and MUST NOT be generated by the static site. (/api is deliberately avoided — Next.js associates that prefix with its own route handlers, which this project does not use.)

admin.flexperiment.ru hosts the Admin SPA and the Admin API as a second, internally same-origin pair. The host-only Admin session cookie is scoped to admin.flexperiment.ru and is never sent to flexperiment.ru.

Provider webhooks (Tochka) are server-to-server HTTP and do not use CORS; their security boundary is RS256 signature + merchant/customer identity + operation/paymentLink checks + amount checks, called at https://flexperiment.ru/v1/webhooks/tochka.

Both hostnames route to the same singleton Hono instance; same-origin is a proxy-routing property, not a second runtime.

flexperiment.ru
├─ public static frontend            (everything except /v1)
└─ public commerce API  /v1/public/*, /v1/webhooks/*

admin.flexperiment.ru
├─ admin SPA
└─ authenticated admin API  /v1/admin/*

New invariants:

I-NETWORK-001
Public browser commerce requests are same-origin with flexperiment.ru.

I-NETWORK-002
/v1/* is routed exclusively to Hono and is never served by the static export.

I-NETWORK-003
The system does not depend on browser CORS for normal public commerce operation.

I-NETWORK-004
Admin authentication is scoped to admin.flexperiment.ru; its host-only cookie
is never sent to the public site.

7. Public and Admin API

Public API

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

Responses:

Cache-Control: no-store

Ticket:

Authorization: Bearer <raw-capability>

No capability in path/query/cookie/storage.

Admin API [RC.8.1 — consolidated catalogue, extended RC.8.3]

Every admin endpoint referenced elsewhere in this document, gathered in one place so the implementation agent has a complete surface without cross-referencing:

POST /v1/admin/login

# Orders (read)                                        [RC.8.3]
GET /v1/admin/orders
GET /v1/admin/orders/:id

# Occurrences
POST  /v1/admin/occurrences/:id/complete
POST  /v1/admin/occurrences/:id/cancel
PATCH /v1/admin/occurrences/:id                       # material-field edits, §2 "Material revisions"

# Bookings
POST  /v1/admin/bookings/:id/cancel-customer-initiated # §14.1

# Refunds                                               [RC.8.3]
POST /v1/admin/orders/:orderId/refunds                 # admin compensation, booking stays active — §14.3
GET  /v1/admin/refunds
GET  /v1/admin/refunds/:id

# Payment / refund review resolution                    [RC.8.3]
POST /v1/admin/payments/:id/reconcile                  # §14.4 — evidence-based, never a status editor
POST /v1/admin/payments/:id/attach-provider-reference
POST /v1/admin/refunds/:id/reconcile
POST /v1/admin/refunds/:id/attach-provider-reference

# Agents / promoters
POST  /v1/admin/agents
PATCH /v1/admin/agents/:id                             # includes enabled toggle, contractor status
GET   /v1/admin/agents/:id/balances                    # derived balances, §16

# Promo codes
POST  /v1/admin/promo-codes
PATCH /v1/admin/promo-codes/:id                        # status toggle, discount fields

# Reward settlements
POST /v1/admin/reward-settlements                      # Prepare, idempotent — §17.1
POST /v1/admin/reward-settlements/:id/payment-made
POST /v1/admin/reward-settlements/:id/documents-complete
POST /v1/admin/reward-settlements/:id/cancel-before-payment
POST /v1/admin/reward-settlements/:id/recoveries        # settlement_recoveries, §18

# Provider drift
GET  /v1/admin/provider-drift-reviews
POST /v1/admin/provider-drift-reviews/:id/resolve

All admin endpoints sit under the 120 requests/min/session authenticated-admin rate limit (§20) unless a stricter endpoint-specific limit is stated.

8. Checkout context and material/promo revision guard

POST /checkout-context accepts occurrence and optional promo code, without PII or reservation.

Response:

quote_id                 // opaque, TTL 10 minutes
occurrence_id
material_revision
availability
price / discount / final_amount / RUB
promo result              // see §15 for schema/eligibility source
venue disclosure
legal release

Quote snapshots price, promo result, occurrence revision, venue disclosure and legal release.

For a new idempotency key, POST /checkouts must verify, in this order:

1. quote.material_revision == current occurrence.material_revision
2. promo (if any) is still eligible — §15.3          [RC.8.1]

Mismatch on (1):

409 QUOTE_STALE

Mismatch on (2), material revision unchanged:

409 PROMO_NO_LONGER_ELIGIBLE                          [RC.8.1]

Either failure has identical effects:

no order;

no booking/reservation;

no provider command;

frontend fetches a new checkout context;

displays updated date/time/venue and/or updated price/discount;

resets offer, PD consent and eligibility confirmations;

name/email may remain in component state.

Existing same-key idempotent order is returned before either check, because its contractual snapshot already exists (§9, processing order step 4).

Price-only edit that does not increment material revision may continue honoring the unexpired server quote, provided the referenced promo (if any) is still eligible.

9. Checkout idempotency

Request:

quote_id
customer_name
customer_email
eligibility_confirmed=true
offer_accepted=true
pd_consent_accepted=true

Idempotency-Key header

Persist:

checkout_idempotency
--------------------

idempotency_key_hash
canonical_request_hash
order_id
created_at

No expires_at.

Lifecycle:

checkout idempotency lifetime
=
order/evidentiary record lifetime

Key is never intentionally reusable.

Canonical hash includes normalized request fields. Rules:

same key + same payload
→ same order/result
→ no second reservation/payment link

same key + different payload
→ 409 IDEMPOTENCY_CONFLICT

Processing order:

apply coarse request rate limit;

look up idempotency key;

existing same-hash record returns existing result;

existing different hash returns conflict;

only an absent key consumes new-attempt rate quotas;

validate quote material revision, promo eligibility, legal release, capacity (§8);

claim key and create order in one BEGIN IMMEDIATE.

Result mapping:

CREATING / CREATE_UNKNOWN / PENDING / RECONCILING
→ same statusId + PROCESSING

CREATED with usable URL
→ same statusId + original payment URL

PAID
→ same statusId + PAID

CREATE_FAILED / EXPIRED / CANCELLED
→ same terminal result
→ new checkout requires new key

10. Browser checkout-attempt recovery

Before first submit, client writes:

sessionStorage key:
fx_checkout_attempt:v1:<quote_id>

Minimal value:

{
  "version": 1,
  "idempotencyKey": "<128-bit random>",
  "statusId": null
}

Rules:

no name/email, ticket capability, payment URL or legal text in storage;

all reads/writes wrapped for disabled/private storage;

after response, statusId may be added;

reload restores the same idempotency key;

if statusId exists, UI resumes polling;

without statusId, user may re-enter fields, but submit must reuse the same key;

payload mismatch returns IDEMPOTENCY_CONFLICT, never a new order;

unresolved attempt cannot be silently replaced with a new key;

record removed after confirmed terminal PAID|FAILED;

explicit restart requires a terminal server result or support/manual resolution;

localStorage is not used;

when a new quote is fetched after QUOTE_STALE/PROMO_NO_LONGER_ELIGIBLE, the client writes a new fx_checkout_attempt:v1:<new_quote_id> entry; the stale-quote entry is simply abandoned (different key, no conflict) and is cleared naturally on tab close — no explicit cleanup is required for correctness.

If sessionStorage is unavailable, the key remains in memory and the UI warns against reload while submission is unresolved; server idempotency still protects same-key retries within the page lifetime.

11. Capacity and payment

Occupied capacity:

booking IN (RESERVED, CONFIRMED)

Capacity below occupancy:

409 CAPACITY_BELOW_OCCUPANCY

Payment creation:

CREATING
CREATED
CREATE_UNKNOWN
CREATE_FAILED

Payment:

PENDING
RECONCILING
PAID
PARTIALLY_REFUNDED
REFUNDED
EXPIRED
CANCELLED
REVIEW_REQUIRED

Timing:

PAYMENT_LINK_TTL_MINUTES=20
PAYMENT_RECONCILIATION_GRACE_MINUTES=10
PAYMENT_CREATION_HTTP_TIMEOUT_SECONDS=20
PAYMENT_CREATION_STALE_SECONDS=120

Persist:

creation_started_at
provider_request_started_at

PENDING/RECONCILING occupy capacity while the occurrence is scheduled. Terminal occurrence cancels entitlement but not financial reconciliation.

Approved side effects — entitlement gate [RC.8.2 — revised, checks booking state, not just occurrence state]:

occurrence SCHEDULED AND booking RESERVED
→ booking CONFIRMED
→ ticket/reward/email

occurrence COMPLETED/CANCELLED
→ booking remains CANCELLED
→ no ticket/reward
→ full-refund obligation (§4, OCCURRENCE_CANCELLED / LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE)

booking already CANCELLED for any other reason, occurrence still SCHEDULED
→ booking remains CANCELLED
→ no ticket/reward
→ full-refund obligation (§4, LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION)

A late APPROVED may create entitlement (CONFIRMED booking + ticket + reward) only when the booking is still RESERVED at the moment of approval. Booking state is checked explicitly, not inferred from occurrence state — the two can diverge whenever Admin cancels a booking (§14.1) while the occurrence itself remains SCHEDULED and the payment is still in flight (PENDING/RECONCILING/CREATING). Without this check, a customer who was refunded by cancellation could have their booking silently resurrected by a payment the provider approves afterward. This generalizes the race guard §3/§11 already applied to terminal-occurrence cancellation to booking-level cancellation as well.

12. Universal crash recovery

stale CREATING   → CREATE_UNKNOWN
stale SUBMITTING → SUBMIT_UNKNOWN
stale SENDING    → SEND_UNKNOWN

Persist timestamps/leases for payment creation, refund submission and email delivery (§19).

Startup and a singleton worker every 30 seconds perform recovery transitions. No direct external-command retry from stale state.

13. Tochka webhook and public status

Webhook:

raw text/plain JWT;

RS256/current key;

event type;

customer/merchant identity;

operation/paymentLink IDs;

amount/payment type;

currency when present, otherwise RUB contract;

whitelisted decoded fields + raw hash;

semantic idempotency.

Invalid signature/malformed input: 401/400, no mutation.

Valid signed mismatch: quarantine/review, no paid side effects.

Valid approval repairs creation, records PAID truth and branches by occurrence state.

Success URL:

/payment/success?order=<128-bit-status-id>

Status:

PROCESSING
PAID
FAILED

Success UI states only that payment was received and instructions were sent by email; it does not unconditionally claim confirmed attendance.

Status polling contract [RC.8.1]

Rate limit (revised, §20):

checkout status: 60 / min / IP; 20 / min / statusId

Client polling schedule, binding for the success-page implementation:

initial poll:      3s after page load
subsequent polls:  every 6s while status = PROCESSING
after 60s elapsed:  back off to every 10–15s
stop polling:       on any terminal status (PAID | FAILED), or after 10 minutes elapsed (show manual "check email" fallback)

At the specified cadence, worst case is ~11 requests/min for the first minute then ~4–6/min after — comfortably under the 20/min/statusId ceiling with headroom for a user opening the page in two tabs.

14. Refund semantics

Refund states:

REQUESTED
SUBMITTING
SUBMIT_UNKNOWN
RECONCILING
SUCCEEDED
FAILED
REVIEW_REQUIRED

These states are persisted on a refunds row (§14.2) — they are not free-floating labels. Every provider refund command in this document, whichever domain event triggers it (refund obligation, admin compensation), is one row in that table moving through this state machine.

one nonterminal provider refund per payment (nonterminal = REQUESTED/SUBMITTING/SUBMIT_UNKNOWN/RECONCILING; REVIEW_REQUIRED blocks new refund attempts on that payment until resolved, §14.4);

in-flight + succeeded <= captured;

response loss → SUBMIT_UNKNOWN;

no blind retry — SUBMIT_UNKNOWN recovery follows the same provider-lookup-before-resubmit discipline as §12/§19, using the refund's own idempotency key.

Customer cancellation:

booking CANCELLED
ticket VOID
capacity released
reward zero
partial money refund only for documented actual expenses

See §14.1 for the Admin contract and §14.2 for how its obligation is actually fulfilled as a refunds row.

Compensation keeps booking active and recalculates reward. See §14.3 for the Admin contract — this is deliberately a separate endpoint from cancellation, never a cancel_booking flag on a refund call.

Organizer cancellation targets full captured refund (§3, §4).

14.1 Customer-cancellation Admin contract [RC.8.1]

v1 has no customer self-service portal (§7 public API has no authenticated customer session), so customer-initiated cancellation is always executed by Admin on the customer's behalf after support contact.

POST /v1/admin/bookings/:id/cancel-customer-initiated
Idempotency-Key: <uuid>

Payload [RC.8.2 — server derives the refund, Admin only enters what is withheld]:

reason
confirmation_text = "CANCEL <bookingId>"

withheld_expense_amount_kopecks   // optional, default 0 — see requirement below
expense_justification             // required together with any nonzero withheld amount
evidence_reference                // required together with any nonzero withheld amount

The endpoint never accepts a refund amount directly. Admin states what was actually, demonstrably spent and kept; the refund target is always computed by the server as captured_amount − withheld_expense_amount_kopecks, so an accidental or unauthorized arbitrary partial refund is not representable.

Requires:

booking is RESERVED or CONFIRMED;

occurrence is SCHEDULED (a terminal occurrence's bookings are handled by §3/§4, not this endpoint);

withheld_expense_amount_kopecks must be 0/omitted unless the booking's payment is currently PAID — before capture there is no captured amount to withhold expenses against, and no obligation is created yet (see below);

when payment is PAID: 0 <= withheld_expense_amount_kopecks <= captured_amount, and expense_justification + evidence_reference are required whenever the withheld amount is nonzero.

Effects, in one BEGIN IMMEDIATE:

booking            → CANCELLED
ticket             → VOID
capacity           → released
reward             → zero

Refund obligation, branched on the payment's status at the moment of cancellation:

payment already PAID:
  target = captured_amount − withheld_expense_amount_kopecks
  upsert refund_obligations:
    initial_source = CUSTOMER_CANCELLATION_PARTIAL
    target_refunded_amount_kopecks = target

payment not yet PAID (PENDING / RECONCILING / CREATING):
  no obligation is created now — nothing has been captured to refund.
  If the provider later approves the payment anyway, §11's entitlement gate keeps
  the booking CANCELLED, and a LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION obligation
  (§4) is created at that point instead, for the full captured amount.

The upsert uses the same max-rule as every other obligation source, so a later organizer cancellation of the same occurrence correctly supersedes any partial target with the full captured amount. The obligation itself is a target/ledger row, not a provider command — fulfilling it is the worker's job, executed as a refunds row (§14.2) with source = REFUND_OBLIGATION.

Idempotency: same key + same payload replays the existing terminal result; same key + different payload returns 409 IDEMPOTENCY_CONFLICT; consistent with the checkout and settlement-prepare idempotency pattern (§9, §17.1) — a booking_cancellation_idempotency record keyed by (idempotency_key_hash, canonical_request_hash) bound to the booking's cancellation event, no expiry.

14.2 Persistent refund command record [RC.8.3]

The refund states in §14 were previously specified with no backing table, leaving the implementation agent to invent one. This is the actual contract:

refunds
-------
id
public_id
order_id
payment_id

amount_kopecks
reason
note

source:
  ADMIN_COMPENSATION       // §14.3, booking stays active
  REFUND_OBLIGATION        // §4, worker-driven, booking already cancelled/void

status:
  REQUESTED
  SUBMITTING
  SUBMIT_UNKNOWN
  RECONCILING
  SUCCEEDED
  FAILED
  REVIEW_REQUIRED

idempotency_key_hash
canonical_request_hash

provider_reference
provider_observed_total_refunded

submission_started_at
attempts
last_reconcile_at
last_error

created_at
succeeded_at
failed_at

Rules, formalizing what §14/§4 already state in prose:

one nonterminal refund per payment_id
  (partial-unique constraint over status IN
   (REQUESTED, SUBMITTING, SUBMIT_UNKNOWN, RECONCILING))

sum(SUCCEEDED.amount_kopecks) + current in-flight amount <= captured_amount for payment_id

same idempotency key + same canonical payload
→ existing refund row returned, current status

same key + different payload
→ 409 IDEMPOTENCY_CONFLICT

SUBMIT_UNKNOWN
→ same crash-recovery discipline as §12/§19: query the provider by
  provider_reference/idempotency key before ever resubmitting; never blind-retry

ADMIN_COMPENSATION rows are created directly by §14.3 with an Admin-supplied Idempotency-Key.

REFUND_OBLIGATION rows are created by the same worker that owns refund_obligations (§4): for each OPEN/FULFILLING obligation with outstanding = target_refunded_amount_kopecks − sum(SUCCEEDED refunds for that payment), if outstanding > 0 and no nonterminal refund exists for that payment, create one refunds row with amount_kopecks = outstanding. The obligation's own idempotency (UNIQUE(payment_id), §4) plus "no nonterminal refund per payment" together make this safe to run repeatedly without ever creating a second in-flight refund for the same payment.

A SUCCEEDED refunds row decreases net captured for that payment; reward recalculation (§16) and any reward_adjustments entries are derived from net captured, never from the raw captured amount.

14.3 Admin compensation refund [RC.8.3]

For the case §14 describes as "compensation keeps booking active" — a partial refund with no cancellation, e.g. goodwill compensation for an inconvenience.

POST /v1/admin/orders/:orderId/refunds
Idempotency-Key: <uuid>

Payload:

amount_kopecks
reason
note   // optional

There is deliberately no cancel_booking field — this endpoint can never cancel a booking, void a ticket, or release capacity. An admin who wants those effects must use §14.1 instead, which computes its own refund target server-side. Keeping the two endpoints separate removes the previously possible "arbitrary refund amount + cancelBooking=true" shape entirely — it is not representable in either contract.

Requires:

payment for the order is PAID (or PARTIALLY_REFUNDED);

amount_kopecks > 0;

amount_kopecks <= captured_amount − sum(SUCCEEDED refunds) − current in-flight refund amount for that payment.

Effects:

booking   unchanged (stays CONFIRMED)
ticket    unchanged (stays VALID)
capacity  unchanged

create refunds row:
  source = ADMIN_COMPENSATION
  status = REQUESTED
→ standard refund state machine (§14.2) drives it to SUCCEEDED/FAILED/REVIEW_REQUIRED
→ on SUCCEEDED: net captured decreases, reward recalculated (§16, append-only reward_adjustments)

14.4 Review resolution — evidence-based, never a status editor [RC.8.3]

REVIEW_REQUIRED (on payments, §11, and on refunds, §14.2) exists because provider evidence was ambiguous. This section is how it gets resolved. It does not reopen the "no generic financial status editor" rule (§23) — there is no endpoint that sets status = PAID or status = SUCCEEDED directly.

POST /v1/admin/payments/:id/reconcile
POST /v1/admin/refunds/:id/reconcile

Effect: queries Tochka for the current provider-side truth for that payment/refund, persists the observed evidence (provider_observed_total_refunded for refunds; the payment-side equivalent for payments), and transitions state only if the provider evidence itself proves the result (e.g. a provider-confirmed SUCCEEDED refund with matching amount/currency). If the evidence remains ambiguous or absent, the row stays REVIEW_REQUIRED and the call is a safe no-op beyond recording the observation.

POST /v1/admin/payments/:id/attach-provider-reference
POST /v1/admin/refunds/:id/attach-provider-reference

Payload:

provider_reference
observed_operation
amount_kopecks
currency
reason / note

Effect: records the admin-supplied evidence (e.g. a provider dashboard reference an admin found manually) as provider_reference, tagged with admin identity and timestamp per the audit trail (§23), then immediately re-runs the same reconciliation as .../reconcile. This is evidence attachment, not a status write — the subsequent reconciliation step is what may transition state, and only when the now-attached evidence proves it.

New invariant:

I-REFUND-003
Every provider refund command is one row in the refunds table (§14.2); there is
no other, unspecified path to submitting a refund to the provider.

I-REFUND-004
REVIEW_REQUIRED on a payment or refund can only be resolved by provider evidence
(§14.4 reconcile / attach-provider-reference), never by a direct status write.

15. Professional promoters, promo codes and attribution

15.1 Agent (promoter)

agents
------
id
slug
display_name
legal_name
email
contractor_type:
  SELF_EMPLOYED
  INDIVIDUAL_ENTREPRENEUR
inn
contract_reference
enabled

default_reward_type   PERCENT | FIXED     // [RC.8.1]
default_reward_value  // basis points for PERCENT, kopecks for FIXED   // [RC.8.1]

npd_status_checked_at
created_at
updated_at

Ordinary paid individuals are prohibited — contractor_type has no third value.

enabled=false:

blocks attribution for orders created after disable;

does not invalidate frozen attribution/reward;

does not block historical settlement;

derived-cascades to that agent's promo codes (§15.3) without mutating them.

If current supported contractor status is absent:

CONTRACTOR_STATUS_REVIEW

Reward remains but settlement is blocked.

15.2 Promo codes [RC.8.1 — restored from RC.7]

promo_codes
-----------
id
agent_id nullable          // promo may exist without a promoter
code
normalized_code UNIQUE
status              ACTIVE | DISABLED

discount_type       NONE | PERCENT | FIXED
discount_value

created_at
updated_at

Rules:

normalized_code immutable
disabled promo cannot enter a new order
promo may exist without a promoter

15.3 Promo/agent eligibility — derived, not cascaded [RC.8.1]

promo eligible for a new order =
  promo.status = ACTIVE
  AND (
    promo.agent_id IS NULL
    OR linked_agent.enabled = true
  )

A promo linked to a promoter requires both promo.status = ACTIVE and agent.enabled = true.

A promo with agent_id IS NULL is independent of any agent's enabled state.

Disabling an agent never writes to promo_codes. Eligibility is computed at read time (checkout-context, checkout order-creation revalidation). Re-enabling the agent makes its ACTIVE promos eligible again automatically, with no separate reactivation step.

To permanently kill a promoter's discount independent of the promoter's enabled state, Admin disables the promo code itself (status = DISABLED), not the agent.

Quote became ineligible between checkout-context and checkouts (agent disabled, or promo disabled) → 409 PROMO_NO_LONGER_ELIGIBLE (§8), same no-order/no-reservation/no-provider-command contract as QUOTE_STALE.

New invariants:

I-PROMO-001
A promo linked to a professional promoter is eligible for a new order
only while both the promo and the linked promoter are enabled.

I-PROMO-002
Disabling a promoter never mutates historical orders or the persisted
status of its promo codes.

15.4 Attribution

fx_ref=v1:<professional-promoter-slug>

functional first-party marker;

30-day last eligible touch;

explicit eligible promo overrides;

invalid/disabled touch does not erase a prior valid marker;

frozen at order creation.

Promo-vs-attribution priority [RC.8.1, made explicit]:

if promo.agent_id is not NULL and promo is eligible:
    attributed_agent_id = promo.agent_id       // promo overrides fx_ref
elif fx_ref marker is present and its agent is eligible:
    attributed_agent_id = fx_ref agent
else:
    attributed_agent_id = NULL

A promo with agent_id IS NULL (pure discount code) never changes attribution; it only affects price.

15.5 Order snapshot [RC.8.1 — restored from RC.7]

Every order persists, frozen at creation, independent of later agent/promo edits:

attributed_agent_id

reward_type_snapshot
reward_value_snapshot

promo_code_snapshot
discount_type_snapshot
discount_value_snapshot

reward_type_snapshot/reward_value_snapshot are copied from the attributed agent's default_reward_type/default_reward_value at order-creation time. All later reward calculation (§16) uses these snapshots, never a live join to agents.

Consumer referral credits remain post-launch (unchanged from RC.8).

16. Reward derived balances

Append-only:

referral_rewards
reward_adjustments

Calculation, using the order's own snapshots (§15.5):

PERCENT = net captured × reward_value_snapshot (basis points), half-up
FIXED   = min(reward_value_snapshot, net captured)
CANCELLED booking = reward zero

No global reward status.

Derived per promoter/occurrence:

earned_total
accrued_total
payable_gross_total
blocked_payable_total
prepared_total
pending_document_total
settled_total
externally_recovered_total
late_adjustment_exposure

blocked_payable_total means:

financially matured reward currently forbidden from settlement because of contractor/legal review, excluding amounts already reserved or paid.

Intermediate:

unallocated_matured_total =
  max(
    0,
    payable_gross_total
    - prepared_total
    - pending_document_total
    - settled_total
    + externally_recovered_total
  )

blocked_payable_total =
  min(
    unallocated_matured_total,
    amount currently blocked by contractor/legal review
  )

Final:

available_to_settle =
  max(
    0,
    payable_gross_total
    - blocked_payable_total
    - prepared_total
    - pending_document_total
    - settled_total
    + externally_recovered_total
  )

This avoids double-counting already allocated settlements. available_to_settle is scoped per (agent, occurrence), matching the derived-balance grain above.

17. Manual settlement state machine

PREPARED
   ├──→ PENDING_DOCUMENT
   │       └──→ SETTLED
   └──→ CANCELLED_BEFORE_PAYMENT

No other transitions.

17.1 Prepare — idempotent [RC.8.1]

Admin selects promoter, occurrence, amount and method.

POST /v1/admin/reward-settlements
Idempotency-Key: <uuid>

Canonical payload (hashed for the idempotency record):

agent_id
occurrence_id
amount_kopecks
method

Persist:

reward_settlement_idempotency
------------------------------
idempotency_key_hash
canonical_request_hash
settlement_id
created_at

No expires_at — same lifetime rule as checkout idempotency (§9): the binding lives for the settlement record's evidentiary lifetime.

Rules [RC.8.2 — replay returns current status, not just PREPARED]:

same key + same payload
→ existing settlement returned, in whatever status it currently holds
   (PREPARED, PENDING_DOCUMENT, SETTLED or CANCELLED_BEFORE_PAYMENT)
→ no new row, ever

same key + different payload
→ 409 IDEMPOTENCY_CONFLICT

The idempotency binding lives for the settlement's full evidentiary lifetime (no expires_at, same rule as §9), so it keeps applying after the settlement progresses past PREPARED. A retried Prepare call for a settlement that has since moved to PENDING_DOCUMENT or SETTLED must not error and must not require the settlement to still be PREPARED — it simply returns the current record.

Processing order, all in one BEGIN IMMEDIATE:

look up idempotency key;

existing same-hash record returns the existing settlement, current status;

existing different-hash record returns 409 IDEMPOTENCY_CONFLICT;

only an absent key proceeds to validation;

validate: occurrence completed, supported contractor status, no blocking financial review, amount_kopecks <= available_to_settle;

claim key, create PREPARED, amount enters prepared_total — commit before money is transferred.

This closes the double-click/network-retry gap: two concurrent requests with the same key can create at most one PREPARED row, regardless of available_to_settle at the time of either request.

PREPARED fields:

prepared_at
method
amount_kopecks
prepared_by_admin_id

Payment made

After external CASH/TRANSFER:

PREPARED → PENDING_DOCUMENT
payment_made_at = server time

Requires explicit confirmation:

"I confirm the money was transferred"

Documents complete

For NPD, require status check for payment date and receipt reference.

PENDING_DOCUMENT → SETTLED

Cancel before payment

Allowed only from PREPARED:

PREPARED → CANCELLED_BEFORE_PAYMENT

Requires:

confirmation_text = "NOT PAID <settlementId>"
reason

Means no money was transferred and releases the prepared allocation.

Prohibited when payment may have occurred. If uncertain, leave PREPARED and open manual review.

Stale prepared intent

SETTLEMENT_PREPARED_REVIEW_MINUTES=30

After threshold:

no automatic state change;

no allocation release;

Admin alert/manual review;

no new settlement may consume its reserved amount.

18. Settlement records, corrections and recoveries

reward_settlements
------------------

id
agent_id
occurrence_id
amount_kopecks
method

status:
  PREPARED
  PENDING_DOCUMENT
  SETTLED
  CANCELLED_BEFORE_PAYMENT

contractor_type_snapshot

prepared_at
payment_made_at
settled_at
cancelled_before_payment_at

npd_status_checked_at
npd_status_effective_on

document_confirmed
document_reference
document_confirmed_at

note
created_by_admin_id

Multiple partial settlements allowed; total active allocation cannot exceed the payable balance.

Metadata corrections are append-only and never affect allocation.

Actual money recovery:

settlement_recoveries
---------------------

settlement_id
amount_recovered_kopecks
recovered_at
method
evidence_reference
note

Only evidenced actual recovery increases externally_recovered_total.

Generic VOID/financial reversal is prohibited.

19. Email outbox and crash recovery [RC.8.1 — restored/specified]

email_outbox
------------
id
type:
  TICKET
  MATERIAL_CHANGE
  OCCURRENCE_CANCELLED
  LATE_PAYMENT_CANCELLED
  BOOKING_CANCELLED
  REFUND_SUCCEEDED
  PROMOTER_CONVERSION

recipient_email                // [RC.8.2] raw address — operational PII, never logged, needed to actually send
recipient_email_hash           // keyed HMAC, safe for logs/correlation/rate-limit keys

template
payload_ref                    // FK to the source record, valid only when every referenced field is itself immutable/append-only
payload_snapshot                // [RC.8.2] JSON snapshot of template variables at enqueue time — required whenever any referenced field is mutable (e.g. agent.display_name/legal_name); payload_ref alone is insufficient there

status:
  PENDING
  SENDING
  ACCEPTED
  SENT
  DELIVERED
  BOUNCED
  SEND_UNKNOWN
  FAILED

provider_idempotence_key       // [RC.8.2] stable, generated once at enqueue; sent unchanged on every provider send attempt for this row
job_id nullable                 // Unisender-side send/job identifier, recorded once a response is received

lease_owner                    // worker/process id holding the send lease
lease_expires_at

send_started_at
provider_request_started_at
attempts
last_error

created_at
sent_at
delivered_at
bounced_at

Recipient and payload are snapshotted at enqueue time, not resolved from a live join at send time — an edit to the source record (e.g. an agent's display name) between enqueue and send must not change what an already-created transactional email says.

Crash recovery follows the universal pattern (§12):

stale SENDING (lease_expires_at passed, no terminal status)
→ SEND_UNKNOWN

[RC.8.2 — corrected] The absence of a locally recorded job_id does not prove the provider request was never dispatched: the HTTP request can succeed at Unisender while the response — and therefore the job_id — is lost to the crash before it is persisted. Treating "no job_id" as "safe to resend" reproduces exactly the blind-retry-on-crash bug that CREATE_UNKNOWN/SUBMIT_UNKNOWN recovery (§12) exists to prevent. Email recovery is brought into line with that same discipline:

SEND_UNKNOWN + job_id recorded
→ query Unisender by job_id
→ reconcile to the real terminal status (ACCEPTED/SENT/DELIVERED/BOUNCED/FAILED)

SEND_UNKNOWN + no job_id recorded
→ ambiguous, NOT proven unsent
→ if Unisender exposes a lookup by provider_idempotence_key or outbox metadata
  (Phase 0 gate, below), query it first and reconcile if found
→ otherwise, resend is permitted, but only using the SAME provider_idempotence_key
  recorded at enqueue — relying on Unisender-side idempotent-send deduplication to
  suppress the duplicate if the original request had in fact been dispatched
→ a duplicate send remains possible in the worst case; this is an accepted
  at-least-once guarantee, not exact-once delivery

I-EMAIL-001
Outbox delivery is at-least-once with best-effort duplicate suppression via a
stable provider_idempotence_key per outbox row. Exact-once email delivery is not
guaranteed, and "no job_id recorded" is never treated as proof that a send did
not happen.

Types include ticket, material change, occurrence cancellation, late-payment cancellation, booking cancellation, refund success and promoter conversion.

Promoter email contains no customer PII.

20. Endpoint rate limits and abuse controls

All limits use trusted proxy-derived client IP. Untrusted X-Forwarded-For is ignored. Email keys are stored as keyed HMAC, never raw.

Responses:

429 Too Many Requests
Retry-After: <seconds>

Limits

Endpoint

Limit

POST /admin/login

5 attempts / 15 min / IP; 20 / 24 h / IP

authenticated Admin API

120 requests / min / session

referral eligibility

60 / min / IP; 20 / min / slug

checkout context

30 / min / IP; 120 / 10 min / occurrence

checkout coarse requests

20 / min / IP

new checkout keys

3 / 10 min / IP

new checkout keys

2 / 30 min / email-HMAC + occurrence

new reservations

60 / 10 min / occurrence

checkout status

60 / min / IP; 20 / min / statusId (raised from 10, RC.8.1 — see §13 polling contract)

ticket endpoint

20 / min / IP; 5 / min / capability hash

public tour/occurrence GET

120 / min / IP

invalid webhook traffic

120 / min / IP

total webhook traffic ceiling

600 / min / IP; alert before rejection

Existing same-key checkout retries do not consume new-key/reservation quotas, but remain subject to the coarse request limit. The same rule applies to same-key settlement-prepare retries (§17.1) against the authenticated-admin session limit.

Webhook controls:

strict method/content-type;

64 KiB body maximum;

cheap format/algorithm checks before signature;

valid signed provider callbacks use the high ceiling;

provider IP allowlisting only if Phase 0 confirms stable official ranges.

Additional alerts:

unusual RESERVED-to-PAID ratio;

repeated checkout creation by email/occurrence;

occurrence reservation burst;

rate-limit saturation.

No CAPTCHA/fraud platform in v1.

21. Analytics

fx_consent=v1:a0|a1

No Metrika script/import/request before a1. Webvisor off, IP masking on, no customer/promoter PII.

Checkout attempt uses versioned sessionStorage; analytics preference uses its existing versioned functional marker. Ticket capability uses neither.

22. Ticket capability

Email URL:

https://flexperiment.ru/ticket#<raw-capability>

Browser:

read fragment
→ keep capability in memory
→ history.replaceState(..., "/ticket")
→ GET /v1/public/ticket
  Authorization: Bearer <capability>

capability never enters HTTP URL, cookie or persistent storage;

Authorization is excluded from proxy/app/APM logs;

ticket response uses no-store and no-referrer;

no service-worker cache;

no SWR key containing capability;

cancellation makes the ticket VOID;

DB stores capability hash plus AES-256-GCM ciphertext/nonce/key version.

23. Security and operations

Admin:

singleton;

scrypt password;

12-hour host-only HttpOnly Secure SameSite=Strict session, scoped to admin.flexperiment.ru (§6);

exact Origin;

JSON/body limits;

immutable audit;

no generic financial status editor.

Headers:

CSP
nosniff
no-referrer
frame-ancestors 'none'
HSTS

Logs redact:

customer/promoter email and INN where possible;

Authorization;

raw JWT/cookies;

ticket capability/ciphertext;

session/provider secrets.

Health:

/healthz
/readyz

Readiness checks DB, migrations, city mirror, legal release, ticket crypto and runtime webhook config — not live providers.

Backups:

consistent encrypted SQLite;

approved Russian off-VPS storage;

separate ticket-key backup;

7 daily/4 weekly/3 monthly;

restore drill including ticket decryption.

Alerts additionally cover stale PREPARED, rate-limit saturation, refund obligations, contractor review and late reward exposure.

24. Provider drift

Daily singleton worker reconciles relevant local payment/refund facts with Tochka.

Mismatch creates review/alert and never silently rewrites history.

Manual promoter settlements remain outside Tochka reconciliation.

25. Implementation sequence

Phase 0: Tochka/Unisender spikes; provider/legal/retention matrices; promoter and cash/transfer procedures.

Phase 1: runtime, SQLite, Docker, reverse-proxy network boundary (§6), security, rate-limit framework, health and stale-command recovery.

Phase 2: cities, occurrences, venue and terminal status guards.

Phase 3: static city/legal/ticket routes and live commerce islands.

Phase 4: legal releases, Offer/Privacy/Consent, participant and cancellation terms.

Phase 5: capacity, material revisions and change notifications.

Phase 6: quotes, QUOTE_STALE, orders, permanent idempotency and session attempt recovery.

Phase 7: payments, webhook, reconciliation and public status (incl. polling-cadence-aligned status endpoint).

Phase 8: ticket bearer transport and encryption.

Phase 9: email outbox/recovery (§19).

Phase 10: refunds command model (§14.2), unique obligations, customer-initiated cancellation (§14.1), admin compensation refund (§14.3), review resolution (§14.4) and terminal occurrence actions.

Phase 11: professional promoters, promo codes (§15), attribution and derived reward balances.

Phase 12: PREPARED settlements (idempotent, §17.1), documents, corrections, recoveries and reviews.

Phase 13: Metrika consent bootstrap.

Phase 14: provider drift, backups, alerts, abuse testing and launch runbook.

26. Release-blocking tests (self-contained) [RC.8.1]

This section is the complete, self-contained list of release blockers. It replaces "all RC.7 blockers remain required."

Settlement crash recovery

PREPARED is committed before external payment;

prepared amount immediately leaves available balance;

crash/reload after cash but before confirmation cannot reopen allocation;

stale PREPARED alerts but never auto-releases;

only CANCELLED_BEFORE_PAYMENT from PREPARED releases amount;

cancellation requires exact strong confirmation;

PENDING_DOCUMENT can never become cancelled-before-payment;

only evidenced recovery releases actually paid money;

[RC.8.1] double-click/retried Prepare with the same Idempotency-Key creates exactly one PREPARED row, never two, under concurrent execution;

[RC.8.1] Prepare with the same key and a different payload returns 409 IDEMPOTENCY_CONFLICT and creates no row.

Balances

blocked amount excluded from available;

prepared/pending/settled amounts each excluded exactly once;

recoveries included exactly once;

partial settlements maintain correct balances;

property tests prove balances never allow over-allocation;

[RC.8.1] reward calculation uses only the order's frozen reward_type_snapshot/reward_value_snapshot, never a live join, even after the agent's default_reward_type/default_reward_value changes post-order.

Idempotency and refresh

idempotency row has no expiry;

same key remains bound for order evidence lifetime;

session reload reuses the same key;

no PII stored in checkout attempt;

unresolved attempt cannot silently generate a new key;

same key/different payload returns conflict;

concurrent requests create one order/provider command.

Quote, promo and material revision

material edit invalidates an unused quote;

QUOTE_STALE creates no order/reservation/payment;

frontend displays new conditions and resets confirmations;

retry for an already-created idempotent order still returns the original result;

[RC.8.1] disabling a promo (directly, or via its agent being disabled) between checkout-context and checkouts returns 409 PROMO_NO_LONGER_ELIGIBLE with no order/reservation/payment;

[RC.8.1] re-enabling a disabled agent makes its ACTIVE promo codes eligible again with no separate promo-side action, and does not alter promo_codes.status;

[RC.8.1] a promo with agent_id IS NULL remains eligible regardless of any agent's enabled state.

Refund obligation

DB enforces one obligation per payment;

cancellation/webhook/worker race results in one row;

target amount only increases;

multiple reasons create events, not competing obligations;

[RC.8.1] CUSTOMER_CANCELLATION_PARTIAL obligation is correctly superseded (max-rule) by a later OCCURRENCE_CANCELLED obligation on the same payment;

[RC.8.2] a booking cancelled before capture, followed by a late APPROVED, creates exactly one LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION obligation for the full captured amount, and no ticket/reward;

[RC.8.2] CUSTOMER_CANCELLATION_PARTIAL target always equals captured_amount − withheld_expense_amount_kopecks, never an independently admin-entered figure;

[RC.8.3] the worker never creates a second nonterminal refunds row for the same payment when re-run concurrently against the same open obligation (UNIQUE(payment_id) on refund_obligations + "one nonterminal refund per payment" on refunds together suffice).

Refund command model [RC.8.3]

an admin-compensation refund (§14.3) leaves booking CONFIRMED and ticket VALID on SUCCEEDED, and on any other terminal/nonterminal status;

POST /orders/:orderId/refunds has no field capable of cancelling a booking, voiding a ticket, or releasing capacity — verified by payload schema, not just by documentation;

two concurrent admin-compensation refund requests with the same Idempotency-Key create exactly one refunds row;

amount_kopecks exceeding captured − succeeded − in-flight is rejected before any provider call;

a refunds row in SUBMIT_UNKNOWN is never blindly resubmitted — recovery queries the provider by the refund's own idempotency key/provider_reference first;

REVIEW_REQUIRED on a payment or refund is resolved only by .../reconcile or .../attach-provider-reference producing provider evidence that proves the result — no endpoint accepts a direct status write, tested by asserting no route exists that sets status from request input.

Booking and abuse

booking enum contains only reserved/confirmed/cancelled;

terminal occurrence late payment never creates ticket/reward;

checkout rate limits prevent repeated reservation creation;

same-key retry is not misclassified as new attempt;

rate-limit keys contain no raw email;

trusted proxy handling cannot be spoofed;

valid webhook retry remains accepted under normal provider load;

[RC.8.1] the success-page polling schedule (§13) never triggers its own 429 against the 20/min/statusId limit under the documented cadence, including two tabs open simultaneously;

[RC.8.2] a late APPROVED for a booking that is no longer RESERVED (cancelled via §14.1 while its occurrence was still SCHEDULED) never transitions the booking to CONFIRMED and never creates a ticket or reward, under a concurrent cancel/webhook race.

Network boundary

[RC.8.1] public commerce requests from the static frontend succeed with no CORS headers present (same-origin);

[RC.8.1] /v1/* is unreachable from the static export build output — no static route shadows a backend path;

[RC.8.1] the Admin session cookie set on admin.flexperiment.ru is never sent on a request to flexperiment.ru.

Email outbox

[RC.8.1] stale SENDING (lease expired, no terminal status) transitions to SEND_UNKNOWN on worker sweep;

[RC.8.1] SEND_UNKNOWN recovery queries Unisender by job_id when one was recorded, and never blindly re-sends when a job_id exists;

[RC.8.2 — corrected] SEND_UNKNOWN with no job_id recorded is treated as ambiguous, never as proven-unsent — the test asserts a resend in that case reuses the exact provider_idempotence_key from the original enqueue, not a freshly generated one;

[RC.8.2] every provider send call is made with recipient_email and template variables resolved from the outbox row's own recipient_email/payload_snapshot, never from a live join to a source record that could have changed since enqueue.

Settlement idempotency

[RC.8.2] a retried Prepare call (same key, same payload) against a settlement that has since moved to PENDING_DOCUMENT or SETTLED returns that current record without error and without creating a second row.

Customer cancellation

[RC.8.1] cancel-customer-initiated is idempotent — same key/same payload replays, same key/different payload conflicts;

[RC.8.1] it is rejected for a booking on a terminal (COMPLETED/CANCELLED) occurrence;

[RC.8.2 — revised] withheld_expense_amount_kopecks above the captured amount is rejected, and any nonzero value is rejected outright when the payment is not yet PAID;

[RC.8.2] the computed refund target for a PAID cancellation always equals captured_amount − withheld_expense_amount_kopecks, verified independently of whatever value Admin might attempt to pass as a raw refund figure (the field does not exist in the payload).

Decisions changed from RC.8

promo_codes schema, agent reward-config defaults and order-level reward/promo snapshots restored.

PREPARED settlement creation made idempotent.

Promo eligibility re-validated at order creation, same processing slot as material-revision guard.

Promo/agent disable specified as derived eligibility, never a promo_codes status mutation.

Public network boundary specified: same-origin, /v1/* reverse-proxied, no CORS; admin.flexperiment.ru as a second same-origin pair.

Email outbox schema with lease/job_id crash recovery specified.

Customer-initiated cancellation given an explicit idempotent Admin endpoint, wired to a new CUSTOMER_CANCELLATION_PARTIAL refund-obligation source.

Checkout-status polling cadence specified; per-statusId rate limit raised 10 → 20/min.

Consolidated Admin API catalogue and self-contained release-blocker list added; "RC.7 blockers remain required" removed.

Decisions changed from RC.8.1 (RC.8.2 corrective patch)

§11's entitlement gate now checks booking state (RESERVED), not just occurrence state, before letting a payment approval create a CONFIRMED booking/ticket/reward.

New refund-obligation source LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION (full captured amount) covers a booking cancelled before its payment captured, then approved late.

§14.1's payload replaces admin-entered refund_amount_kopecks with withheld_expense_amount_kopecks; the refund target is always server-derived as captured − withheld, and withholding is only accepted once the payment is PAID.

Email outbox gains recipient_email (raw) and payload_snapshot, alongside the existing hash — the worker can now actually send.

Email outbox gains provider_idempotence_key; SEND_UNKNOWN with no locally recorded job_id is treated as ambiguous (at-least-once, best-effort dedup), never as proof-of-unsent, correcting a blind-resend rule that contradicted the document's own §12 crash-recovery discipline.

§17.1 Prepare-idempotency replay returns the settlement's current status (not only PREPARED), so a retried Prepare call after the settlement has since progressed to PENDING_DOCUMENT/SETTLED still replays cleanly.

Decisions changed from RC.8.2 (RC.8.3 corrective patch)

Refund states (§14) are now backed by a persistent refunds table (§14.2), with the same idempotency/nonterminal-per-payment/no-blind-retry discipline used everywhere else in the document.

New Admin endpoint POST /v1/admin/orders/:orderId/refunds (§14.3) covers ordinary compensation — booking stays CONFIRMED, ticket stays VALID — deliberately separate from §14.1 cancellation, with no cancel_booking field in either contract.

The refund_obligations worker (§4) is now specified to fulfill an obligation by creating a refunds row with source = REFUND_OBLIGATION, closing the "worker creates at most one next provider refund command" line that previously named no concrete mechanism.

REVIEW_REQUIRED on a payment or refund now has an explicit, evidence-based resolution contract (§14.4: .../reconcile, .../attach-provider-reference) that still upholds "no generic financial status editor."

Minimal Admin read endpoints added: GET /orders, GET /orders/:id, GET /refunds, GET /refunds/:id.

New invariants (cumulative with RC.8)

I-SETTLEMENT-003   Allocation is reserved before external manual payment.
I-SETTLEMENT-004   PREPARED never expires or releases automatically.
I-SETTLEMENT-005   Only confirmed non-payment may cancel PREPARED; only actual recovery may release paid allocation.
I-SETTLEMENT-006   Prepare is idempotent: same key + same payload never creates a second row, and
                   always replays the settlement's current status regardless of how far past
                   PREPARED it has since progressed.   [RC.8.1, revised RC.8.2]

I-REWARD-002       Blocked, prepared, pending-document and settled amounts cannot appear as available.

I-BOOKING-002      A payment approval creates entitlement (CONFIRMED booking, ticket, reward)
                   only if the booking is still RESERVED at approval time, independent of
                   occurrence fulfillment_status.   [RC.8.2]

I-REFUND-002       Customer-cancellation refund target is always server-derived as
                   captured_amount minus documented withheld expenses; Admin never enters a
                   refund amount directly.   [RC.8.2]

I-EMAIL-001        Outbox delivery is at-least-once with best-effort duplicate suppression via
                   a stable provider_idempotence_key per row. Exact-once delivery is not
                   guaranteed, and "no job_id recorded" is never treated as proof that a send
                   did not happen.   [RC.8.2]

I-IDEMPOTENCY-002  Checkout idempotency binding lives for the order evidentiary lifetime.
I-IDEMPOTENCY-003  A browser reload reuses the current unresolved checkout key.

I-QUOTE-001        A new order cannot be created from a quote with a stale material revision.

I-PROMO-001        A promo linked to a professional promoter is eligible for a new order only while both the promo and the linked promoter are enabled.   [RC.8.1]
I-PROMO-002        Disabling a promoter never mutates historical orders or the persisted status of its promo codes.   [RC.8.1]

I-REFUND-003       Every provider refund command is one row in the refunds table (§14.2);
                   there is no other, unspecified path to submitting a refund to the
                   provider.   [RC.8.3]

I-REFUND-004       REVIEW_REQUIRED on a payment or refund can only be resolved by provider
                   evidence (§14.4), never by a direct status write.   [RC.8.3]

I-REFUND-OBLIGATION-001   At most one aggregate refund obligation exists per payment.

I-BOOKING-001      v1 booking states are RESERVED, CONFIRMED and CANCELLED only.

I-ABUSE-001        Only a newly claimed checkout key may create a new reservation and consume new-attempt quotas.

I-NETWORK-001      Public browser commerce requests are same-origin with flexperiment.ru.   [RC.8.1]
I-NETWORK-002      /v1/* is routed exclusively to Hono and is never served by the static export.   [RC.8.1]
I-NETWORK-003      The system does not depend on browser CORS for normal public commerce operation.   [RC.8.1]
I-NETWORK-004      Admin authentication is scoped to admin.flexperiment.ru; its host-only cookie is never sent to the public site.   [RC.8.1]

Removed scope

Still excluded:

automatic promoter payouts/banking;

payout workers/batches/reconciliation;

generic settlement void;

ordinary paid individual promoters;

customer referral credits (rewards remain a professional-promoter-only feature; consumer referral credits are still post-launch);

automatic NPD verification/receipt retrieval;

event-to-event payment transfer;

attendance/check-in;

third-party/minor/group/gift purchases;

customer self-service cancellation (Admin-mediated only, §14.1);

PDF tickets;

CAPTCHA/fraud platform;

multiple commerce replicas;

separate API hostname/CORS (same-origin decision, §6).

Phase 0 gates

Tochka ambiguity/refund/webhook fixtures;

Unisender unknown-send fixtures, incl. [RC.8.2, expanded]: job_id lookup-by-id capability; provider_idempotence_key/metadata semantics and whether Unisender deduplicates sends on it; whether a delivery-webhook or status API can resolve a dropped-response send by provider_idempotence_key/outbox metadata when no local job_id was ever recorded;

official provider limits/IP facts where available;

organizer-cancellation fiscal refund confirmation;

NPD/IP and cash/transfer procedure;

legal/provider/retention/Roskomnadzor review;

approved Russian infrastructure and backups;

reverse-proxy routing config for /v1/* and admin.flexperiment.ru confirmed on target Coolify/Traefik setup.

Final release blockers

Production remains disabled until all of §26 passes, specifically:

prepared-settlement crash tests pass, including Prepare idempotency;

reward balance property tests pass, including snapshot-based (non-live-join) reward calculation;

session reload cannot create duplicate checkout;

material quote staleness and promo eligibility are both enforced at order creation;

refund obligation uniqueness passes concurrency tests, including the CUSTOMER_CANCELLATION_PARTIAL and LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION sources;

rate limits resist reservation exhaustion without blocking idempotent retries, and the documented status-polling cadence never self-triggers 429;

email outbox crash recovery never double-sends when a job_id was recorded, and never treats a missing job_id as proof of non-delivery;

network-boundary tests confirm same-origin operation and admin cookie isolation;

a late payment approval never resurrects a booking already cancelled via §14.1 (I-BOOKING-002);

customer-cancellation refund targets are always server-derived, never accepted as a raw admin-entered figure (I-REFUND-002);

settlement-prepare idempotency replays correctly at every settlement status, not only PREPARED;

every provider refund, from either source, is one refunds row under the shared idempotency/nonterminal-per-payment/no-blind-retry discipline (I-REFUND-003);

the admin compensation-refund endpoint cannot cancel a booking, void a ticket, or release capacity under any payload (I-REFUND-003);

REVIEW_REQUIRED resolution never accepts a direct status write and only transitions on provider-proven evidence (I-REFUND-004).

No unresolved product decisions remain. RC.8.3 is fully self-contained — it does not reference RC.7, RC.8.1 or RC.8.2 for any normative content. The next useful step is Phase 0, not a further RC.
