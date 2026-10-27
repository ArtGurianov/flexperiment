# Fiscal, legal and data impact

Status: proposal for review, 27 October 2026. A map of required changes and admission conditions, not a legal opinion, a chosen tax profile or a published offer.

## 1. Three separate bases

| Area | Source of truth | What does not replace it |
|---|---|---|
| Buyer contract | Acceptance of a specific version of the offer before payment ([legal control](../../commerce-v2/src/legal-control.ts)) | A Refref `BOUND` or `PAID_IN_FULL` |
| Money and receipts | Confirmed provider operation; separately the fiscal document | Browser return, a created payment session, a receipt request without a result |
| Referral commission | `BOUND` stored before payment and the first actual full payment, under Refref rules | Access activation, ticket issue, a receipt |

## 2. What changes

| Today | Change for new v10 purchases |
|---|---|
| Refref's checkout runs the payment and, under `fiscalizationMode=PROVIDER`, the receipt; the shared snapshot carries fiscal items ([checkout-snapshot.ts](../../commerce-v2/src/checkout-snapshot.ts)) | Flexperiment's own acquiring and fiscal profile issue receipts (FX-C01, FX-C02). The Refref v10 snapshot carries no fiscal items |
| Owner-approved single `FULL_PAYMENT` receipt model for course access, technical admission pending ([ART-234 research](../legal/ART-234_FULL_PAYMENT_RESEARCH.md)) | Re-qualify for the native provider and register: the earlier analysis of who hands over the subject of settlement depended on the payment intermediary's role |
| LAB closing receipts tracked separately (ART-309) | Keep separate: an advance receipt at payment and the closing document after the occurrence follow the qualified LAB policy, never a Refref event |
| Per-offer qualified fiscal policy frozen into the order line ([fiscal-policy.ts](../../commerce-v2/src/fiscal-policy.ts)) | Keep as the only source of receipt semantics; a new policy version is needed for the native profile |
| Refunds through Refref, full only | Native refund receipts tied to the original settlement; partial refunds only if FX-C05 allows them and the provider supports them |

A receipt timeout is not a new payment and not a missing payment: read the result back before any retry, as the existing incident practice requires.

## 3. Buyer documents

| Document | What to prepare as a new version | Not decided here |
|---|---|---|
| Course and LAB offers, payment rules | Flexperiment as the party that accepts payment through its own provider; refund and cancellation terms per product (FX-C05); how a promo code is applied | Prices, refund amounts, providers |
| Privacy policy and consents | Refref as recipient of minimal referral data under an instruction; no buyer identity in referral data | New consent wording without legal review |
| Partner-facing campaign terms | Product kinds, finality mode, the fact that course access or ticket use does not change the commission | Commission rates |

Published texts that describe Refref as the payment intermediary stay valid for purchases made under them; the new versions apply to new purchases only after their own publication.

## 4. Personal data

Refref receives opaque ids, origins, eligible lines and money amounts — never an LMS account, a guest email, a name, a phone or card data. A data map lists for each class: purpose, basis, recipient, storage location and retention. Erasure of a buyer ([erasure modules](../../commerce-v2/src/erasure-request.ts)) must keep the money and fiscal evidence the law requires and the referral facts Refref needs, without keeping personal data longer than allowed.

## 5. Public repository boundary

This repository is public. Real keys, provider payloads, buyer data, partner bank details and signed acts never enter Git, CI logs, PRs or tickets. Refref's internal procedures are referenced, not restated; the private Refref links need access.

## 6. Admission gates

| Gate | Result required before the affected sales |
|---|---|
| FL-01 Provider and receipts | Qualified native acquiring and fiscal profile for courses, bundles and LAB, including refunds and unknown outcomes |
| FL-02 Buyer terms | Reviewed and published versions for new purchases; acceptance checked at the payment boundary |
| FL-03 Referral data | Instruction to Refref, data map, retention and erasure rules |
| FL-04 Partner payouts | Payer account, registry process and reporting in place (FX-C07) |
| FL-05 Acceptance | Separate verdicts for source/contract, served transport and provider evidence; this document proves none of them |
