# LMS / COURSES — transition profile for Refref v10

Date: 2026-10-27. Status: **Draft architecture for OWNER review**. This does not describe an implemented transport or authorize sales reopening. The source audit examined Flexperiment `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; the Refref baseline is pinned to `c932b656edbda1d47cfb57de08fd4a36536712f5`.

See the [shared architecture](01-commerce-architecture.md), [LAB profile](03-lab-profile.md), [adapter contract](04-refref-integration.md), [fiscal and legal conditions](05-fiscal-legal-impact.md), and [migration and acceptance plan](06-migration-and-e2e.md). Here, LMS means `apps/platform` and the Commerce `COURSES` storefront. It is not a separate bank or Refref database.

## 1. Existing source behavior

This is a source audit. Installed versions, customer data, Kinescope availability, bank and fiscal-provider accounts, and acceptances in running environments were not inspected.

| Area | Verified source | Observed behavior and boundary |
|---|---|---|
| Storefront and content | [Platform](../../apps/platform/components/checkout/CourseCheckout.tsx), [publication protocol](../course-publication-protocol.md) | Platform is an SSR storefront. The Commerce-owned published graph is separate from drafts. Commerce is the current authority; the historical Payload writer is not |
| Buyer | [app.ts](../../commerce-v2/src/app.ts), [authenticated-consents.ts](../../commerce-v2/src/authenticated-consents.ts) | LMS checkout uses an authenticated customer. Required consents are bound to the verified account, storefront, and exact document versions/hashes. The marketing choice is separate |
| Price preview | [checkout.ts](../../commerce-v2/src/checkout.ts), [migration 0030](../../commerce-v2/migrations/0030_checkout_intents.sql) | A durable intent stores order/line identity and the original resolution request before the remote call. The quote is limited to 15 minutes. An intent or quote is not a bank payment |
| Code entry | [CourseCheckout.tsx](../../apps/platform/components/checkout/CourseCheckout.tsx) | A code field exists, but there is no separate Apply button: “Buy course” first opens a preview, followed by review/acceptance and “Confirm and pay.” This has not yet been proven to implement v10 `PROMO_APPLY/ORDER_SUBMIT` |
| Payment boundary | [PaymentRail](../../commerce-v2/src/checkout.ts), [RefrefPaymentRail](../../commerce-v2/src/refref-payment-rail.ts), [payment-mode.ts](../../commerce-v2/src/payment-mode.ts) | Modes are `disabled/mock/refref`. The current source adapter creates a Refref-owned RC.2 attempt/session and reads its result. This code does not implement native merchant acquiring for v10 |
| Sale and access | [checkout.ts](../../commerce-v2/src/checkout.ts), `applyProjection` | Access is granted after confirmed rail PAID with an amount matching the frozen total. A mismatch becomes REVIEW_REQUIRED and does not grant an entitlement |
| Entitlement scope | [entitlements.ts](../../commerce-v2/src/entitlements.ts), [access-policy.ts](../../commerce-v2/src/access-policy.ts) | ONLINE_COURSE grants COURSE; COURSE_BUNDLE grants ALL_COURSES. Grants are deduplicated by source order line. Unlisting alone does not revoke an existing grant; withdrawal and other restrictions are checked separately |
| Initial materials | [immediate-course-access.ts](../../commerce-v2/src/immediate-course-access.ts), [OWNER decision](../plans/2026-10-16-owner-legal-decisions-design.md) | The set of already published READY materials is recorded for the selected immediate-access course. This proves the initial provision of materials; the entitlement remains dynamic and includes subsequent permitted course updates |
| Protected playback | [playback-access.ts](../../commerce-v2/src/playback-access.ts), [playback-auth.ts](../../commerce-v2/src/playback-auth.ts), [kinescope.ts](../../commerce-v2/src/kinescope.ts) | Checks cover session/customer/consents, course/lesson/grant, the provider READY binding, and a separate playback token. Public discovery does not expose private Kinescope mappings or secrets |
| Refund and access | [refunds.ts](../../commerce-v2/src/refunds.ts), [refund-envelope.ts](../../commerce-v2/src/refund-envelope.ts) | A request, a decision, and successful execution are separate. Current full access revocation requires a successful, attributable canonical refund. A REFUNDED projection without its own execution does not revoke access |
| Product admission | [0016](../../commerce-v2/migrations/0016_online_course_activation_fence.sql), [payment-mode.ts](../../commerce-v2/src/payment-mode.ts) | Acceptance of one ONLINE_COURSE does not admit LAB or COURSE_BUNDLE. Public bundle sales remain separately closed. A historical closed test does not qualify v10 |

One purchase in the current checkout has one line with quantity 1. The `order_lines` table and ALL_COURSES grant do not prove support for an arbitrary mixed basket or multiple independent payments. The Refref v10 architecture alone does not make a new basket or installment feature mandatory.

## 2. Responsibilities retained and changed

Commerce remains responsible for the product, price, contract, payments, and access. Public projections, verified identity, consent, private media, and source recovery retain their separate responsibilities. For **new v10 purchases**, payment ownership changes from Refref-owned checkout to Flexperiment's own qualified acquiring/refund adapter. Existing V2 RC.2 attempts remain with their original owner. This does not authorize restarting retired V1 or fabricating legacy history as new v10 purchases.

| Object | Owner after transition | What is not expected from Refref |
|---|---|---|
| COURSE/ALL_COURSES entitlement, free enrollment, playback permission | Flexperiment Commerce | Confirmation of `FINAL`, partner payout status, an S4 result, or successful merchant-report delivery as prerequisites |
| Bank operation and refund | Qualified Flexperiment merchant adapter | Initiating the seller's payment/refund or holding a buyer balance |
| Touch, BOUND, terms version, and resulting C | Refref | Assigning a partner from an authenticated customer ID or a code selected by the LMS server |
| Buyer contract and initial materials | Flexperiment | A generic `serviceRendered=true` as a substitute for actual access and a fiscal basis |

Neither a paused bank source nor missing v10 transport permits switching an old UNKNOWN attempt to a new owner and charging again. Profile ownership is fixed when a new economic purchase is created; it is not selected from the current environment configuration on each retry.

## 3. Minimum LMS purchase flow

1. Authenticate the buyer and check current required account choices and the product/offer/sale mode. Existing access must not be sold again to resolve a synchronization problem. Free access and preview viewing do not create a paid Refref purchase.
2. Create durable `purchaseRef`, `revisionRef/hash`, line identity, and a local intent. Show the actual price, promised discount, and contractual terms. Trial, preview, manual grants, `FREE`, and an ordinary paid purchase without BOUND remain distinct for referral qualification.
3. For a referral purchase, obtain a qualifying action/touch and durable BOUND **before creating an executable invoice, payment URL/session, or first operation**. A code field, preview, or signed-in account does not prove this. Recover an unknown `binding.create` result using the original command ID; the referral payment gate remains closed. Direct checkout is possible when the absence of BOUND is established and the price is presented honestly, without a promise of retroactive attribution.
4. Issue the merchant's own payment instruction at the accepted price. The approved first LMS profile accepts one full payment, with no deposit or installment schedule. Its `fullPaymentDueAt` is `addMoscowCalendarDates(purchaseCreatedAt, 7)`, as defined in §3.1, and is supplied before BOUND. New instructions require the current time to be strictly before that deadline. A 15-minute quote does not replace it. Any future installment profile requires separate agreement on its schedule, access before FULL, and credit/fiscal conditions.
5. Obtain and verify the actual provider outcome/read-back: owner/connection/operation, currency RUB, amount, and purchase linkage. A browser return, receipt, credit approval, Refref ACK, or successful HTTP 200 does not establish payment. UNKNOWN retains the money fence: no second overlapping operation or key change merely to “try again.”
6. In one local transaction, persist the attributable money fact, the actual first FULL, and the required entitlement/activation fact. Add durable outbox obligations for reporting and the fiscal process. Actual first execution, local discovery, and access activation have distinct timestamps. Promised access opens under the merchant's own qualified policy and actual execution, **without waiting for Refref ACK, C qualification, or FINAL**.
7. For a BOUND purchase, deliver `PAID_IN_FULL` with the true first-FULL revision/hash/time and a complete product and money snapshot. Maintain sourceReceipt/processing status and the recovery required by [contract 04](04-refref-integration.md). Missing revision registration or economic ineligibility must not discard a true FULL. `APPLIED` does not mean positive C.

During a Refref outage **after** BOUND has been persisted, buyer payments and access proceed through the merchant's native systems, and the original facts and sender are recovered. A pending report does not mean the buyer has not paid. A single timeout must not cause another payment, delay lawful access, or delete BOUND. This flow requires a new implementation and transport qualification; renaming the current `RefrefPaymentRail` does not provide it.

### 3.1. Durable unpaid purchases and FX-C12

In the current [checkout-handoff](../../commerce-v2/src/checkout-handoff.ts), a new handoff receives a new orderPublicId/UUID and a 10-minute deadline. The quote/intent separately has a maximum of 15 minutes. [checkout.ts](../../commerce-v2/src/checkout.ts) restores an intent using the original preview key or an explicit orderPublicId and rejects an expired quote. This is not a complete v10 resume flow: a new UI mount/handoff must not lose a persisted BOUND.

The target economic purchaseRef is persisted separately from the handoff, quote/intent, and provider attempt. Read-only preview does not consume a touch. The initial BOUND is created at the confirmed transition to payment, before the first payment opportunity. Quote expiry alone does not terminate a continuing purchase or destroy its BOUND. A new price requires a newly agreed quote/contract revision. A retry does not renew the old price or the bank key tied to the original request body.

**OWNER approved FX-C12 as `LIMITED_CONTINUATION` for both LMS and LAB.** The window ends at `addMoscowCalendarDates(purchaseCreatedAt, 7)`. `purchaseCreatedAt` is the first durable creation time of the economic purchase, not the time of a handoff, quote, BOUND, UI mount, or retry. Adding seven Moscow calendar dates preserves the recorded time of day in `Europe/Moscow`; the result is stored as an exact instant. Persist the policy version, creation time, and resulting deadline at creation. Resume, requote, retries, and recovery do not reset them, and the policy is not retrospectively changed for existing purchases.

For the first single-full-payment profile, LMS sets `fullPaymentDueAt = addMoscowCalendarDates(purchaseCreatedAt, 7)`. LAB sets `fullPaymentDueAt = min(addMoscowCalendarDates(purchaseCreatedAt, 7), salesCutoffAt)` for the applicable accepted sales cutoff. New payment instructions are allowed only while `now < fullPaymentDueAt` and the other price, ownership, consent, availability, and money-safety guards pass. At the deadline itself they are closed. The continuation window, quote validity, `fullPaymentDueAt`, and original attributionExpiresAt retain their distinct meanings even where the selected profile gives two of them the same instant. A truthful NOT_PAID at dueAt does not delete BOUND or erase reporting history.

Final termination grounds are an explicit buyer cancellation, evidenced merchant inability followed by proper contractual termination, or expiry of the continuation window/applicable LAB sales cutoff. A UI reset, browser back action, or “new order” button is not explicit cancellation. Temporary sold-out status blocks a new payment while no seat is available; it is not by itself evidence of final merchant inability. Record the actual ground and effective time. Once a genuine terminal ground applies, do not reopen new payment instructions for that purchase. This does not invent a terminal bank outcome: operations lawfully started before the deadline, their money fences, read-back, and recovery continue.

The merchant must not retrospectively choose “continuation or new sale” to favor a partner. Correct a reporting error while retaining the original fact and the policy version that applied to the purchase.

| Persisted facts and policy selected in advance | Permitted action |
|---|---|
| Only the quote has expired; the continuation deadline has not been reached and no genuine terminal ground applies | Explicitly resume/requote under the original purchaseRef. Retain BOUND/partner when the guards pass. Price expiry alone is not grounds to report CANCELLED |
| CANCELLED was previously reported; the continuation deadline has not been reached and persisted facts show no genuine terminal ground | Check ownership/consent/version, the new price, and money safety. Continue with the same purchaseRef/BOUND. Preserve CANCELLED history; a new observation/revision and any required correction do not rewrite it |
| A genuine terminal ground applies | Do not reopen payment for the old purchase. An independent new sale has a new purchaseRef and a new qualifying action/BOUND only for a new referral right. The consumed touch is not released |
| A payment operation was lawfully started before the deadline and remains PENDING/UNKNOWN when the window or cutoff ends | Close new instructions and retain the original purchase/BOUND, operation identity, and money fence. Continue provider read-back/reconciliation. Expiry alone does not invalidate the operation or discard a genuine late FULL |
| A true FULL of the original obligation is discovered after CANCELLED | Persist/deliver it under the original BOUND with the effective revision and actual time. A final local status does not discard the fact. Accepting FULL alone does not authorize reopening payment or resuming the contract |

A CANCELLED report alone does not prove final contract termination. A customer+product match helps find a candidate and check the money fence, but does not merge contracts automatically. LMS resume checks account ownership; LAB checks a scoped capability or qualified recovery. An email alone is insufficient. Local purchaseVersion/CAS and the revision+outbox transaction serialize resume/cancel/payment. Refref expectedVersion protects its separate projection; it does not authorize the contract. Append-only FULL has no expectedVersion.

First close the previous executable payment opportunity and resolve BANK_UNKNOWN through read-back. Only then, and while the continuation and other guards still allow it, admit a new non-overlapping attempt with its own stable keys. A real late FULL belongs to its effective revision and original BOUND, including genuine execution from an operation lawfully started before the deadline. Preserve its actual time even if discovery follows CANCELLED, expiry, or termination. An accidental receipt of money after termination that does not fulfill an effective obligation requires reconciliation/the applicable refund; its amount alone does not establish FULL/C. Read-back, callbacks, outbox, and history continue after final termination. FX-C12 preserves LAB capacity/hold/cutoff rules: the seven-day window and BOUND do not extend the original hold of at most 15 minutes or permit new payment instructions at/after the applicable sales cutoff. A pending bank operation's committed seat is not released by quote, hold, or continuation expiry.

## 4. Preview, Apply, and the promised price

The audited source distinguishes merchant promotions from referral codes and first applies the merchant's own discount to determine the merchant amount; that is historical source behavior. **The v10 target plans only Refref promo codes.** It does not introduce Flexperiment's own promo codes, coupon stacking, or a merchant-coupon fallback when Refref is unavailable. Preserve already accepted buyer prices and their original evidence. Refref qualifies G under frozen campaign terms. The LMS v10 adapter/UX must define which visible, confirmed action constitutes `PROMO_APPLY`: a separate Apply action or a qualified `ORDER_SUBMIT`. The current preview button is not automatically such an action. The server needs intent/code/scope proof and the correct BOUND → payment opportunity order. A code populated from a URL or text entry without confirmation does not create a touch.

A link touch and valid AutoApply do not require an additional Apply action for attribution. Refref retains S2/72h/R14.1 and campaign TTL. An authenticated account neither merges touches across devices nor replaces browser context. Login/logout/context rotation must not artificially restore a consumed touch.

OWNER-02: with valid attribution, the reward does not depend on whether the buyer used the discount. Refref calculates `D_rule` for `G−D_rule−C>0`; `D_applied` is the actual discount in the buyer price and money documents. An applied discount without qualifying attribution or BOUND before the first payment does not grant C. An unapplied discount cannot make an ineligible campaign eligible. A network error does not cancel a price already promised to the buyer.

Do not silently change the code, prices, or source IDs, or extend the original deadline, in an issued intent/retry. Allowing a code/offer change before payment requires an explicit reviewed transition that safely closes the previous payment opportunity. This feature is not described as already implemented in the current LMS UI.

## 5. First FULL, course updates, and independent access

OWNER has already selected dynamic course access. The initial ready-material snapshot proves what was available at purchase; it does not restrict the grant to one video version. Publishing a new lesson or updating a file after purchase does not create a new purchase, payment, FULL, or C. A separate service/independent new purchase requires its own contract and BOUND before payment if it participates in Refref.

`FINAL` concerns the partner's monetary right. A first view, course completion, last login, playback-token expiry, or a `FULFILLED` marker does not establish it. An entitlement does not expire when S5 ends, and FINAL does not cancel a consumer refund right. Refref C does not depend on progress telemetry. Personal lesson history is not included in the ordinary result.

**OWNER approved FX-C04: the first LMS v10 profile uses `PAYMENT`.** Its qualifying payment event is actual first FULL. Record this profile/terms version before BOUND. An immediate-access course must not receive an invented scheduled end date or use the number of days in a fiscal period. A future live course or staged learning program would have a different contractual model; it must not silently be sold through the ready-recorded-materials profile. The selected mode does not qualify a provider or activate sales.

Before first FULL, local acceptance of a price/content change and Refref eligibility checks are independent. Persist the contract revision and its outbox atomically; safe execution does not wait for Refref ACK. Under R6.2, an ineligible FULL revision does not promise positive C, but an eligibility refusal does not delete BOUND or cancel the contract/money facts. An unknown result is not a refusal. An old FULL that actually occurred before a change but was discovered later belongs to the previous effective revision. A newer ACK/projection does not change its hash/time/C. If LMS does not need this feature at first launch, the UI may omit it; truthful recovery of a fact that has already occurred remains mandatory.

## 6. Refunds and LMS access revocation

Current source does not revoke access upon a request or REFUNDED projection alone. It requires its own successful execution and a canonical Refund linked to the payment/line/amount. Preserve this guarantee with the new independent merchant source. An operator decision, refund submission, bank acceptance of the operation, successful monetary refund, and access revocation are separate facts. New execution authority and provider read-back require separate qualification. Historical CIB/Alfa/Refref evidence does not transfer authority automatically.

A buyer refund does not wait for S4. Termination or retention of an entitlement follows the actual buyer contract and proven refund execution, independently of commission interests. S4 determines only binary C/0 under the canonical contract. A successful refund or local grant revocation does not itself change C. A mixed product/basket requires provable eligible money scope and the share of the service actually terminated. The standard v10 flow does not require reporting every refund.

A single access-start fact does not establish a “lesson viewed → no refund” rule. Current `course_access_starts` records an observation for a specific consumer refund review; it does not automatically legally qualify the entire service as rendered. With either an old or new refund UNKNOWN, money is not sent a second time and purchased access does not disappear on an assumption of success.

## 7. Free, manual, and bundle access have separate bases

| Scenario | Requirement |
|---|---|
| FREE course / freePreview | Preserve the applicable local access/consent policy. A zero-price purchase or lesson request is not reported as a qualified paid referral sale |
| Existing free enrollment after FREE→PAID | Preserve the existing local right on its own basis. Do not mint a new FULL/C for migration |
| Manual entitlement | Preserve actor/reason/evidence/legal terms and the original manual snapshot. This is not a bank payment or a basis for C. Distinguish manual authority from a purchased grant when revoking it |
| Paid organic purchase | Native payment/access/fiscalization apply. Without BOUND, an automatic organic stream to Refref is not mandatory, and there is no retroactive attribution |
| COURSE_BUNDLE / ALL_COURSES | An existing grant retains its scope, including future courses. **Neither acceptance of one course nor this plan admits new public bundle sales.** They retain their own product/fiscal/provider gate |
| Retired V1 | Archive history and original-provider recovery require separate authority. Do not restart public V1 or import it as fabricated V2/v10 orders/BOUND |

## 8. Checks before implementation/profile activation

These checks make the existing profile conditions concrete. They do not reopen O1–O7 for approval or impose mandatory external legal review, which OWNER previously removed.

- Qualify native acquiring/refund/fiscal providers, the seller's/agent's actual authority, execution/recovery, and exact source mapping. Until qualified, the adapter is not payment truth.
- Preserve the accepted ready-materials/dynamic-access model, exact approved buyer-facing bytes, and OwnerLegalDecision. A new bank/provider contract or changed obligations require new attributable evidence; renaming an old qualification is insufficient.
- Implement the approved LMS `PAYMENT` mode, first-FULL event, and `fullPaymentDueAt = addMoscowCalendarDates(purchaseCreatedAt, 7)` with the frozen FX-C12 policy. Values must be visible before BOUND and must not be derived from a first view or player TTL.
- The first profile supports one full payment. Any future schedule needs separate admission. Mikluha tourism deposits do not impose a requirement on LMS. Credit approval does not replace an actually executed payment.
- Verify action/holder/BOUND, original fingerprint/recovery, independent delivery of revisions/FULL, and late context. A network failure must not require a changed customer ID or new order.
- Access/consents/DRM remain independent of C/FINAL/S4/partner payout. Preserve privacy/erasure restrictions and verifiable recovery of existing access.
- Obtain separate source/contract, running transport, and provider/evidence E2E verdicts, followed by the profile's public GO. New LMS v10 is **NOT_RUN** on all three axes here. This file and the existing checkout do not prove completion.

The acceptance program must separately test: valid BOUND → native full payment → access and one FULL/C; a Refref outage after BOUND with access and no second charge; money UNKNOWN without a new create; FULL for an unknown/ineligible revision; a late old FULL and old ACK; no Apply/no attribution; Refref-only code handling without a merchant-coupon fallback; the seven-Moscow-date exclusive boundary without reset on retry/requote; reported CANCELLED resume versus genuine termination; pending execution/late FULL after the deadline; dynamic-grant preservation after updates; consumer refund/access independently of S4; free/manual/bundle exclusion; and preservation of old RC.2 tails.
