# ART-234 — one FULL_PAYMENT receipt: evidence and remaining fact

Research date: 16 October 2026. **OWNER MODEL APPROVED / TECHNICAL ADMISSION PENDING / MONEY HOLD.**
The owner approves the informational-access model and explicitly requires a
single FULL_PAYMENT receipt for platform access. No second closing-receipt
implementation is authorized. Mandatory external counsel approval is abolished;
[owner evidence](OWNER_LEGAL_DECISIONS.md) is the internal authority.

## Normative source and actual timing

[FNS letter 06.09.2023 AB-4-20/11334@](https://www.consultant.ru/document/cons_doc_LAW_456689/)
is the primary agency explanation, reproduced by ConsultantPlus (not a newly
issued individual FNS answer). It distinguishes an agent receiving money from
a supplier handing over the subject of settlement. Its cash-basis, buyer-consent
one-cheque explanation is conditional; it separately excludes an agent which
only receives prepayment rather than handing over the subject. Thus USN plus
buyer consent alone does not establish applicability to a third-party KKT.
The letter is interpretative guidance, not a statutory amendment; it must be
read against the actual obligations and roles, not a receipt tag alone.

The binding baseline is 54-FZ, notably articles 1.1, 1.2 and 4.7, and the
[official FNS FFD order ED-7-20/662@](https://www.nalog.gov.ru/rn77/about_fts/docs/10020801/)
with its published amendments. Payment-method tags describe the actual
settlement; an accepted API enum is not legal qualification. A competitor's
service-completion clause is not proof of our provider's role or execution.

Observed source sequence: Refref creates a payment session; bank PAID is read
back; Commerce validates amount and snapshot hash; a SQLite transaction marks
the order FULFILLED and grants entitlement; Refref fulfillment acknowledgment
follows. Payment and grant are not one atomic operation. An acknowledgment is
not itself a closing fiscal receipt. Network failure, erasure fence or a stopped
Commerce process can defer the grant. This is not proof that access always precedes receipt emission. The owner's
subsequent decision treats initial automatic activation after accepted payment
as the initial provision of a ready-access service; it does not require an
impossible distributed database/bank transaction or claim immunity from outages.

## Actual provider evidence

The [CIB/Tochka contract](https://digitalkassa.ru/wp-content/uploads/2025/12/dogovor_ob_okazanii_uslug_tochka_receipt.pdf),
PDF SHA-256 `f9d0fc5e3d6e3abb22f270198eb172c46baa24971d57416f6cb9868536bbfc14`,
provides for payment/refund fiscalization using CIB's registered KKT/FN (§§2.2–2.4)
and cites civil agency under article 1005. It does not establish that CIB grants
platform access. A civil agent, an acquiring bank, a statutory payment agent and
the seller are distinct roles: neither the historical AGENT tag nor the IP's
USN status resolves their precise interaction by itself. The historical receipt
confirms CIB and the seller details, not a current legal exception for this flow.

The [official Cheki product page](https://digitalkassa.ru/servis-checki/) advertises
own-KKT receipts for online stores/schools. That supports product suitability in
general; it does not document this specific settlement timing. Its general
advertised price is not substituted for the approved dated Tochka tariff.

[Tochka payment-with-receipt API](https://developers.tochka.com/docs/tochka-api/api/create-payment-operation-with-receipt-acquiring-v-1-0-payments-with-receipt-post)
creates a payment link with fiscal items. Refref's adapter maps FULL_PAYMENT and
FULL_PREPAYMENT, passing email, tax system and items. It has no independent
fulfillment-linked receipt command. Changing an enum cannot establish the
provider's authority or cause a settlement-offset receipt.

[Public Digitalkassa API 2.1](https://api.digitalkassa.ru/v2.1/doc) separately
documents receipt creation/read-back and an amount.prepayment field (FFD1215).
The actual downloaded OpenAPI describes BasicAuth and a cash-register group.
Those public capabilities do not establish access under the existing Cheki
contract or the existing bank JWT. No account, API key, cash-register group or
bank integration was changed; no such receipt was submitted.

An [official bank explanatory article](https://tochka.com/knowledge/acquiring/cheki-na-avans-i-na-predoplatu-kak-ne-narushit-zakon-54-fz/)
describes ordinary advance/settlement receipts; it does not prove their necessity
or applicability to this informational-access service. The Cheki user-guide PDF
was also found on docs.tochka.com, but direct retrieval failed TLS chain
verification; verification was not disabled and its contents are not evidence.

## Subsequent final owner decision and admission

The owner supplied a final dated position: initial access to already recorded
informational materials is the service; activate it automatically after accepted
payment and retain continuing availability/refund obligations. This supersedes
the earlier proposed provider-fact HOLD as the main qualification path. No
external specialist opinion is required. It is a real owner legal position,
not an independent opinion or a statement made by the bank.

The additional [FNS letter 06.10.2023 AB-4-20/12817@](https://www.consultant.ru/document/cons_doc_LAW_460674/)
was independently read: its final paragraphs explain cash-basis treatment of
full prepayment. The document's subject is restaurant KKT checks; it is not an
individual ruling for Flexperiment or a verified exception for this CIB agency
arrangement. The selected primary basis is actual initial ready access, not
extension of the cash-basis exception to an unverified intermediary scenario.

Execution conditions for the owner-backed FULL_PAYMENT online-course path:

- An actual published projection, currently published non-withdrawn lessons with active bindings to provider-confirmed READY videos of positive
  duration. No sale of a future course/video through this path.
- Retain an observation of initial materials/version/content hash on the order
  line, separately from Refref's commercial snapshot. This is historical evidence,
  not the purchased scope. The entitlement is to the course and includes later
  published additions/updates. Ready content changes do not invalidate a price
  quote; recheck initial availability inside order creation before a payment
  session exists. A wholly unpublished/future course remains ineligible.
- Verified matching PAID, FULFILLED state, entitlement and first activation audit
  are committed together; replay does not duplicate access or audit. The event
  records the application's observation/activation time, not an invented bank
  settlement timestamp. The original provider projection is retained as well.
- An interruption or failed grant remains a reconciliation/support/refund case;
  do not claim fictitious access or manufacture fiscal success. Existing receipt
  read-back/refund evidence still has to be collected during the authorized
  money run. Watching lessons is not a prerequisite for initial performance.

Approved review.3 is preserved unchanged. Proposed review.4 clarifies access
  to the evolving course (initially one recorded150-second lesson), includes
  subsequent course additions/updates without another course purchase, and
  names the receipt item “Доступ к курсу «Test Course»”. Price/full refund remain
  1 ₽. Exact review.4 approval/publication/hash read-back are pending separately;
  the owner's general model confirmation is not fabricated exact-byte approval.

The new owner decision/evidence can support a real qualification after exact
source CI, images, fresh backup/restore, migration and ready-content read-back.
No actual production decision or qualification is claimed by this source PR.
A second closing receipt remains outside the owner's chosen scope. Separate
financial GO is still required; installation authority remains autonomous.


The owner further clarified that the purchased object is access to the evolving
course. Course-scoped entitlement follows its current published contents;
historical initial-content evidence never narrows that entitlement. Proposed
[review.4](closed-paid-test/2026-10-16-review-4/README.md) aligns the wording and
receipt label. Review.3's approved covered bytes are retained.
