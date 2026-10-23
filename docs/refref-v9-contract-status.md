# Refref v9 contract status — LMS and LAB

Audit snapshot: Flexperiment `4859f2ac6c61afa9d9693ceb4d32b89b1802606c`,
Refref main `0e46c0ef982bafec2ab11d113ddada01fd214407`, 20 October 2026;
target updated to [Draft ADR-140 revision 7](https://github.com/ArtGurianov/refref/pull/99)
on 21 October 2026 (owner decisions D1–D8). ADR-140 holds approved owner policy
O1–O10/P1–P7 as amended by D1–D8; its architecture and implementation remain
separate review/qualification work. This document records that boundary, not a
new API or deployment approval.

## Source implementation update — 23 October 2026

ART-398/379 source work now uses the accepted ART-394/417 payable/2 contract and D231. Vendored schema, unmodified oracle and portable vectors are pinned to Refref `93b6a41fc42b4d616f381d65573e20fceaf79e78` in `commerce-v2/src/refref-contract/README.md`. `purchase-manifest.ts` validates closed input/quote schemas and exact identities before consuming payable amounts. The durable intent freezes merchant input before RPC; explicit acceptance, fiscal amount and refund input use the same payable hash. A v9 PAID projection needs independently supplied bank-full-payment qualification; the saved bank-operation binding cannot be reused by another purchase. Receipt/offset events are never qualification inputs.

The opt-in v9 rail seam has no served transport: the current Refref contract explicitly does not add a v9 HTTP endpoint. RC.2 refuses v9 payloads. The multi-line/quantity/eligibility/cancellation vectors exercise contract consumption; the present storefront still purchases one offer per intent, and the merchant refund executor remains full-only. No basket UI, external partial refund or financial release is inferred. ART-400/412 and each storefront's runtime/provider acceptance remain open independent gates.

For an opted-in immediate LMS purchase, readiness and `accessProfile=IMMEDIATE` are checked irrespective of FULL_PAYMENT/FULL_PREPAYMENT. LAB input freezes the exact event end, IANA timezone and hash of the purchased schedule. Qualification supplies `purchaseQualifiedAt`; eligible services alone determine the latest anchor. Current vNext attribution integration is documented in [checkout protocol](refref-checkout-protocol.md).

The older audit below is historical context; its revision-7 policy is superseded for **new payable/2** purchases by D231: unique successful eligible-allocated refunds must total at least `min(original Commission, frozen eligible after-discount paid amount)`. A one-ruble refund alone no longer satisfies this policy unless it reaches that frozen threshold. Historical payable/1 snapshots retain their policy and are never rewritten.

## Historical audit — producer and target

`commerce-v2/src/checkout-snapshot.ts` creates
`refref.shared-checkout-snapshot/2`; frozen V1 snapshots remain readable.
`lineRef` is persisted with the purchase intent; `unitRef` currently names an
occurrence when supplied, quantity is one, and service dates are optional in the
shared type. ART-373/378 provide intent/Arrival foundations; ART-379/380 own the
new checkout and profile conformance. Existing closed paid RC.2 evidence does not
qualify that whole entry path or the v9 financial model.

Revision 7 makes the **purchase** the monetary unit: one qualified purchase has
one Commission, never distributed across lines or units. No per-unit reward IDs
are required. [ART-394](https://linear.app/art-gurianov/issue/ART-394) freezes
the purchase manifest before dependent integration (ART-398): lines, quantity,
merchant prices, eligibility, required dates with provenance, an explicit LMS
`accessProfile`, and two identities — the merchant input hash and the
Refref-resolved payable hash that quote, acceptance, payment and reward all bind.
Purchase identity and the bank payment binding are unique independently of
campaign, terms and partner.

LAB anchors on the planned event or programme end; immediate LMS anchors on
qualified purchase acceptance, never lesson progress or last login. A basket's
deadline runs from the latest anchor of its eligible services (D1.1) plus 14
calendar days; verified
TOUR/LAB moves share a 30-day total extension budget. Today
the pre-ART-398 checkout tied readiness evidence (`immediate_access_json`) to
fiscal FULL_PAYMENT while granting the entitlement on PAID; v9 derives the
access profile from the manifest, not from the fiscal tag.

## Money, access and fiscal events

The launch monetary profile requires one independently successful payment for
the entire frozen purchase. Full prepayment is allowed; fiscal FULL_PAYMENT is
not the definition of full funding. A later advance-offset receipt creates no
new payment, line or reward. LAB closing receipts remain ART-309; course fiscal
admission stays with its actual qualified policy and ART-234.

Refref computes the referral discount on the whole order and allocates it per
line (existing `000034` algorithm) only for receipts, payment documents and
customer refunds. The reward is one Commission from the eligible after-discount
total. Partial cancellation preserves it; a partial refund by itself changes
nothing. Only cancellation of **every eligible** service of the purchase — directly or by
successive cancellations — zeros it, together with an independently successful
refund whose positive amount is allocated to eligible lines by the merchant's
immutable per-line breakdown, equal to the bank amount, and a timely upheld claim.
For payable/2, D231 additionally requires the frozen threshold described above;
partial refunds with lawful retention qualify only when they reach it. The eligible
set is frozen in the payable manifest by campaign terms (D1.1): non-eligible
items never extend the deadline or block cancellation, and a refund allocated
only to them never zeros the Commission. Example: if an already delivered
immediate course and a LAB ticket are both eligible, cancelling only the ticket
keeps the whole Commission; if the course is not eligible, it does not matter. This does
not change Flexperiment's separate consumer refund/access obligations or justify
retaining/revoking access without the product's own policy.

ART-174/192/206 must distinguish customer decisions, bank execution/projection
and reward claims. External merchant refunds need independent qualification in
[ART-396](https://linear.app/art-gurianov/issue/ART-396); a full-only Refref
refund proof does not enable partial refunds. No automatic ordinary debt or
effect on RESERVED/SETTLED is permitted.

## Admission

Contract/consumer tests can run locally with synthetic evidence. Epoch tooling
is [ART-395](https://linear.app/art-gurianov/issue/ART-395); financial core is
ART-121/122, claim review ART-139, partner inbox ART-402 and the shared Better
Auth + membership foundation ART-17; POSTPAID settlement is ART-385. Shared final
conformance ART-381 does not become a gate for free Stage A or another
independent storefront. No reset/backfill, bank operation, host change or public
activation is performed or authorized by this documentation update (D8).
