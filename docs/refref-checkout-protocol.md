# Refref checkout protocol (ART-30, ART-183–189)

The merchant implementation is contract-tested engineering functionality, **not** proof of live production money movement or production entitlement acceptance (ART-240).

## Flow and authority

`handoff → resolution → checkout attempt → payment session → return read/background polling → fulfillment ACK → refund request/read-back`.

Use a signed HMAC-bound handoff state. Checkout constructs a frozen legal/fiscal snapshot from the live offer with its hash; quotes expire after 15 minutes. A stale display price never authorizes payment. Merchant promotion resolution precedes Refref checkout-code handling. Refref owns accepted payment/refund state, the merchant owns entitlement/projection and fulfillment effects.

All external creation commands have durable idempotency and outbox-style attempt state. An unknown outcome is recovered by reading `merchant-orders`/attempt/session before deciding whether a new command is safe; never blindly replay. On return, perform an immediate read, **without waiting for scheduled polling**, then continue background reconciliation for late/ambiguous outcomes. Grant each accepted payment exactly once; acknowledge fulfillment exactly once and persist ACK recovery state.

Refunds use frozen item-level fiscal evidence and line allocations; preserve distinctions between full and partial capabilities. Reconcile partial refund projections and ambiguous refund outcomes by provider/Refref evidence, never by amount-only matching or optimistic local assumptions. A full-only production provider must deterministically refuse partial refunds before any provider call. Refref webhooks may later supplement the reconciliation loop without becoming an alternate authority.

Evidence: Flexperiment F7 integration (ART-30, ART-184–188), Refref merchant API contract and conformance suite (ART-90). Production payment acceptance remains a separate guarded milestone.
