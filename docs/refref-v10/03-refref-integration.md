# Refref v10 adapter for LMS and LAB

Status: proposal for review, 27 October 2026. Authoritative rules: Refref PR #130 at `c932b656edbda1d47cfb57de08fd4a36536712f5` — [attribution and `BOUND`](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/02-attribution-bound.md), [merchant reporting](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/03-merchant-reporting.md), [API map](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/06-api-and-states.md). The `/v10/...` routes below come from that package and are not yet served endpoints.

## 1. From Arrival to v10 touch

Today ([browser-context.ts](../../commerce-v2/src/browser-context.ts), [refref-arrival-exchange.ts](../../commerce-v2/src/refref-arrival-exchange.ts)) each storefront keeps a server-only context cookie, captures the Arrival proof, claims it in the background for up to 30 minutes, and lets Buy wait up to 1,500 ms before freezing `deliveryDegraded` into the intent.

| Today | v10 requirement |
|---|---|
| Context cookie with 30-day default Max-Age | The cookie only locates the browser context. Its age or refresh never proves a touch or extends protection. Protection (72 hours) and the touch lifetime for a new `BOUND` (campaign terms, 7 days by default, at most 30) come from Refref's answer |
| Arrival claim with "last eligible Arrival wins" semantics of ADR-139 | One active holder per storefront context. During the 72-hour protection a conflicting link or code does not take over; after it, a switch needs the buyer's explicit confirmation (`touch.switch.confirm` with the holder version) |
| `deliveryDegraded` lets Buy continue after 1,500 ms | An unknown touch or `BOUND` result never opens the referral payment path. The buyer may choose an ordinary sale only after Refref's refusal or a proven absence of `BOUND`, with a clear price |
| Proof deleted after settlement or 30 minutes | Keep enough command and action ids to read the result back after a restart; do not store raw proofs longer than needed |

Existing Arrival claims and cookies are not converted into v10 touches or `BOUND` records. Old attempts finish under their own profile.

## 2. Promo codes and Apply

The checkout has one code field. Codes with the merchant prefix are Flexperiment promotions ([promotions.ts](../../commerce-v2/src/promotions.ts)); other codes go to Refref.

- A Refref promo touch is created only by the buyer's explicit **Apply** of a valid code (`PROMO_APPLY`, variant `APPLY_BUTTON`). Typing, editing, autofill, URL prefill and background requests do not create a touch. The LAB checkout already has a separate applied-code state ([CheckoutFlow.tsx](../../apps/lab/components/CheckoutFlow.tsx)); the LMS checkout needs the same explicit step. Refref also allows a qualified `ORDER_SUBMIT` variant for checkouts without a separate Apply step; since both storefronts are under Flexperiment's control, the plan uses the explicit button.
- The server records the action proof and validates the code; a client flag `explicit=true` is not proof.
- A referral link (`REFERRAL_NAVIGATION`) is its own basis and does not need Apply.
- A Flexperiment promotion is a merchant discount: it reduces the base `G` and never creates or switches a Refref touch. Whether it may stack with a Refref discount is FX-C06.

## 3. Before the first payment

1. Freeze the quote and intent as today (15 minutes, never past the LAB start).
2. For a referral purchase, send `binding.create` (`POST /v10/bindings`) with `purchaseRef`, revision id and hash, eligible lines, the offer proof, `fullPaymentDueAt`, the finality mode and, for LAB, the frozen occurrence end. The payment session, payment link and any provider call stay closed until a durable `BOUND` is stored locally.
3. A timeout or lost answer is an unknown result: read it back with `GET /v10/bindings/by-command/{commandId}`, including a previous refusal. Do not change `purchaseRef`, pick a new partner or open payment meanwhile.
4. After `BOUND`, create the native payment operation. After a refusal, an ordinary sale without a new referral right is allowed.

One purchase has at most one `BOUND` and one `C`. A failed payment followed by a new payment of the same order keeps the same `BOUND`.

## 4. Discount, price and commission

| Value | Meaning |
|---|---|
| `G` | Eligible amount after Flexperiment's promotions, before the Refref discount |
| `D_rule` | Refref discount computed by Refref from the campaign terms (percent rounded down) |
| `D_applied` | Discount the buyer actually got; 0 if not applied |
| `C` | From `G` under the campaign terms; independent of `D_applied` |

Initial suitability is the direct check `G − D_rule − C > 0`; a buyer not using the discount does not replace `D_rule` with 0. A discount applied without a valid touch or without a `BOUND` stored before payment creates no commission. Flexperiment never sends a commission amount or an `eligible` flag of its own.

## 5. Outcome reporting

Only for purchases with `BOUND`, through a durable outbox written in the same transaction as the local fact:

- `PAID_IN_FULL` — the first confirmed payment of the whole frozen total, with `actualPaidInFullAt`, `knownAt`, the effective revision and the purchase snapshot (`buyerDiscountApplied`, `refrefDiscountAppliedTotalKopecks`, lines with `SERVICE` category). Due by the end of the next Russian business day after the actual payment.
- `NOT_PAID` — the full payment has not happened as of `stateAsOf`.
- `CANCELLED` — the order was closed before any full payment. After a full payment, a refund is never sent as `CANCELLED`; a claim is used instead.

`POST /v10/purchases/{purchaseRef}/results` is append-only and takes no `expectedVersion`. The answer is a durable receipt (HTTP 202); processing status is read separately. A `FULL` for a revision Refref has not registered is still accepted and qualified from its own snapshot. Retries resend the same command; a lost answer is recovered by `GET /v10/commands/{commandId}`. Organic sales, refunds outside claims, buyer emails and LMS accounts are not reported.

## 6. Claims, payouts, disputes

- **Claims.** Filed by `POST /v10/purchases/{purchaseRef}/claims` with the money snapshot and evidence (see [profiles §6](02-lms-and-lab-profiles.md#6-money-facts-kept-for-claims)). A claim may be filed before a late `FULL` is delivered. The result is `C` or 0.
- **Payouts.** Flexperiment pays each partner from the monthly registry, in RUB to a Russian bank account, with the registry number in the payment purpose, by the deadline in the pinned [payout contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/05-payouts-s3-conformance.md). It reports execution, the unpaid or unclear remainder at the deadline and corrections. A transfer with an unknown outcome is never sent again for the same amount.
- **Disputes.** When a partner complains, Flexperiment answers a proper request within the contract deadline with the relevant payment evidence. Unrelated bank operations may be redacted.

## 7. Admission conditions

Before money flows: a served and authenticated v10 transport; `BOUND` before every way to pay; replay by command id; native provider read-back; actual payment chronology; the business-day calendar; data minimisation; qualified buyer terms. Links to the Refref PR prove none of these.
