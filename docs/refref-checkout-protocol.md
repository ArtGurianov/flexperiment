# Refref checkout protocol (ART-30, ART-183–189)

The merchant implementation is contract-tested engineering functionality, **not** proof of live production money movement or production entitlement acceptance (ART-240).

## Version and rollout boundary

New orders use ADR-139 browser-context resolution: Buy → authoritative price and documents → explicit acceptance → payment. `REFREF_CHECKOUT_VNEXT_STOREFRONTS=COURSES` and/or `LAB` opt each profile in independently, together with `REFREF_VNEXT_API_BASE_URL` and the existing browser-context configuration. Empty profile configuration refuses new Refref checkout. Neither configuration nor source tests open the owner's storefront switch.

The new flow never calls the handoff entry. That entry returns 410. The return endpoint and historical HANDOFF phase remain solely for already persisted RC.2 intents and signed payment return. Direct payment-return state is minted from the owned durable quote, without a handoff token or browser-supplied order/origin. New vNext requests retain B1's original payload, context, price and deadline through reload/lost ACK. A missing or uncertain resolution cannot start payment. Rejected promo messages do not discard the promised Arrival discount.

ART-398 additionally provides an opt-in `purchaseManifest` rail capability using frozen input/1 and payable/2 (ART-394/417, D231). The published contract currently has **no served v9 endpoint**. The merchant stores its input before RPC, checks schema/hash/economics before review, binds acceptance/payment/refund to the payable snapshot, and requires a verified qualification before a v9 grant. The existing RC.2 payment rail refuses this capability explicitly. Portable fixtures and a supplied test rail qualify the consumer source seam; ART-400/412 still own real financial conformance/admission. See [v9 contract status](refref-v9-contract-status.md).

## Flow and authority

`browser context → resolution → price/documents → explicit acceptance → checkout attempt → payment session → signed return/readback → fulfillment ACK → refund request/readback`.

New LMS reviews require the pinned Stage B purchase documents and deliberate acceptance even outside the closed-paid-test profile. LAB retains its separate guest legal acceptance and merchant-held seats. Buyer session storage retains replay keys and the submitted promo, then reload re-reads the authoritative quote. It never persists acceptance as permission to pay.

Historical handoff recovery uses its original signed HMAC state. Checkout constructs a frozen legal/fiscal snapshot from the live offer with its hash; quotes expire after 15 minutes. A stale display price never authorizes payment. Merchant promotion resolution precedes Refref checkout-code handling. Refref owns accepted payment/refund state, the merchant owns entitlement/projection and fulfillment effects.

All external creation commands have durable idempotency and outbox-style attempt state. An unknown outcome is recovered by reading `merchant-orders`/attempt/session before deciding whether a new command is safe; never blindly replay. On return, perform an immediate read, **without waiting for scheduled polling**, then continue background reconciliation for late/ambiguous outcomes. Grant each accepted payment exactly once; acknowledge fulfillment exactly once and persist ACK recovery state.

Refunds use frozen item-level fiscal evidence and line allocations; preserve distinctions between full and partial capabilities. Reconcile partial refund projections and ambiguous refund outcomes by provider/Refref evidence, never by amount-only matching or optimistic local assumptions. A full-only production provider must deterministically refuse partial refunds before any provider call. Refref webhooks may later supplement the reconciliation loop without becoming an alternate authority.

Evidence: Flexperiment F7 integration (ART-30, ART-184–188), Refref merchant API contract and conformance suite (ART-90). Production payment acceptance remains a separate guarded milestone.

## Handoff binding and ambiguous remote creation (ART-30/186)

HMAC handoff state must bind the authenticated buyer, preallocated `orderPublicId` and the exact return path/origin: never accept an otherwise valid handoff state for another customer or redirect destination. The 15-minute quote is revalidated at checkout confirmation, not independently at attempt/session boundaries. After a timeout or unknown create outcome, read `GET /integrations/merchant-orders/{id}` **before any replay**, recover the persisted attempt/session identifiers and verify the returned frozen checkout snapshot hash against the expected hash. A mismatched hash is a hard conflict, not a license to recreate. Return-page read-back is immediate; background polling is the independent convergence path.

The paid checkout sale-mode gate re-reads the current live offer at preview, re-preview and confirmation; CLOSED refuses, ACCEPTANCE_ONLY requires the designated offer and verified buyer allowlist, and PUBLIC requires evidence qualified for the exact product kind. ONLINE_COURSE acceptance ART-240 cannot activate COURSE_BUNDLE; LAB uses ART-243.

## Terminal recovery and delayed qualification (PR #279 review)

LMS clears saved preview/payment keys after the server confirms DECLINED/EXPIRED, quote expiry/staleness, or explicitly permits a new pre-payment intent after refusal/request mismatch. A consumed intent never permits that mismatch reset. Promo stays frozen with the preview key. PENDING, CREATE_UNKNOWN and unavailable readback retain the previous purchase identity. A new intent requires a new explicit buyer action and fresh acceptance.

LAB's “Начать новый заказ” first calls the same-origin, capability-scoped `POST /v1/lab/guest/restart`. The server performs read-only payment reconciliation; an existing attempt permits restart after definitive DECLINED/EXPIRED or PAID. A paid purchase retains its ticket/history; a later explicit purchase creates a distinct order and ticket. A missing payment is checked under the same write lock that retires the old quote/seat hold and records `LAB_CHECKOUT_RETIRED`. That durable marker fences stale confirmations and delayed first previews. Old capability-based history remains readable. The browser rotates capability/replay keys only after this succeeds, enabling a changed promo; an unknown/review/refund/unavailable result never clears them. Valid same-capability/email guest-start replay does not spend creation quotas; the browser skips start when its order identity is already saved.

Background reconciliation also revisits a known v9 attempt in REVIEW_REQUIRED specifically for PURCHASE_QUALIFICATION_UNVERIFIED and a frozen payable/2. It has no creation admission, verifies the original acceptance/payable/payment binding, and grants/ACKs once after valid bank qualification arrives. Other manual review classes are not polled by this addition.


Restoring either storefront reads the frozen intent without automatically navigating to a bank or ticket page. A returned HTTPS payment URL is exposed as an explicit continue-payment link. LMS signed payment return uses the catalogue course slug, with `/courses` fallback. Unknown or foreign confirm quotes return the same 404 without logging a server failure.

Transport ambiguity retains the resolution identity and performs by-order readback. A structurally valid response with wrong vNext bindings/lines/totals commits REFUSED, including after readback; pure purchase-contract and prohibited-handoff validation also commit refusal before returning an error. Re-preview of a refused intent performs no RPC and its LAB hold no longer counts. The immutable audit evidence is supported by the append-only `0036_checkout_audit_indexes.sql` migration; earlier migration bytes are unchanged.

An HTTP success body that fails the vNext response schema is still an ambiguous response: malformed `storefrontOrigin`, unexpected `customerActionUrl` or unreadable/missing fields do not establish a trustworthy committed resolution. The rail attempts by-order readback; if that also fails validation, preview returns RESOLUTION_PENDING under the same frozen request/order/key. No payment may start. The original intent deadline remains in force (at most 15 minutes from creation, or an earlier quote/seat-hold/service-start deadline); replay never renews it. An unconfirmed LAB hold stops counting at that deadline even before a later preview persists EXPIRED. This conservative schema-failure behavior is covered by `vnext-resolution.test.ts`.

While LMS resolution is pending, its saved promo cannot be changed and no “new purchase” control replaces the intent. The buyer can repeat the same check and is told that the calculation lasts at most 15 minutes from its first check. A confirmed refusal or expiry permits a new promo/key. Immediate cancellation/replacement would need a separate server transition and cross-tab admission rules; this PR keeps the frozen-request recovery contract.

Deployment of migration 0036 and the corresponding exact schema admission is part of the [ART-398/379 controlled rollout plan](release/ART-398_ART-379_CHECKOUT.md), not implied by source tests or CI.
