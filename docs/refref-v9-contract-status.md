# Refref v9 contract status — LMS and LAB

Audit snapshot: Flexperiment `4859f2ac6c61afa9d9693ceb4d32b89b1802606c`,
Refref main `0e46c0ef982bafec2ab11d113ddada01fd214407`, 20 October 2026.
[Draft ADR-140 / PR #92](https://github.com/ArtGurianov/refref/pull/92)
contains approved owner policy O1–O10/P1–P7; its architecture and implementation
remain separate review/qualification work. This document records that boundary,
not a new API or deployment approval.

## Current producer and target

`commerce-v2/src/checkout-snapshot.ts` creates
`refref.shared-checkout-snapshot/2`; frozen V1 snapshots remain readable.
`lineRef` is persisted with the purchase intent; `unitRef` currently names an
occurrence when supplied, quantity is one, and service dates are optional in the
shared type. These fields do not constitute the target v9 ServiceUnit contract.
ART-373/378 provide intent/Arrival foundations; ART-379/380 own the new checkout
and profile conformance. Existing closed paid RC.2 evidence does not qualify
that whole entry path or the v9 financial model.

[ART-394](https://linear.app/art-gurianov/issue/ART-394) must freeze exact unit
identity/cardinality, manifest version/hash, monetary fields, replay keys and
required dates before dependent integration. LAB units identify the purchased
event or whole programme; their planned end is the P7 anchor. Immediate LMS
uses qualified purchase acceptance, never lesson progress or last login. Each
gets 14 calendar days; verified TOUR/LAB moves share a 30-day total extension
budget. Exact units and terms/deadlines survive catalogue edits.

## Money, access and fiscal events

The launch monetary profile requires one independently successful payment for
the entire frozen purchase. Full prepayment is allowed; fiscal FULL_PAYMENT is
not the definition of full funding. A later advance-offset receipt creates no
new payment, acquired unit or reward. LAB closing receipts remain ART-309;
course fiscal admission stays with its actual qualified policy and ART-234.

Refref creates per-unit PENDING rewards from one frozen order-scoped net-price
allocation. Ordinary cancellation affects only a timely upheld unit claim with
proven cancellation and an independently successful positive refund. Compensation,
refund alone and cancellation without refund preserve the reward. This does not
change Flexperiment's separate consumer refund/access obligations or justify
retaining/revoking access without the product's own policy.

ART-174/192/206 must distinguish customer decisions, bank execution/projection
and reward claims. External merchant refunds need independent qualification in
[ART-396](https://linear.app/art-gurianov/issue/ART-396); a full-only Refref
refund proof does not enable partial refunds. No automatic ordinary debt or
effect on RESERVED/SETTLED is permitted.

## Admission

Contract/consumer tests can run locally with synthetic evidence. Epoch tooling
is [ART-395](https://linear.app/art-gurianov/issue/ART-395); financial core is
ART-121/122, moderation ART-139 and POSTPAID settlement ART-385. Shared final
conformance ART-381 does not become a gate for free Stage A or another independent
storefront. No reset/backfill, bank operation, host change or public activation
is performed or authorized by this documentation update.
