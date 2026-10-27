# Refref v9 contract status — LMS and LAB

**Historical target.** For the proposed merchant-native v10 transition of new
LMS/LAB purchases, start with the [v10 architecture](refref-v10/README.md).
That package retains pending profile decisions and separate implementation,
transport, provider and activation gates. It does not reclassify existing
RC.2/v9 history or change its original owner and applicable recovery rules.
The dated v9 audit below is preserved as historical context, not a v10 contract.

Audit snapshot: Flexperiment `4859f2ac6c61afa9d9693ceb4d32b89b1802606c`,
Refref main `0e46c0ef982bafec2ab11d113ddada01fd214407`, 20 October 2026;
target updated to [Draft ADR-140 revision 7](https://github.com/ArtGurianov/refref/pull/99)
on 21 October 2026 (owner decisions D1–D8). ADR-140 holds approved owner policy
O1–O10/P1–P7 as amended by D1–D8; its architecture and implementation remain
separate review/qualification work. This document records that boundary, not a
new API or deployment approval.

## Current producer and target

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
`checkout.ts:371` ties only the readiness evidence (`immediate_access_json`) to
fiscal FULL_PAYMENT while the entitlement is granted on PAID; v9 derives the
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
immutable per-line breakdown, equal to the bank amount (D1.2; any amount,
including partial with lawful retention), and a timely upheld claim. The eligible
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
