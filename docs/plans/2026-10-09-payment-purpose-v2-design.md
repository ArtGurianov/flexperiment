# Merchant-owned payment purpose, V2 consumer

Approved PR63 follow-up; engineering only. No production migration, deployment, provider operation or sales activation.

`offers.payment_purpose` is explicit merchant business data. Add nullable SQLite migration0021, preserving historical orders and leaving legacy offers unset, never backfilling from title/fiscal/profile. Opening a paid offer requires valid exact text. Freeze it in the quote and then SharedCheckoutSnapshotV2; a changed offer makes a pending quote stale, not a previously accepted order different. Checkout refuses missing/invalid text before rail resolution or payment attempt.

Payload provides an authenticated UI editor backed by commerce's existing service-token boundary, with optimistic product version and audit. Do not persist a second Payload copy or change prices/sale modes through this editor. Paid course publication checks fresh commerce facts; service errors fail closed. Control Room can edit the same authoritative field. Keep service credentials server-only and do not install/rotate any credential.

Alternatives rejected: integration env maps put product facts in technical config; an ordinary persisted Payload field creates a second commercial authority. The native UI field plus narrowly scoped commerce command fits the existing content/commerce separation.

The snapshot builder requires one explicit order purpose independently of fiscal item names. Current checkout is single-offer, copies that offer value and does not introduce multi-offer cart architecture. Any future multi-offer caller must explicitly supply the order-level purpose; no automatic concatenation/default exists. Historical V1 canonical bytes/hashes, read-back, fulfillment and refund behavior remain supported; no history reinterpretation.

Test actual merchant checkout/catalog, Payload auth/editor/publication, missing values before rail calls, immutable old/new snapshots, digest parity with Refref and valid Unicode/Tochka bounds. Pin the real upstream commit and rebuild provenance independently for Refref conformance. Prepare separate PRs; merging and rollout require separate authorization.
