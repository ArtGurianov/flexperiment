# Fiscal, contractual and sector-specific impact for LMS/LAB

Review impact map dated 27 October 2026: the existing legal texts, policies/signatures, SQL and providers remain unchanged. The Flexperiment source baseline is `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; the new Refref boundaries are defined in [ADR-141](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/ADR-141-refref-core.md). Source evidence does not establish the currently installed version, active provider accounts or admission of a new sale.

Architecture and profiles: [01](01-commerce-architecture.md), [LMS](02-lms-profile.md), [LAB](03-lab-profile.md); [shared integration](04-refref-integration.md), [acceptance](06-migration-and-e2e.md). Mikluha tourism rules and its Unified Information System requirements do not extend to courses or workshops by analogy.

## 1. Existing OWNER decisions and new technical qualification

[OWNER_LEGAL_DECISIONS.md](../legal/OWNER_LEGAL_DECISIONS.md) and the [16 October plan](../plans/2026-10-16-owner-legal-decisions-design.md) preserve the expressly adopted decision:

- Ready recorded informational materials and automatic initial provision of personal access after accepted payment.
- The purchase grants access to an evolving course; the initial material snapshot is evidence, **not** a restriction to the old version. Subsequent published additions to that course are available under the purchased entitlement.
- The selected model for this qualified scenario is SERVICE/FULL_PAYMENT; **this project does not prescribe a new implementation of a second LMS closing receipt**.
- OWNER removed the requirement for a mandatory external legal opinion. The OWNER decision, with facts, legal provisions, reasoning, risks and evidence, remains a separate artifact. Specialist consultation is available but is not a hidden new mandatory gate.

OWNER has also approved the prospective v10 commercial profile: `LIMITED_CONTINUATION` for both LMS and LAB, seven Moscow calendar dates from the first durable `purchaseCreatedAt`, preserving the recorded time of day; LMS `PAYMENT` (FX-C04); LAB `SCHEDULED_SERVICE` (FX-C05), anchored at `max(actualPaidInFullAt, serviceAnchorAtAtBound)` with the service end frozen before BOUND. For the first single-full-payment profile, `fullPaymentDueAt = addMoscowCalendarDates(purchaseCreatedAt, 7)` for LMS and `min(addMoscowCalendarDates(purchaseCreatedAt, 7), salesCutoffAt)` for LAB. New payment instructions require `now < fullPaymentDueAt`; retries/requotes do not reset the period. Freeze the policy version at creation and apply it prospectively without rewriting existing rights. The seven-day window does not reserve a LAB seat or extend its original hold of at most 15 minutes; monetary/reservation fences and recovery remain independent.

Only Refref promo codes are planned (FX-C13); there is no Flexperiment merchant-code or stacking feature. OWNER-02, D_rule/D_applied and link/AutoApply behaviour remain applicable, and existing accepted prices/history remain intact. These approved choices do not qualify the actual product, parties, tax treatment, provider, legal documents or runtime, and do not authorise sales.

The ready-access LMS decision does not automatically qualify every future educational service, subscription, mentoring service, bundle or LAB offering. The previously approved ₽1 price/full refund and individual buyer belong to the closed Test Course; they do not become a v10 tariff, universal refund rule or public offer. Actual tax exemption, rates/tax regime and a specific party's authority cannot be inferred from a TypeScript enum.

Moving to merchant-native acquiring changes the technical payment/fiscal chain. The actual flow must be checked against the preserved OWNER model and selected documents: who receives the money, operates the cash register (KKT), acts as supplier, and generates/delivers sale and refund receipts. Refref no longer provides a buyer payment session, and BOUND alone does not appoint it as a bank or cash-register agent. This checks the actual arrangement; it does not reopen the decision on ready informational access.

## 2. Sources of the current project legal baseline

| Baseline source | What the source code/archive establishes | Consequence for v10 |
|---|---|---|
| [fiscal-policy.ts](../../commerce-v2/src/fiscal-policy.ts), [0017](../../commerce-v2/migrations/0017_fiscal_policy.sql) | Immutable offer-specific fiscal policy, DRAFT/QUALIFIED/RETIRED; policy frozen on the order line | Preserve version/provenance; a new provider does not turn DRAFT into QUALIFIED |
| [owner-legal-decision.ts](../../commerce-v2/src/owner-legal-decision.ts), [0027](../../commerce-v2/migrations/0027_owner_legal_decisions.sql) | Append-only OwnerLegalDecision links product/offer/policy and the exact legal release | New qualification relies on an actual decision/evidence. A correction is another version, not an overwrite of the historical counselRef/decision |
| [review.5](../legal/closed-paid-test/2026-10-16-review-5/README.md), [approval](../legal/closed-paid-test/2026-10-16-review-5/approval-record.json), [publication](../legal/closed-paid-test/2026-10-16-review-5/publication-record.json) | Approval/publication archive for the closed Test Course's manual email refund, REG.RU and unchanged ready-access scope | Scoped source evidence, not read-back of the current runtime or a LAB/public/v10 release. Prior consent does not transfer to a new manifest |
| [checkout.ts](../../commerce-v2/src/checkout.ts), [immediate-course-access.ts](../../commerce-v2/src/immediate-course-access.ts) | Material readiness and a separate activation record; bank projection, entitlement and audit are linked, but the bank and SQLite do not share one ACID transaction | Preserve observations/actual failures; do not fabricate performance or a new receipt to obtain Refref FULL |
| [lab-tickets.ts](../../commerce-v2/src/lab-tickets.ts) | LAB has its own Stage B manifest/acceptances, guest email evidence and a ticket after accepted payment | LMS documents/verified account email cannot substitute for LAB consent or guest email verification |
| [refunds.ts](../../commerce-v2/src/refunds.ts), [refref-payment-rail.ts](../../commerce-v2/src/refref-payment-rail.ts) | Separate request/decision/execution, full-only capability, sealed envelope and read-back | Customer refunds do not wait for S4; native/partial refunds require their own capability and evidence |

Some historical READMEs describe review.3/4 and pre-publication stages; an inventory is required before treating them as the latest active version. Neither this document nor the existence of a publication-record asserts live status on a future cutover date.

## 3. Independent lifecycles

| Event | Flexperiment buyer money/rights | Fiscal action / confirmation | Refref |
|---|---|---|---|
| Free LMS account/access | Separate Stage A terms and entitlement; no sale for money | Do not fabricate a monetary settlement | Do not create artificial FULL/C for free access |
| Buyer accepts paid terms | Specific subject/price/term/version and a confirmed action | Acceptance alone is neither bank receipt of funds nor fiscal success | BOUND may precede the payment opportunity if attribution requirements are met |
| Native operation created/approved/bank page returned | Intent, a third party's promise and redirect do not prove performance | A request created for KKT does not mean a registered receipt | Not FULL; payment UNKNOWN does not become NOT_PAID through a timeout |
| Actual full payment for ready-access LMS | Initial access activates under the accepted ready-access profile; state/audit and deferred recovery are retained | Preserve the OWNER FULL_PAYMENT scenario; verify actual native execution and receipt, without introducing a second closing receipt by default | One FULL under the actual effective revision; the approved LMS mode is PAYMENT. Access provision/receipt do not create a second C |
| LMS activation delayed/material unavailable | The payment fact remains; reconciliation/support/applicable refund, without fabricated access | Do not present an entitlement problem as a reversed sale receipt or an already corrected receipt | Preserve the truthful FULL report; financial qualification does not become LMS service delivery |
| Ready course receives later additions | The purchased course-scoped entitlement includes published additions under the preserved terms | No fabricated new payment for each update | No new purchase/FULL/C from a lesson, view or last login |
| Future LAB event fully paid | Ticket/place/contract and the right to attend; the workshop has not yet taken place | Select and qualify the actual LAB prepayment/settlement flow from facts; LMS FULL_PAYMENT does not transfer automatically | FULL may precede the workshop; the approved LAB SCHEDULED_SERVICE anchor is max(actualPaidInFullAt, serviceAnchorAtAtBound), with the service end frozen before BOUND; FINAL remains separate |
| LAB delivered / ticket marked USED | Service delivery and check-in are separate facts; one scan alone does not prove performance of an entire multi-session service | Where applicable, closing/offsetting prepayment depends on the LAB fiscal profile; it is not new receipt of money | No second FULL/C or new automatic S5 anchor |
| LAB rescheduled or agreed service replacement | Consent, a new contractual snapshot and allocations; prior documents are not overwritten | Check applicable correction/prepayment offset against actual movements, rather than issuing a universal receipt from a change event | Continuation preserves purchase/BOUND; the original S5 does not shift automatically |
| Additional partial payments, if separately supported | Only after selecting a business policy; Flexperiment keeps the actual balance/history | Qualify the corresponding prepayments/offset/refund | Each instalment is not FULL; subsequent actual fulfilment produces one FULL |
| Consumer refund | Decision and successful execution are separate; access/ticket consequences follow their own contract | Proper refund/correction linked to the original settlement and an evidenced receipt | Refund alone does not change C; an intended zeroing requires S4 with evidence |
| Partial/mixed refund | Money linked to service/line; unknown allocation is not guessed | Actual amounts/discounts/items; do not repeat the entire basket | FULL remains historical; C does not decrease proportionally |
| Partner payout | Separate merchant debt/register, not buyer acquiring | Tax/closing documents for the partner relationship are qualified separately | Distinguish merchant report/receipt/bank fact/S3; no new buyer FULL |

Mikluha's “30% + 70%” example becomes neither a mandatory LAB policy nor a reason to alter the selected single-payment LMS model. Prepayment for a future course, instalments, subscriptions/automatic renewal and service packages are not silently added to the first v10 profile.

## 4. Minimum fiscal adapter guarantees

- Separate payment operation, fiscal intent and provider document IDs; link source/revision/amount/currency/frozen policy/receipt recipient while keeping each subsystem's stage distinct.
- Obtain settlement item name/subject, tax profile, rates, settlement method and agent details from the qualified actual arrangement and accepted version, rather than a global Refref enum or an arbitrary merchant DTO.
- UNKNOWN after dispatch must not blindly trigger a second charge/refund/receipt. First read back using stable identity and verify the original outcome; known bank settlement does not become unknown solely because of a fiscal data operator (OFD) failure.
- Preserve the distinction between local intent, request acceptance, registered fiscal document and delivery to the buyer. Browser success, email acceptance, FULL and FINAL do not replace the document.
- In a mixed purchase, amounts/actual D_applied reconcile with actual obligations; calculated D_rule and partner C do not replace the customer price/fiscal totals.
- Link a refund to the original settlement and successful bank fact; a refund receipt does not prove returned money, and returned money does not prove the receipt is correct.

The source audit cites the official [Federal Tax Service order ЕД-7-20/662@](https://www.nalog.gov.ru/rn77/about_fts/docs/10020801/) for format and required fields. Distinguishing prepayment from transfer of the settlement item is necessary when qualifying facts; it does not cancel the OWNER-selected ready-access LMS scenario. The current Fiscal Data Format (FFD)/54-FZ version, specific provider capabilities and tax facts must be checked before actual execution.

## 5. Draft legal document changes

| Document/version | What to prepare for v10 | Boundary to preserve |
|---|---|---|
| Paid LMS terms | Actual merchant-native payment, ready/dynamic access subject, approved seven-day LIMITED_CONTINUATION/payment deadline and genuine termination grounds, price/quote guarantee, support and separate acceptance | Do not return to version-limited course access or copy ₽1/a single test buyer into the public offer |
| LAB terms | Specific edition/occurrence, dates/time zone/location/material composition, price/quote, seven-day LIMITED_CONTINUATION capped by the accepted sales cutoff, fresh availability without seven-day seat reservation, genuine termination/rescheduling/refund, ticket/check-in and guest recovery | A ticket is not a delivered service; guest email is not a verified LMS account; original holds are not renewed by continuation; changes do not overwrite past acceptance |
| Refund terms/requests | Reliable contact/access, registration/decision/execution/confirmations, customer consequences | The closed Test Course full-refund promise is not a universal policy; S4 is not a consumer refund condition |
| Fiscal/receipt contact | Actual supplier/KKT/OFD/bank, amount/subject/taxes and handling of incorrect/undelivered receipts | A native route does not automatically retain the former provider/agent or access to another party's KKT |
| Personal data/privacy/processing instructions | Data map, processing participants, purposes/legal bases, consent evidence, required bank/OFD/email/video/Refref scope and retention | Refref does not require an entire account/profile/email/guest capability |
| Refref merchant/partner terms | Campaign versions and separate relationships, accrual/registers/evidentiary duties, actual debtor | Do not publish internal DR/moderator procedures as a consumer offer or recreate Agent Referrals |

The approved continuation policy requires explicit genuine buyer cancellation, evidenced merchant impossibility with proper termination, or expiry of the continuation period/effective LAB cutoff as terminal grounds. UI reset/back/new-order actions, a CANCELLED report or temporary lack of seats do not establish those grounds. Closing new instructions does not release PENDING/UNKNOWN/REVIEW monetary or reservation fences or discard an authorised operation's genuine late FULL under its original BOUND. Report FULL by the end of the next Russian business day after actual full payment; do not wait until the seven-day deadline. At due time report the appropriate known state, including CANCELLED where applicable; a NOT_PAID+CANCELLED pair is not mandatory, and UNKNOWN must not become false NOT_PAID.

Consumer rights are qualified against the actual subject and promises. The source audit records Rospotrebnadzor's explanation of service cancellation rights with assessment of relevant actual expenses; retention must not be invented algorithmically from the number of lessons viewed. [Official explanation dated 27 January 2026](https://zpp.rospotrebnadzor.ru/news/federal/570781). Specific LMS and LAB qualification must also examine defects, deadlines/rescheduling, performance evidence and applicable special rules. The label “informational course” or “workshop” alone does not replace factual qualification; the OWNER-selected ready-materials model is not reopened without new contradictory facts.

Potential education/advertising requirements are checked in their actual scope: content/programme/provider role, teaching/assessment, channel and subject of referral advertising/information, required labelling/registration and the parties' authority. This project does not declare every LAB offering licensed education, impose a universal advertising data operator (ORD) requirement on every recommendation, or exempt relevant duties based solely on a product name.

## 6. Personal data and authority

Preserve the boundaries of account authentication, guest bearer capability, Admin/finance role, erasure fencing and historical legal hold. Sensitive capability/email/IP must not enter sourceEventRef, product titles or diagnostics. Bank/fiscal contact and marketing consent are distinct from selection of a referrer promo.

The data matrix defines the basis/recipient/term for customers, orders/acceptances, access records, tickets/check-in, payments/refunds/receipts, email recovery, browser contexts, Refref reporting and exceptional evidence uploads. The source audit cites the [official text of 152-FZ](https://mintrud.gov.ru/docs/laws/130), Articles 5/6/9, for purpose limitation, data minimisation and separate consent documentation; applicable legal bases are checked by data class. Consent withdrawal/account deletion are not declared automatic erasure of financial evidence or discharge of debt.

Carry forward retention periods and erasure under the current scheme using a verified map, rather than the incorrect rule “no FINAL means nothing to retain”. Synthetic tests contain no real customer exports, provider secrets or complete bank statements. V1 is physically retired: preserving historical rights does not authorise a public restart/token route or fabrication of V2 orders from old history.

## 7. Admission conditions and sources

| Gate | Required result |
|---|---|
| F-01 Contract/subject by profile | Actual counterparties and authority, versioned LMS/LAB terms, actual subject/access/performance and preserved consumer rights. The initial READY snapshot evidences provision but does not limit the dynamic entitlement: subsequent admissible updates to the purchased course fall within its scope. A separate new course/service or different educational profile is not automatically included in the purchase |
| F-02 Fiscal/provider mapping | The preserved OWNER model and specific native bank/KKT/OFD flow agree; receipts/refunds and readiness are checked in the required scope; qualification is per offer/legal version, not a shared enum |
| F-03 Acceptance/personal data/notices | Exact documents/hashes, separate required actions, identity/capability provenance, data map and proper provision/delivery of versions; prior signatures/acceptances are not fabricated |
| F-04 Additional duties | Licensing/education rules, advertising/labelling/ORD, content rights and selected partner tax relationships are applicable on the facts or reasoned as inapplicable |
| F-05 End-to-end acceptance | Source/contract, actual transport, provider/fiscal read-back and customer access/ticket/refund E2E have separate verdicts; [plan 06](06-migration-and-e2e.md) does not execute them |

Internal authority is an OWNER decision with proper evidence; external consultation is not a new mandatory prerequisite. Missing qualification means HOLD for the affected new sale, rather than authority for a developer to replace the approved fiscal scenario, alter the tariff, execute a real payment or cancel acquired rights.

The source audit records these public primary sources as checked on 27 October 2026: [Federal Tax Service, FFD and published amendments](https://www.nalog.gov.ru/rn77/about_fts/docs/10020801/); [Rospotrebnadzor on cancellation/unused sessions](https://zpp.rospotrebnadzor.ru/news/federal/570781); [Ministry of Labour, 152-FZ](https://mintrud.gov.ru/docs/laws/130). They support general subject boundaries and do not constitute an individual decision for Flexperiment. This document does not claim complete current qualification of taxes/KKT/education/advertising or every contract's contents. Actual provider accounts, live legal release and access rights were not inspected; nothing was published, signed or executed.
