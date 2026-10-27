# Shared LMS/LAB → Refref v10 integration

Revision: 27.10.2026. **Draft contract for OWNER review; not approved or live.** Inspected Flexperiment source: `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; normative upstream: Refref `c932b656edbda1d47cfb57de08fd4a36536712f5` from [PR #130](https://github.com/ArtGurianov/refref/pull/130). The Refref branch/PR does not establish installed transport. Provenance is recorded in [source-baseline.json](source-baseline.json).

Profiles: [LMS](02-lms-profile.md), [LAB](03-lab-profile.md). Shared architecture: [01](01-commerce-architecture.md); migration/acceptance: [06](06-migration-and-e2e.md). The new Flexperiment record names below are implementation proposals, not existing public routes.

## 1. Payment ownership and the referral adapter

| Source observed at the baseline | Current behaviour | New v10 profile |
|---|---|---|
| [payment-mode.ts](../../commerce-v2/src/payment-mode.ts) | `disabled/mock/refref`; production prohibits mock; Refref mode requires scoped configuration and protected delivery | Add a separately qualified merchant-native payment profile and a separate Refref reporting adapter. Renaming the old enum/key does not establish readiness |
| [refref-payment-rail.ts](../../commerce-v2/src/refref-payment-rail.ts) | RC.2 resolution → checkout-attempt → `obligations/full/payment-session`; uses the attempt as payment truth and executes full-only refunds through Refref | For new v10 purchases, Flexperiment owns funds/sessions/refunds; Refref maintains BOUND, results, C and cases. Existing attempts remain with their original owner |
| [checkout-snapshot.ts](../../commerce-v2/src/checkout-snapshot.ts) | `refref.shared-checkout-snapshot/2`, one `full` ORCHESTRATED obligation, fiscal items included | Do not forward the old payment snapshot as a new merchant-result. Preserve it for old orders; the new result has its own versioned contract |
| [checkout.ts](../../commerce-v2/src/checkout.ts), `applyProjection` | Checks amounts/hash; on PAID, transactionally issues an LMS entitlement or LAB ticket | Native provider truth triggers the appropriate Flexperiment action; a missing Refref ACK must not cause a duplicate payment/access grant. The original FULL and the access/ticket fact are separate records |
| [refunds.ts](../../commerce-v2/src/refunds.ts) | Consumer refund decision is separate from execution; sealed envelope, read-back, `REFUND_FULL_ONLY`, entitlement revocation after a confirmed refund | Transfer these guarantees to the selected merchant provider; the current full-only path does not qualify partial refunds or grant Refref new authority over funds |

This draft does not select a bank, cash-register provider, authority/credentials or their provisioning method. The closed test route Flexperiment → Refref → Tochka does not establish Flexperiment's merchant-native authority. Restoring Agent Referrals V1, adding a buyer wallet or copying Refref's financial ledger is unnecessary.

## 2. Transition of Arrival and codes

Unlike Mikluha, [browser-context.ts](../../commerce-v2/src/browser-context.ts) and [migration 0034](../../commerce-v2/migrations/0034_browser_contexts.sql) persist context/Arrival in **SQLite**. For a new checkout-preview, [app.ts](../../commerce-v2/src/app.ts) actually calls `deliveryForBuy`; the result with `browserContextId`/`deliveryDegraded` is frozen in the intent. An intent retry uses the original context. This is existing ADR-139 preparation, not v10 BOUND.

- Host-scoped cookies are separate: `__Host-flx-ctx-lms` and `__Host-flx-ctx-lab`; their default lifetime is 30 days, with a configurable range of 1–400 days. A cookie/context locates context; it does **not** confer a referral-attribution window of that length.
- Raw proof is temporarily stored in SQLite for up to 30 minutes and cleared after expiry; Buy spends up to 1500 ms and may continue the existing resolution with `deliveryDegraded`. This fallback must not be transferred to an unknown v10 `binding.create` outcome.
- LMS logout/account switch rotates the context; pending proof does not transfer to the new account. A LAB guest capability/contact does not become Refref buyer identity. Preserve origin/context scope and protection against cross-storefront use.
- An old Arrival receipt/cookie does not automatically create a v10 touch, protection start time, BOUND or new referral right. Existing acquired rights need a qualified transition map; without one, the old profile concludes under its old rules and a new right arises from a permitted v10 action.

In v10 there is one active holder and no queue. Refref returns `touchRef`, versions, `protectedUntil` and `attributionExpiresAt`: 72-hour protection and the campaign TTL for a new BOUND (default 7, maximum 30 calendar days) are distinct from cookie lifetime. Refresh/retry does not extend them. During the 72 hours, a conflicting link/promo cannot replace the holder; after that, replacing a still-valid holder requires R14.1: display the current pair of offers and obtain a scoped confirmation with its version. Touch expiry does not terminate an already-BOUND purchase right.

Permitted actions are `REFERRAL_NAVIGATION` and `PROMO_APPLY`. The latter requires `actionVariant=APPLY_BUTTON` or a qualified `ORDER_SUBMIT`: a visible code, a clear meaning that submitting the order applies it, deliberate submission, and server validation of intent/code/scope. SDK prefill/edit/background-save does not create a touch or apply a discount. A confirmed link and a retained valid AutoApply do not require another Apply; the promised price must be honoured. Merchant promotions and referrer promos are distinct: an old `checkoutCode`/prefix is not evidence of a Refref holder.

## 3. Initial BOUND and commands

The [canonical BOUND contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/02-attribution-bound.md) and [API map](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/06-api-and-states.md) apply.

1. Create a stable economic `purchaseRef`/contractual revision; check the existing legal, account/guest, price/seat and storefront admission requirements. A preliminary terms preview neither consumes a touch nor creates BOUND.
2. For the referral path, keep **every first payment opportunity** closed, including an invoice, payment URL, provider session and creation of a bank operation. Obtain durable BOUND before opening any of them, not merely before the bank callback.
3. If the ACK is lost, retain the command/key/body and read `GET /v10/bindings/by-command/{commandId}`, including any previous refusal. Do not label UNKNOWN as refusal or bypass it with a new purchaseRef/ordinary checkout. Once the absence of BOUND is established, a transparent ordinary checkout may proceed without retroactive attribution and must honour the promised price.
4. Create merchant-native payment after BOUND. Without BOUND there is no referral C; an applied discount does not replace this condition. BOUND is not a universal operating requirement for new ordinary/free Flexperiment paths.

| Refref command/resource | Flexperiment use | Constraint |
|---|---|---|
| `POST /v10/touches`, switch-confirmations | Verified action on its storefront, holder/offer version | The browser does not assign the partner/eligible set |
| `POST /v10/bindings`, read-by-command | Business/purchase/revision/cart, offer proof, **fullPaymentDueAt**, finality mode/frozen anchor | One consumed touch; at most one BOUND/partner/original C per purchase |
| `POST /v10/purchases/{purchaseRef}/revisions` | Report a locally accepted contractual revision before the first FULL | CAS on the Refref projection; not permission to conclude/change the Flexperiment contract |
| `POST /v10/purchases/{purchaseRef}/results` | Append-only `PAID_IN_FULL`/`NOT_PAID`/applicable `CANCELLED` | **No expectedVersion**; technical refusal does not establish economic ineligibility |
| `GET /v10/commands/{commandId}` | Receipt and current processing of the original command | Does not create a duplicate payment or a new window |
| `POST /v10/evidence` | Late specific context/material for a sourceReceipt and subject | Access/association are checked; a file/hash is not an independent bank fact |

`fullPaymentDueAt` is mandatory even for a single 100% payment: the selected checkout profile sets the deadline, not an arbitrary current time or cookie lifetime. A new LAB profile with partial instalments requires a separate commercial decision; mandatory Mikluha prepayment does **not** become LAB or LMS policy. PAYMENT/SCHEDULED_SERVICE and the specific service anchor must be selected and published in the terms before BOUND; product type or a fiscal tag supplies no arbitrary default.

## 4. Contractual revisions and payment chronology

After BOUND has been saved, Flexperiment accepts changes independently according to consent, service/seat availability and money constraints. Commit the new immutable revision/effective time/acceptance, allocations and outbox in one local transaction. Refref qualifies referral eligibility separately; refusal/UNKNOWN for that command **does not** roll back the contract/deposit, block a safe additional payment or remove BOUND/the partner. This is the existing R6.2/CW-022 rule: an ordinary sale of an ineligible revision may proceed without falsely promising a reward.

Do not conflate the two UNKNOWN states: an unknown initial BOUND blocks the first referral payment initiation; unknown processing of a later revision does not impose that general prohibition. A real BANK_UNKNOWN operation outcome always prohibits an overlapping new payment or unjustified seat release. An external payment must not hold a SQL lock during network calls; dispatch/read-back use stable operation IDs, a fingerprint and connection/owner scope.

The first genuine FULL belongs to the contractual revision effective **when actual full payment fulfilment occurred**, rather than the latest UI/ACK record. If an old payment completed FULL at T1, a revision became effective at T2 and the callback arrived at T3, where T1 < T2 < T3, retain FULL under the T1 revision. A late ACK for an old revision does not roll back the newly accepted version. Reducing the price to the amount already paid may produce the first FULL when the new revision becomes effective; do not backdate it to the first instalment.

After the first genuine FULL, added products, a LAB participant, a new course edition or an additional payment do not increase/recalculate C; preserve the original purchase/BOUND/partner and S5 anchor. A technical ID or full refund/recharge does not turn an agreed continuation into a new purchase. A genuinely independent purchase needs a new action and BOUND before its first payment. Flexperiment manages access/tickets and actual service delivery separately from FINAL.

Short quote expiry and a CANCELLED report neither remove BOUND nor establish a new contract by themselves. **FX-C12 remains pending.** Prospective resume/requote is subject to the policy to be approved for the affected profile before admission, then frozen/versioned before application to each purchase; see the [LMS lifecycle](02-lms-profile.md). Record local contractual continuity/genuine final termination separately from the reported outcome. Intake and history of a genuine late FULL for the original obligation remain required under the original BOUND, without a new touch, even while FX-C12 is pending. Accepting that fact does not authorize reopening payment for a genuinely terminated purchase. Do not bypass UNKNOWN through a new purchaseRef or change the partner by relabelling the sale.

## 5. Money and mandatory FULL reporting

| Value | Rule |
|---|---|
| `G` | Sum of eligible line totals after Flexperiment's own discounts and before the Refref discount; excludes ineligible services/delivery |
| `D_rule` | Refref discount calculated under frozen terms, with percentage floor rounding; calculated by the Refref server |
| `D_applied` | Discount actually granted, including actual rounding; honour the resulting buyer price |
| `C` | Purchase-level FIXED or PERCENT of G with half-up rounding, gross RUB; one original C |
| Initial guard | Direct `G−D_rule−C>0` on the actual FULL revision; `G≥P_min` is not equivalent |

OWNER-02: not using the discount does not deprive the partner of C when the attribution/eligibility guards hold. `D_applied=0` neither makes D_rule zero nor qualifies ineligible economics. A discount without a permitted touch/BOUND before the first payment opportunity does not produce C. Differences in actual price rounding do not recalculate C; the money snapshot/S4 uses actual receipts and D_applied.

Report only BOUND purchases: FULL means a payment obligation that was actually fulfilled in full, not a redirect, fiscal receipt, entitlement/ticket, credit approval or incomplete internal offset. NOT_PAID may have `prepaymentReceived=true`; a genuinely unknown outcome needs diagnosis rather than a false assertion that no money was received. CANCELLED applies before a genuine FULL; after FULL, a customer refund must not be disguised as CANCELLED. Refref does not require organic purchases or a continuous stream of every instalment/refund.

Save the source fact and outbox in the local transaction recording the genuine result. Input must strictly follow [merchant-result.schema.json](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/merchant-result.schema.json):

- `schemaVersion=refref-v10.merchant-result/1`, commandId/idempotencyKey, Business/binding/purchase/revisionRef/hash, sourceEventRef/sourceVersion;
- `revisionHash`: 64 lowercase hex characters, without the current `refref-jcs-1:` prefix; sourceVersion/money are safe integers;
- result/stateAsOf/knownAt/timePrecision/sourceProvenance; the normal sender is MERCHANT_ATTESTED;
- FULL: `actualPaidInFullAt`, a complete self-contained purchaseSnapshot of the effective revision, stable lines/quantity, prices/criteria and actual applied discounts. `buyerDiscountApplied` is a boolean price fact, not proof of Apply; false requires zero applied amounts, while true permits a rounded zero;
- The sender does not assign receipt/actor/qualifiedAt/commissionAmount. Buyer email addresses, account IDs, guest capabilities, names and full bank statements must not enter ordinary payloads/notes.

The FULL deadline is the end of the next Russian business day **after actual full payment**, not an arbitrarily delayed knownAt. Keep fulfilment time, knowledge time and source/received/qualified times separate. Obtain a reliable state/applicable result by fullPaymentDueAt; clarifying reporting does not terminate the BOUND right. Delivery order must not lose genuine late FULL facts or earlier timely claims; the exact R17.1/mixed-fault function remains a profile admission gate.

## 6. FULL before revision registration: defined transport contract

[Canonical reporting §3.1](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/03-merchant-reporting.md) defines durable intake of a valid FULL for a revision that is still unknown or economically ineligible. This is a defined contract rather than an open money-policy decision:

1. `POST .../results` saves the fact/snapshot and returns HTTP 202 with an immutable `sourceReceipt`. A prior successful revision CAS is not a prerequisite.
2. Qualify a sufficient self-contained FULL snapshot under the frozen terms. If ineligible, retain the fact without positive C and preserve BOUND; this is not S4 zeroing of an existing C. If specific effectiveness/chronology context is missing, keep the fact pending with a reason.
3. Read `processingStatus=ACCEPTED_FOR_PROCESSING` or `APPLIED` through `GET /v10/commands/{commandId}`. APPLIED means assessment has completed; it does **not** guarantee C or independent bank verification. A pending result after receipt does not mean an unpaid order.
4. Submit late context through the existing `POST /v10/evidence`, with matching Business/BOUND/purchase/sourceEvent/revision/hash and a receipt reference; associate evidenceRef with the same fact. Do not rewrite the snapshot, original receivedAt or actualPaidInFullAt, or require a late CAS before preserving FULL.
5. `requestFingerprint` includes transport identity; `sourceFactFingerprint` excludes commandId/idempotencyKey. The same source identity/content under a different command links to the original fact, without a second C or a new fact time. A changed body under the old key yields IDEMPOTENCY_CONFLICT; incompatible content for the existing source ID yields SOURCE_EVENT_CONFLICT, without overwrite. Genuine auth/schema/scope errors remain errors; an unknown hash alone does not become VERSION_CONFLICT/PROFILE_NOT_QUALIFIED.

Replay/history recovery must work after restart/backup without substituting the latest current price for the historical one. Qualification uncertainty must not be presented to the partner as a confirmed refusal or promised reward. Actual transport/source conformance with these rules is a required admission check; reading the document does not establish it.

## 7. Buyer refunds, commission and partner payouts

Flexperiment executes customer refunds under its own obligations. S4 neither authorizes/prohibits a customer refund nor controls access/tickets. To seek full zeroing of C, Flexperiment submits S4 with the complete relevant money/cancellation evidence snapshot, rather than a continuous refund stream. The only outcomes are the original C or 0; B2 separately corrects a false initial FULL. A separate technical number/certificate does not establish full termination; preserve all relevant additional payments/refunds for an agreed continuation. A bank refund without allocation does not establish eligible scope.

All grounds, deadlines and finality follow the [Refref money contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/04-money-finality-claims.md). After final zeroing, a new payment/FULL does not automatically restore C. A permitted RESTORE_FULL uses the same original C and a corrective register, accounting for amounts already paid and UNKNOWN scope; message count does not create new bank transfers.

Flexperiment pays the partner itself under the monthly register, reports execution/unpaid or uncertain remainder/corrections, and responds to a proper request during a dispute. Link the register number to the payment purpose. Apply the FINAL month, original deadline, permitted obstacles/O6 and restored amounts/O7 strictly under the [canonical payout contract](https://github.com/ArtGurianov/refref/blob/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10/contracts/05-payouts-s3-conformance.md). A merchant report, partner statement and bank fact are distinct; a missing report or S3 closure neither extinguishes the debt nor permits retrying an UNKNOWN transfer. Flexperiment does not build its own copy of Refref's moderator/banking machinery.

## 8. Implementation admission

Before referral sales, qualify the running v10 API/auth/scope, BOUND-before-opportunity, replay and refusal/UNKNOWN handling, native acquiring/fiscal/refund ownership and read-back, automated source/outbox sending, actual FULL/revision chronology, calendar/R17.1, buyer/legal/personal-data admission, and the precise profile finality mode/anchor/due date. Preserve ordinary/free access and servicing of existing rights within their permitted scope. SOURCE/contract, served transport and provider/evidence E2E receive separate verdicts. Refref public GO requires LMS, LAB and Mikluha; neither this draft nor a mock/reference PASS replaces them.
