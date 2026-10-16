# Owner legal/compliance decisions — ART-234

Current authority, 16 October 2026: the owner explicitly abolished mandatory
external counsel approval in Flexperiment and Refref. The owner decides on
recorded facts, applicable norms, reasoning and risk review. Specialist advice
can be evidence but is not a mandatory dependency. Historical opinions remain
what they were; an owner statement is never relabelled a counsel opinion.

## Model and evidence

`OwnerLegalDecision` is an append-only, versioned merchant record, separate from
fiscal qualification. Migration 0027 adds it without changing previous migration
bytes, `counselRef` JSON, policies, order-line foreign keys or frozen snapshots.
It binds an actual product/offer to an immutable fiscal-policy ID (including
item name, kind, tax system, VAT, payment method and payment object), an exact
legal-release ID/version/manifest, offer/refund references and SHA-256s, norms
and primary-source URLs, facts, reasoning, risk assessment, owner identity,
actual approval reference/date and evidence SHA-256. The approving owner and
the importing operator have separate identities; recording evidence does not
assert that the operator authored the owner decision.

Use `recordOwnerLegalDecision` only after independently checking the evidence
bytes and real owner instruction. It records an assertion by the trusted
operator, not a signature verification, substantive automated legal review or
AI approval. No public endpoint, seed, migration, or automatic fallback records
owner approval. No production approval or qualification is created by this PR.

`qualifyFiscalPolicy` accepts `ownerLegalDecisionId` for new qualifications.
The SQL trigger also requires the matching policy, offer/product, owner and
current exact legal release. Transactional replacement preserves the previous
qualified version if admission fails. Current owner-backed policies refuse new
checkout after legal-release/version/content drift. Existing legacy qualified
policies remain readable/retirable; existing orders retain their original
snapshot/evidence. Historical counsel-only JSON cannot qualify a new policy.

Stage B document URLs/hashes must match the release. Existing Stage A domain
fixtures may name separately approved terms; this does not admit a live closed
paid profile, whose independent Stage B, exact manifest and consent guard stays
mandatory. Publication/consent, scoped sales, provider and fiscal gates remain.

## Privacy and recovery

New decisions are retained merchant/legal data, with no customer FK or runtime
credential. The added order-line material snapshot is retained financial evidence;
legacy order lines remain NULL, with no fabricated delivery history. Avoid customer data, secrets or receipt coordinates in narratives.
Possible subject mentions still block automatic erasure and preserve unbound
profiles for review. Restore/retention admit the exact reviewed 0027 fingerprint
alongside the unchanged 0025/0026 fingerprints; arbitrary DDL remains refused.
The independent erasure ledger/fence schema and authority do not change.

The installed fast-cut controller remains pinned to its 0026 source. This source
contains a separately reviewed 0027 controller; a future install needs exact
controller/source/image admission, fresh encrypted
backup and isolated migration/restore proof; a green test is not that proof.

## Owner decisions already supplied

The owner creates the informational video materials and grants personal viewing
through the platform, without downloading, distribution, copies, commercial
reuse, a separate educational programme, attestation or mandatory teacher
support. These are recorded owner facts; per-video external legal review is not
required. The owner confirmed SERVICE, FULL_PAYMENT, USN_INCOME, continuing VAT
exemption and the one-ruble price/full refund. Financial fees remain seller-paid;
the additional refund-cheque fee risk is accepted.

The latest instruction fixes the intended fiscal scenario: **one FULL_PAYMENT
receipt for platform access**. It does not authorize implementation of a second
closing receipt. Do not replace these facts with an invented specialist opinion,
change the payment amount or silently qualify an unsupported fiscal flow.

[Settlement investigation](ART-234_FULL_PAYMENT_RESEARCH.md) separates this
owner choice from the approved ready-access model from the unclaimed cash-basis exception for intermediaries.
The final owner clarification approves FULL_PAYMENT for ready recorded access
with automatic activation and retained payment/material/activation evidence.
The previously sealed specialist brief is superseded as a mandatory dependency;
it remains historical evidence. Approved review.3 customer bytes are unchanged.
AUTONOMOUS INSTALLATION GO remains; MONEY HOLD remains.


The owner further clarified that the purchased object is access to the evolving
course. Course-scoped entitlement follows its current published contents;
historical initial-content evidence never narrows that entitlement. Proposed
[review.4](closed-paid-test/2026-10-16-review-4/README.md) aligns the wording and
receipt label. Review.3's approved covered bytes are retained.
