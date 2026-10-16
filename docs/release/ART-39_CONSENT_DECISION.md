# ART-39 — separate consent and purchase acceptance

**Current, 16 October 2026: INSTALLED / BUYER PREFLIGHT PENDING / MONEY HOLD.**
See [installed evidence](../evidence/2026-10-16-paid-checkout-installed/README.md) for actual merged sources/images, review.4 publication, owner-backed
fiscal qualification and independent recovery. The preparation statements below
are historical; they do not describe the installed runtime. Separate financial
GO remains mandatory.

## Historical preparation record

**SERVER GUARD PREPARED / LEGAL REVIEW.3 APPROVED AND ACTIVE / FISCAL BASIS PENDING / MONEY HOLD.**
16October2026. PR239 merged documentation as
`6e48e22a7a6c958ca7deb77d665726b522a382ee`, without deployment.
The new guard is a source change; it is absent from the previously published
Commerce/Platform artifacts built from `a548774…`.

## Approved principles and exact review.3

The owner approved the separate Cheki data-transfer consent principle, seller-paid
fees, unchanged1₽ charge/full refund, five-year minimum tax evidence retention and
at least one year for that consent evidence on16October2026. The owner subsequently approved the exact review.3 package and retention start.
Conditional autonomous installation authority is present; money remains on HOLD.

Retain an explicit `personal_data` action, separate from account terms and
purchase/refund acceptance. The owner confirmed Tochka's «Чеки». Its published
contract requires buyer consent for transmitting data to the processor, so
purely relying on contractual/statutory processing for all payment transfers
would not cover that service requirement. The
[new review package](../legal/closed-paid-test/2026-10-16-review-3/README.md)
names the processor/OFD and approved consent scope/retention, distinguishing
historical receipt evidence from a new payment receipt. Marketing is optional
and stays false for this test. Do not fabricate consent or copy Stage A choices.

Review.3 Stage B is now active after exact HTTPS/hash read-back. The buyer opens
`/account`, reviews the final documents and marks separate personal-data/account
choices. Session-derived `POST /v1/me/consents` records action and document
version/hash evidence; no service/operator insertion replaces the buyer's action.
The checkout checkbox separately accepts purchase/refund conditions and receipt
information. `PAID_CHECKOUT_TERMS_ACCEPTED` is not independent PD consent.

## Server enforcement for the closed paid profile

`assertClosedPaidTestAccountConsents` first matches the current COURSES legal
version/manifest hash to the closed profile's approved pins, then calls
`hasRequiredAccountConsents`. That function requires a verified/bound account,
latest confirmed choices for the active release ID/version/hash and exact PD/account
documents. Missing, foreign-customer/storefront, stale and unverified evidence
fails closed; optional marketing is not required.

The guard runs before handoff, before every preview (including replay), after an
asynchronous quote resolution, before confirm replay/new payment and again in
the write transaction creating the order. No provider resolution/payment creation
or local order/acceptance writes occur on an initial refusal. `CONSENT_REQUIRED`
returns403/no-store and Platform links to the separate account form. The guard
records no acceptance. Other payment profiles keep their existing behavior.

Financial reconciliation/status reads, workers and refunds retain their existing
paths: losing consent must not prevent resolving or refunding an already created
financial operation. A buyer/account read-back is still required before money,
but it supplements the server guard. It is not its substitute.

Tests cover no upstream calls/writes on refusal, correct-account acceptance with
marketing=false, foreign/stale evidence, replay and asynchronous changes, HTTP
session identity/forged fields and the UI account link. These are synthetic local
checks, not actual buyer acceptance or installed-runtime qualification.

Latest authority is AUTONOMOUS INSTALLATION GO / MONEY HOLD. The owner approved
[review.3](../legal/closed-paid-test/2026-10-16-review-3/README.md), which is now
published in the private HTTPS contour and active through the normal fenced API.
No customer PD action was manufactured. The server guard is merged in3222845
and present in the independently verified image pair; the pair is not installed.
The genuine ART-234 fiscal legal-basis reference remains outstanding.
