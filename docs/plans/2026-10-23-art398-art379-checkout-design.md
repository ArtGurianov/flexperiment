# ART-398 → ART-379: sequential source integration

Authority: existing Linear issues and owner Wave 1 slot 2 comments, read 23 October 2026. Public sales stay closed; no production, bank operations or deployment are part of this work.

## ART-398

Use ART-394/417's frozen input/1 and payable/2 schema, oracle and portable vectors pinned to the immutable upstream commit recorded beside the vendored sources. Separate merchant input hash from payable hash. Validate the closed schema before semantic bindings and arithmetic. The merchant never chooses campaign eligibility or reward policy. Preserve D231's original reward and eligible paid operands in the hashed payable snapshot.

Opt-in rail capability adds a purchase input to the durable intent before resolution and consumes a payable quote before review. Acceptance and payment creation retain that same hash; the fiscal/payment amounts come from its line allocations. Existing RC.2 intents retain their original wire and recovery path. v9 has no served endpoint yet, so its transport is an explicitly supplied rail capability, not an invented HTTP route. Tests qualify the source seam, not financial admission (ART-400/412).

LMS readiness is explicit and independent of FULL_PAYMENT/FULL_PREPAYMENT. LAB freezes its purchased end, timezone and schedule evidence. Multi-line, quantity, mixed eligibility, cancellation and refund policy are exercised through the published portable vectors and merchant boundary. The current storefront still sells one offer per intent; this task does not add a basket UI or claim a partial-refund provider capability.

## ART-379 (after the ART-398 commit and explicit rebase onto current main)

Use the existing vNext resolution endpoint and immutable B1 request; payment uses the existing accepted-resolution checkout API. New buyer requests never visit the RC.2 handoff endpoint. Preserve signed payment-return and historic RC.2 recovery. Require origin/context for vNext and verify response order, context, origin, hash, exact lines, totals and deadline. Unknown resolution never permits payment.

LMS: signed-in preview → final price/documents → explicit acceptance → payment, with persistent idempotency keys for reload recovery. LAB: the same resolution protocol on its own origin, existing guest identity/capability, legal acceptance and local seat hold. Retain independent storefront switches and acceptance evidence. Test backend routes and each buyer component separately with local fake Refref/provider responses; no claim of deployed browser or bank E2E.

## Review corrections (PR #279, baseline abb974a8)

All three supplied findings are confirmed. LMS clears quote/acceptance and both saved replay keys only on an authoritative DECLINED/EXPIRED result, including restored previews; unresolved outcomes and unavailable quotes retain their identity. No automatic payment retry follows the reset.

The sweep admits only v9 payable/2 REVIEW_REQUIRED attempts with a known remote attempt and PURCHASE_QUALIFICATION_UNVERIFIED. It passes no payment-creation admission. Exact accepted input/payable/payment identity is retained; invalid evidence still cannot grant access, and other manual-review classes remain excluded.

LAB uses a capability-scoped, same-origin POST /v1/lab/guest/restart. If payment exists it first reads that same attempt back without creation admission, allowing only definitive DECLINED/EXPIRED. If no attempt exists, the no-payment check, unconfirmed quote/hold retirement and durable LAB_CHECKOUT_RETIRED audit marker commit under the confirmation write lock. Confirmation and even a delayed first preview are fenced by that marker. Historical reads keep the old capability. Only a successful restart response lets the browser discard its session and choose new keys/capability/promo; unknown, paid and unavailable outcomes keep the old identity. No schema or production changes are needed.
