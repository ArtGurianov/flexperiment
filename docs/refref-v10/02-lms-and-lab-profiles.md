# LMS and LAB profiles

Status: proposal for review, 27 October 2026. Both storefronts share `commerce-v2` and one Refref integration; they differ in what the buyer gets, when the service is performed and how cancellations happen. Refref's finality and claim rules are in the pinned [money contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/04-money-finality-claims.md); this page states the Flexperiment side.

## 1. Product kinds

| Kind | What the buyer gets | Proposed finality mode (FX-C03) | Anchor frozen at `BOUND` |
|---|---|---|---|
| `ONLINE_COURSE` | Course entitlement with immediate access to ready materials | `PAYMENT` | First actual full payment |
| `COURSE_BUNDLE` | `ALL_COURSES` entitlement | `PAYMENT` | First actual full payment |
| `LAB` | Seat and ticket for one occurrence (event or programme) | `SCHEDULED_SERVICE` | The occurrence's planned end, as frozen in the order line |

The mode belongs to the campaign terms and is chosen before `BOUND`. It is never derived from a fiscal tag, from the moment access was activated, from lesson progress or from the last login. Refref's own profile tests already assume `PAYMENT` for LMS and `SCHEDULED_SERVICE` for LAB; the owner still confirms it for each campaign.

Each order has one line with quantity 1 today ([checkout-snapshot.ts](../../commerce-v2/src/checkout-snapshot.ts)). One purchase therefore has one eligible line, and the commission is computed once per purchase. If a basket with several lines is introduced later, the commission is still one per purchase; it must not be split per line or per seat.

## 2. One payment, no deposits

LMS and LAB keep one full payment of the frozen total. The first confirmed payment of exactly that total is the purchase's first actual full payment. Deposits or instalments are not part of this plan (FX-C08); if the owner introduces them, the Mikluha deposit model applies: a deposit is not a full payment and does not create `C`.

`fullPaymentDueAt` is mandatory in `BOUND`. For an immediate 100% payment it is the agreed checkout deadline (FX-C04), for example the payment-session expiry that can never outlive the 15-minute intent. When it passes without payment, the outbox sends the true state (`NOT_PAID` or `CANCELLED` after the order is closed) within the clarification period in the pinned [reporting contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/03-merchant-reporting.md). A payment that later turns out to have succeeded is reported as the true `PAID_IN_FULL` with its actual time, even after `CANCELLED`.

## 3. LMS

- **Access.** Granting the entitlement stays bound to a confirmed payment of exactly the frozen total. Immediate access evidence (`immediate_access_json`) stays an access record; it is not the finality anchor.
- **Accounts and contexts.** The LMS context is rotated on logout and account switch ([browser-context.ts](../../commerce-v2/src/browser-context.ts)); a touch captured in one context never moves to another account. Refref never receives the account id or email.
- **Refunds.** The buyer refund policy for digital content is Flexperiment's (FX-C05). A refund does not change `C` by itself. If a refund should zero `C`, Flexperiment files a claim inside the window: a full cancellation needs the whole eligible purchase terminated plus a positive cash refund; a partial cancellation needs the remaining eligible money to be at most `C`. With `PAYMENT` mode, the window runs 14 days from the first full payment, so a refund after that window cannot zero `C`.
- **Access after refund.** Access ends only when the native provider confirms the refund, as today. A Refref claim decision neither grants nor revokes access.
- **Course updates.** An entitlement follows course updates; this never changes `C` or the anchor.

## 4. LAB

- **Guests.** LAB tickets are sold to guests without accounts ([lab-guest-routes.ts](../../commerce-v2/src/lab-guest-routes.ts)). A guest email is never sent to Refref and never used to match buyers across purchases.
- **Seats.** A seat is released only by a final order outcome; an unknown payment keeps it. The `BOUND` command runs before the payment session, inside the existing intent and seat-hold deadlines; a `BOUND` whose result is unknown keeps the referral payment gate closed until read back, and the seat hold follows the existing rules.
- **Anchor.** The anchor is the planned end of the occurrence as frozen at `BOUND`. Editing the occurrence after a seat is committed stays forbidden; a move or cancellation goes through the dedicated workflow (ART-203) and never moves the frozen anchor.
- **Occurrence moved by Flexperiment.** When a buyer agrees to move to another occurrence of the same product, it is a continuation of the same purchase: same `purchaseRef`, `BOUND`, partner and `C`, old anchor. If money is refunded and paid again only because of provider limits, the purchase still continues; the claim snapshot shows both money flows.
- **Occurrence cancelled by Flexperiment.** The buyer gets the refund owed under the LAB rules. If all eligible services end and a positive cash refund succeeds, Flexperiment may file a full-cancellation claim inside the window. A voucher or credit toward another occurrence is not a cash refund and does not support a full-cancellation claim.
- **Ticket use.** Ticket scanning (`used_at`) and closing receipts are service facts; they are not Refref events and do not move the anchor.

## 5. Changes before the first full payment

With one payment of the frozen total, the price normally cannot change between `BOUND` and payment: a stale quote refuses the payment and the buyer gets a new quote. If a new quote produces a different eligible amount, it is a new revision of the same purchase sent to Refref; Refref's acceptance is a referral qualification, not a precondition for Flexperiment's own sale. An unsuitable revision means no positive `C` for it, not a blocked sale.

## 6. Money facts kept for claims

For every payment and refund Flexperiment keeps the provider operation id, amount, currency, actual time, outcome evidence and its link to the order line. The claim snapshot lists all payments and refunds of the purchase, including any made after the first full payment. Flexperiment does not build pro-rata allocations to win a claim; unknown allocations stay unknown.
