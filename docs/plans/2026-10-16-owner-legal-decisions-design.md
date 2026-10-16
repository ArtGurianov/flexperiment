# Owner-approved legal evidence (ART-234 / ART-39)

Owner authority: the 16 October 2026 decision abolishes mandatory external
counsel approval in Flexperiment and Refref. MONEY HOLD remains in force.

## Decision

Append migration 0027; never edit migration 0017 or rewrite historical
`counselRef`, qualified policies, order snapshots, or approved review.3 bytes.
Create immutable, versioned `OwnerLegalDecision` records per offer. Each names
an existing immutable fiscal policy (therefore all five fiscal fields and its
product kind), the actual product, an approved offer/refund reference and exact
hashes, a legal release snapshot, applicable norms and reasoning, factual model,
risk assessment, owner identity, approval reference, evidence SHA-256 and date.
Recording evidence is separate from qualification; it asserts an actual owner
decision, not AI approval or verification of a signature. Production execution
must independently verify the referenced evidence and owner authority.

New fiscal qualification accepts an existing owner decision only. SQL guards
bind that decision to this policy, product, offer, exact legal release and owner;
legacy counsel-only input cannot create new qualifications. Existing qualified
legacy policies remain readable/retirable and frozen orders stay unchanged.
New owner-backed policies stop new checkout when their legal release changes.
Decisions cannot be updated/deleted: corrections require another version.

Keep the decision model internal: no customer-facing legal claims, payment
side effects or production data backfill. The normal checkout/consent, sale-mode,
provider, fiscal and erasure guards remain. Review the added merchant-only
evidence table for restore/retention admission; retain the old schema hashes.
Do not repin an installed fast-cut controller before a concrete install packet.

## Alternatives

1. Merely make `counselRef` optional: rejected; empty evidence could qualify.
2. Rename it to `ownerRef` in JSON: rejected; no immutable decision or binding.
3. Separate immutable decisions (selected): an additive schema change provides
   durable provenance without rewriting genuine historical evidence.

Refref has no runtime counselRef. Change its canonical checklist, ADRs,
invariants and roadmap to documented owner approval. Preserve real historical
counsel packets and approvals, independent ORD/counterparty obligations and
RESTRICTIVE-only coupon behaviour. Regenerate consolidated documentation.

## Fiscal investigation and admission

Research FNS letter 06.09.2023 AB-4-20/11334@, current 54-FZ/FFD, the actual CIB
agency contract and Tochka API. Access follows provider PAID; it is not atomic
with payment. A competitor's contractual completion clause or an accepted enum
is not proof of lawful one-cheque settlement. If agency/offset support remains
unproven, report the precise fact/capability gap; do not qualify FULL_PAYMENT,
activate checkout, create payment, or introduce a fictitious decision.

## Verification

Test fresh/upgrade migrations with a real legacy qualified row; preserve its
raw evidence and frozen order references. Test direct-SQL bypasses, missing or
cross-policy decisions, changed legal releases, immutability and audit writes.
Run fiscal, checkout, closed-paid-profile, retention/restore tests and applicable
CI. Bind any images/install receipts to the new exact merged source; previous
source/image CI does not prove this change.

## Owner's final clarification: ready-material full payment

The subsequent owner decision fixes the main basis to initial access to already
recorded, published materials, automatically activated after accepted payment;
continuing availability and refund rights remain. Use one FULL_PAYMENT receipt,
not a cash-basis exception for an unverified intermediary scenario. Recheck
published material/video readiness before a payment session; freeze the provided
material set outside Refref's commercial snapshot and retain activation/payment
observations. Future/unpublished content must not enter this immediate-access
path. This adds no second receipt and changes no approved customer document bytes.
