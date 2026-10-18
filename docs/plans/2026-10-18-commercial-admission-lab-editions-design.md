# Commercial admission, quote guarantee, LAB occurrences and course editions

Owner authority: decisions of 18 October 2026, reviewed against `main` at
`6a528e6`. Design only: no migration, runtime, deployment or sales change.
Public sales stay CLOSED; MONEY HOLD and every F9/F10 gate remain in force.

Flexperiment runs two products on one Commerce: online courses (LMS, Platform)
and offline master classes (LAB). Rules below say which product they cover.

## 1. Sales admission (LMS and LAB)

Today a sale passes `PAYMENT_MODE`, `offers.sale_mode`, an active
`sales_activation` row per product kind and, for LAB catalogue listing only,
`lab_occurrences.sales_status`. The `sales_activation` evidence is a format
check (`catalog-control.ts:178`, 64 hex characters), written by anyone holding
`PLATFORM_SERVICE_TOKEN`. What it really provides is a second authority beside
the Control Room session. ART-319 already specifies a stronger one.

Decision:

1. **Storefront switch per storefront (`COURSES`, `LAB`)**, implemented as
   ART-319: an operator-controlled host file mounted **read-only** into the
   Commerce container, with a monotonic generation, `by`, `reason` and evidence
   issue. Missing, unreadable or invalid means CLOSED. Only the owner over SSH
   may change the host-controlled file to OPEN. The read-only mount prevents a
   normal Commerce process from rewriting that file, **but cannot stop
   arbitrary code executing inside Commerce from bypassing an in-process check**;
   Refref's independently authorized operator payment stop remains essential.
   It replaces
   the `sales_activation` table and the `/v1/internal/sales-activations` route
   (the table stays read-only as history). It is both the first-sale gate and
   the emergency stop. The evidence issue is a reference, not a proof: the
   open command itself refuses unless the storefront's preconditions hold when
   it runs (an active legal release, a qualified fiscal policy for every
   `PUBLIC` paid offer, `PAYMENT_MODE=refref`), and Commerce re-checks them on
   every admission.
2. **Per offer: `offers.sale_mode`** `CLOSED` / `PUBLIC` is the only
   commercial switch, changed in Control Room. `ACCEPTANCE_ONLY` with its
   allowlist stays for closed tests and is removed after launch.
3. **"Pause all" in Control Room** closes every `PUBLIC` offer of a storefront
   in one transaction and records the batch; "Resume batch" reopens only offers
   still closed by that batch (the Mikluha ADR v2.2 §4 pattern).
4. **LAB: `lab_occurrences.sales_status` stops being a sales control.** The
   occurrence keeps a lifecycle (`SCHEDULED` / `CANCELLED`; finished is derived
   from `ends_at`).
5. `PAYMENT_MODE` stays environment configuration. Visibility
   (`LISTED`/`UNLISTED`/`WITHDRAWN`) stays separate; `WITHDRAWN` implies CLOSED.

**Two different admission checks, each inside its own write transaction.**
Checkout today checks only the offer (`assertOfferOpenToCustomer`,
`checkout.ts:318`). For LAB it does not check the occurrence lifecycle, start/end
or capacity, so a direct `offerRef` bypasses the catalogue filter
(`lab-catalogue.ts:14`). **Issue quote + LAB hold:** require the storefront
operator switch OPEN, offer `PUBLIC` (or authorized closed test), not withdrawn,
LAB occurrence `SCHEDULED`/not started, and available capacity. **Confirm an
existing issued quote:** require the storefront operator switch still OPEN,
the identical non-expired quote and legal acceptance, its valid associated LAB
hold, no cancellation or withdrawal, and a payment-safe frozen intent.
Critically, **do not require live `offer.sale_mode=PUBLIC` here**: an ordinary
offer-level `PUBLIC→CLOSED` prevents *new* quotes but allows an already issued
quote to finish within its original deadlines. Confirmation does not create a
new hold or recalculate a changed catalog price.

## 2. Quote guarantee (LMS and LAB)

Matches Refref `docs/29` §5 and ART-373/379.

- A quote is payment-admissible until the earliest of: 15 minutes, the LAB seat
  hold, the occurrence start, the end of an applied promotion, a storefront
  close, offer withdrawal and occurrence cancellation.
- **A price change does not invalidate an issued quote.** `confirmCheckout`
  stops comparing the live price with the quote (`checkout.ts:559-561`); the
  order is created at the quoted price. A legal release change still makes the
  quote stale: the buyer must accept the documents in force.
- **An ordinary offer close** (`PUBLIC → CLOSED`, including "Pause all") stops
  new quotes; an issued quote may still be confirmed within its validity.
- The guarantee is stated in the purchase terms (ART-231, LAB terms), not
  inferred from the word "quote".
- **Two atomic operations, each one `BEGIN IMMEDIATE` transaction:**
  1. *Quote (+ LAB seat hold):* run admission, take the seat hold (LAB) and
     write the quote with its frozen price and expiry. LMS has no hold.
  2. *Confirm:* run **existing-quote confirmation admission**, not new-quote
     admission. Verify frozen quote/legal/promo facts, deadlines and the original
     LAB hold despite any intervening ordinary offer close. Reject storefront
     emergency close, withdrawal or cancellation. Atomically convert the hold
     into an order and record the attempt, then call Refref after commit.

  The live price may change between them; the quote's price does not. A
  repeated quote request for the same intent returns the existing quote and
  hold, never a second hold; a replaced intent carries the hold over.
- **Late payment:** the attempt carries Refref `latePaymentPolicy`. Courses:
  `HONOR`. LAB: `HONOR` while the occurrence is deliverable, `AUTO_REFUND` once
  it is cancelled (ART-201).
- The final admission and quote checks move inside `create.immediate()`. In one
  process there is no race today (no `await` between check and write), but a
  second process writing the database (CLI) could create one.

## 3. Product configuration

The Control Room route `POST /v1/admin/v2/catalogue/products` (`app.ts:397`)
calls `configureProduct` with any `saleMode`, so a price change and an opening
can happen in one command. `configureCourseCommercial`, which forced CLOSED, is
called by no route. Because issued quotes keep their price (§2), changing the
price and opening together is safe. Decision: keep `configureProduct` as the
single command (expected version, audit, identity immutability, storefront
switch check) and delete `configureCourseCommercial`.

## 4. LAB occurrence changes

Product identity is already immutable (`0013_product_identity_immutable.sql`)
and the order line snapshot (`freezeLine`) is the accepted contract. An
occurrence is an editable offer:

| Change | Occurrence has held or sold seats? | Rule |
|---|---|---|
| Description, photos | any | free |
| Price | any | free; new quotes only |
| Date, time, duration | none | free |
| Date, time, duration | yes | locked; only the move/cancel workflow (ART-203) |
| Teacher, venue, programme, cancellation terms | none | free |
| Teacher, venue, programme, cancellation terms | yes | classified execution change: `EQUIVALENT` → saved, one e-mail per affected order via an idempotent, retried notification record (provider acceptance is not delivery); `MATERIAL` → move/cancel workflow with refund (ART-203, ART-206) |

No EIS duties apply to LAB.

## 5. Course editions (LMS)

Two levels, built on what exists:

- **Content revision:** every publish, as today (`course_editorial_versions`,
  immutable, never deleted). Fixing a typo, adding a video or reordering lessons
  updates the **current edition**.
- **Edition:** an explicit Control Room action "Выпустить новую версию". New
  table `course_editions(course_ref, edition, editorial_version, released_at,
  archive_until)`.

Rules:
- Entitlements stay on `courseRef`; the current edition is free for every owner
  of the course. A paid expansion is sold as a separate course.
- The previous edition is readable as an archive by everyone who had access
  before the release, for **30 days** from `released_at`. Access is checked
  against `archive_until` on every read, whether or not cleanup has run, so the
  limit holds even if no further edition is ever released. Owners get an e-mail
  with that date.
- A released edition is sealed: it keeps its own references to specific
  Kinescope assets. Edits after the release change only the current edition.
- The publish dialog offers "Обновить текущую версию" or "Выпустить новую
  версию" with a summary of the changes. A draft that removes or replaces
  lessons or videos defaults to a new edition.
- A Kinescope asset is never replaced in place; a changed video is a new asset.
- Physical cleanup runs when the next edition is released (no scheduler): a
  Kinescope asset is deleted only when neither the current edition nor an
  unexpired archive references it. Revision text and audit
  are never deleted.
- The 30-day rule goes into the course offer (ART-231) before F10. Nobody has
  bought yet, so no existing contract is affected.

## 6. Platform rendering

Platform stays SSR with `connection()` and `no-store`. ART-339 is reduced to
the SEO effects actually needed; no ISR and no outbox now.
`invalidatePlatformCache` stays as it is.

## 7. Stale code

Removed after a check of canary ingress logs for real calls:
- `access-overrides.ts`: only `flagOrphanedOverrides` is called (`app.ts:384,
  512`) and the table receives no writes; plus its `/readyz` counters.
- `manifest.ts`: no callers.
- `configureCourseCommercial` (§3).
- `/v1/internal/control-room/*` (11 read routes, `app.ts:499-519`): duplicates
  of `/v1/admin/v2/*`, no consumer in the repository.
- `/v1/internal/{sales-activations,legal-releases,campaigns,
  merchant-promotions,refunds}`: protected only by `PLATFORM_SERVICE_TOKEN`,
  so they bypass the Control Room login and TOTP. Sales activation goes away
  (§1); the others become CLI commands run in a one-off container from the
  Commerce image, not web Admin actions.

The 404 smoke checks for the old manifest/override routes stay.

## 8. Control Room authentication

Password + **TOTP** (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step, Google
Authenticator). The last accepted step is stored; a code never works twice. The
seed is stored encrypted with a key from the environment. No recovery codes: a
lost device is reset by an operator CLI over SSH, audited. Same mechanism as
Mikluha and Refref platform admin (shared operations standard in
`adman-vps-infrastructure`).

## 9. CI and release

The repository is public, so GitHub-hosted CI stays free and remains the CI
path. Deploy workflows run on `workflow_dispatch` from `main` only; fork pull
requests never reach deploy secrets.

The fast-cut canary (commerce, platform, admin, lab-v2, drm-bridge, tester)
runs on the VPS outside Coolify, so Coolify shows none of it. It moves to
Coolify Docker Image applications pinned by digest: `PATCH
/api/v1/applications/{uuid}` with `docker_registry_image_tag = sha256-…`, `POST
/api/v1/deploy`, follow to a terminal state, then check that `/identity` reports
the chosen commit and that the running container's digest (Docker metadata on
the host) equals the chosen digest. The whole
sequence runs in one workflow concurrency group per application.

## 10. Execution map

- ART-319: storefront switch (§1), replacing `sales_activation`.
- ART-341 / ART-199: one occurrence lifecycle, no second sales status; edit rules (§4).
- ART-200 / ART-201: seat hold taken by the quote; late-payment policy.
- ART-203 / ART-206: move/cancel workflow.
- ART-373 / ART-379 / ART-384: quote guarantee (§2), checks inside the transaction.
- ART-231: quote guarantee and 30-day edition archive in the offer.
- ART-333: publish dialog with editions (§5).
- ART-339: reduced (§6).
- ART-166 / ART-164: canary into Coolify by digest (§9).
- ART-243 / ART-310 / ART-240 / ART-242: acceptance includes the admission negative tests below.

## 11. Negative tests

1. Direct checkout of a LAB `offerRef` whose occurrence is cancelled, started
   or full is refused, even with the offer `PUBLIC`.
2. Storefront host file missing, unreadable or CLOSED: new quotes and
   confirmation/payment initiation fail closed. A normal Commerce process
   cannot modify its read-only mounted file; compromised Commerce code might
   bypass its check, so Refref's independent operator stop is retained.
3. Price change at 14:10 against a 14:00 quote: confirmation at 14:14 creates
   the order at the quoted price; a new quote uses the new price.
4. Offer closed at 14:05 against a 14:00 quote: new-quote admission refuses a
   new quote; existing-quote confirmation succeeds until its own deadlines,
   despite `offer.sale_mode=CLOSED`. Emergency storefront close refuses both.
   Test both code paths against the same SQLite hold/order transaction.
4a. Two concurrent LAB quotes for the last seat: exactly one gets a hold. An
   expired hold frees the seat and its quote cannot be confirmed. A lost Refref
   response after confirm is recovered by readback with the same order and
   attempt, never a new hold or attempt (ART-200, ART-373, ART-379).
5. LAB date edit with a sold seat is refused; an `EQUIVALENT` venue change
   creates one notification per affected order (idempotent, retried, status in
   Control Room); provider acceptance is not recorded as delivery.
6. New edition: owners read the old edition until `archive_until` and not after,
   even with no later release; cleanup at
   the next release keeps every asset the current edition references.
7. A TOTP code reused within its step is refused.
