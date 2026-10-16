# ART-234 — one FULL_PAYMENT receipt: evidence and remaining fact

Research date: 16 October 2026. **Not a fiscal qualification or payment GO.**
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
Commerce process can defer the grant. There is no source-level proof that
access is provided before the provider's initial receipt.

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

## Decision boundary and next executable step

**ONE_RECEIPT_FULL_PAYMENT_APPLICABILITY_NOT_ESTABLISHED.** This is not a claim
that all Cheki digital-access sales are unlawful. The present evidence does not
establish why the one-cheque rule covers CIB's own KKT and the documented delayed
entitlement sequence. Owner confirmation of the desired value is real, but is
not replaced with a fabricated normative exception or a fabricated provider fact.

The narrow missing fact is a documented account of CIB's settlement role and the
basis/timing of its single full-payment receipt for platform access granted
after PAID. A public applicable provider document or an existing written provider
explanation can supply facts; no external legal opinion is mandatory. The owner
then approves a versioned decision tied to the actual model and exact documents.
No repeated fee approval, new OFD login or per-video specialist review is needed.

If the only available supported scheme requires a second receipt, it conflicts
with the owner's current scope: keep this operation closed and report that
capability conflict. Do not implement it, invent a right already delivered,
relabel another sale, switch fiscalization providers or collect money to test it.
The prepared software and CI can proceed independently. The new runtime,
qualified live fiscal policy, real buyer preview and payment are not claimed.
