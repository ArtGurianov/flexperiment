# Refref checkout protocol (ART-30, ART-183–189)

The merchant implementation is contract-tested engineering functionality, **not** proof of live production money movement or production entitlement acceptance (ART-240).

## Version and rollout boundary

The handoff flow below describes the retained RC.2 implementation and its
historical acceptance. ADR-139's browser-scoped Arrival contract is the target
for new checkout: ART-373/378 implement durable intent and arrival foundations;
ART-379 still owns explicit LMS/LAB checkout integration and each storefront's
own conformance. Their merge does not prove the whole new entry path deployed.

Refref v9 owner policy and Draft ADR-140 add service-unit rewards and cancellation
claims, with their own not-yet-implemented wire contract. See
[v9 contract status](refref-v9-contract-status.md). A customer refund/access
decision and a Refref decision about a partner's reward are separate. A bank
refund or entitlement revocation alone does not zero a v9 partner reward.

## Flow and authority

`handoff → resolution → checkout attempt → payment session → return read/background polling → fulfillment ACK → refund request/read-back`.

Use a signed HMAC-bound handoff state. Checkout constructs a frozen legal/fiscal snapshot from the live offer with its hash; quotes expire after 15 minutes. A stale display price never authorizes payment. Merchant promotion resolution precedes Refref checkout-code handling. Refref owns accepted payment/refund state, the merchant owns entitlement/projection and fulfillment effects.

All external creation commands have durable idempotency and outbox-style attempt state. An unknown outcome is recovered by reading `merchant-orders`/attempt/session before deciding whether a new command is safe; never blindly replay. On return, perform an immediate read, **without waiting for scheduled polling**, then continue background reconciliation for late/ambiguous outcomes. Grant each accepted payment exactly once; acknowledge fulfillment exactly once and persist ACK recovery state.

Refunds use frozen item-level fiscal evidence and line allocations; preserve distinctions between full and partial capabilities. Reconcile partial refund projections and ambiguous refund outcomes by provider/Refref evidence, never by amount-only matching or optimistic local assumptions. A full-only production provider must deterministically refuse partial refunds before any provider call. Refref webhooks may later supplement the reconciliation loop without becoming an alternate authority.

Evidence: Flexperiment F7 integration (ART-30, ART-184–188), Refref merchant API contract and conformance suite (ART-90). Production payment acceptance remains a separate guarded milestone.

## Handoff binding and ambiguous remote creation (ART-30/186)

HMAC handoff state must bind the authenticated buyer, preallocated `orderPublicId` and the exact return path/origin: never accept an otherwise valid handoff state for another customer or redirect destination. The 15-minute quote is revalidated at checkout confirmation, not independently at attempt/session boundaries. After a timeout or unknown create outcome, read `GET /integrations/merchant-orders/{id}` **before any replay**, recover the persisted attempt/session identifiers and verify the returned frozen checkout snapshot hash against the expected hash. A mismatched hash is a hard conflict, not a license to recreate. Return-page read-back is immediate; background polling is the independent convergence path.

The paid checkout sale-mode gate re-reads the current live offer at preview, re-preview and confirmation; CLOSED refuses, ACCEPTANCE_ONLY requires the designated offer and verified buyer allowlist, and PUBLIC requires evidence qualified for the exact product kind. ONLINE_COURSE acceptance ART-240 cannot activate COURSE_BUNDLE; LAB uses ART-243.
