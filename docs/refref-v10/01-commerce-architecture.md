# LAB and LMS — Commerce architecture for Refref v10

Revision: 27.10.2026. **Architecture incorporating OWNER-approved profile decisions; implementation is not qualified or live.** Approval of these documentation choices does not authorize financial activation. Inspected Flexperiment source: `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; Refref: `c932b656edbda1d47cfb57de08fd4a36536712f5`. Provenance, approved choices and remaining qualification gates are in the [README](README.md).

## 1. One Commerce system, two profiles

Flexperiment retains its catalogue, prices, contracts, buyers, LMS access, LAB tickets/seats and service fulfilment. Under the new profile, it also receives buyer funds and executes refunds through its own qualified adapter. Refref maintains attribution, BOUND, commission and the applicable cases/registers. Its v10 API is a target specification; a working endpoint has not been demonstrated.

The target accepts only Refref promo codes. No Flexperiment promo-code engine or merchant-code/Refref-code stacking options are planned. Referral links, valid AutoApply and OWNER-02 remain applicable; observed legacy code behaviour and prices already accepted under old contracts remain historical facts rather than new target features.

| Area | LMS / COURSES | LAB | Shared boundary |
|---|---|---|---|
| Product and fulfilment | ONLINE_COURSE / COURSE_BUNDLE; published materials, dynamic access, entitlement, playback | LAB occurrence, ticket/admission, capacity, workshop delivery | Product kind and storefront do not create new commission types |
| Identity | Better Auth/verified customer session; access recovery | Guest capability/email/recovery and operational admission | Neither an account ID nor a bearer ticket is a referral touch |
| Money | Buyer debt/receipts are separate from grants/access | Receipts are separate from a hold or ticket issuance/use | Flexperiment owns the native payment/refund adapter; Refref does not create bank operations |
| Referral result | BOUND before the first payment opportunity; FULL for a genuine purchase | The same; the service anchor is explicit in scheduled mode | One economic purchase, one BOUND and one original C |
| Fiscalization | Preserve the qualified model for ready-made materials and its evidence | Prepayment/service delivery/prepayment offset under the selected profile | FINAL or a generic PAID button cannot determine the fiscal method |

Mikluha prepayments do not become a mandatory new LAB/LMS feature. The current source sells the full price as one payment obligation. If Flexperiment introduces its own deposits, credit or staged payments, the commercial terms and provider scope require separate qualification; Refref already permits merchant-managed instalments without an instalment ledger in Core. This draft does not make instalments a launch requirement.

## 2. Facts from the source baseline

The inspection used the then-current `origin/main`, rather than another project's local branch or unmerged checkout fixes. The sources are pinned in [source-baseline.json](source-baseline.json); the installed database, host, customer data and bank accounts/interfaces were outside this inspection.

| Observation | Verifiable source | Implication for v10 |
|---|---|---|
| Commerce V2 uses SQLite/WAL, BEGIN IMMEDIATE and lineage `flexperiment-v2` | [db.ts](../../commerce-v2/src/db.ts), [storage contract](../v2-merchant-schema.md) | Commerce does not need to move into Refref PostgreSQL; concurrency and the outbox remain local |
| 35 immutable SQL migrations, 0001–0035, with an exact lock and prefix journal | [migration integrity](../../commerce-v2/src/migration-integrity.ts), [migration.lock](../../commerce-v2/migrations/migration.lock) | Append forward SQL after the actual migration suffix; never rewrite existing bytes/signatures |
| Modes are `disabled`, `mock`, `refref`; there is no native merchant rail yet | [payment-mode.ts](../../commerce-v2/src/payment-mode.ts), [rail](../../commerce-v2/src/refref-payment-rail.ts) | The existing `refref` mode means RC.2 acquiring, not future v10 reporting only |
| resolve → attempt → payment-session, read-back and refund run through Refref | [checkout.ts](../../commerce-v2/src/checkout.ts), [protocol](../refref-checkout-protocol.md) | Separate Flexperiment provider execution from referral reporting; preserve servicing for old V2 attempts |
| The order and accepted legal/fiscal price are frozen; quote/intent persist before external operations | [checkout](../../commerce-v2/src/checkout.ts), [0030](../../commerce-v2/migrations/0030_checkout_intents.sql), [0011](../../commerce-v2/migrations/0011_canonical_order_snapshots.sql) | Never turn a historical snapshot into a mutable v10 DTO |
| Arrival is stored in SQLite; preview actually calls deliveryForBuy with a 1500 ms budget | [browser-context](../../commerce-v2/src/browser-context.ts), [app.ts](../../commerce-v2/src/app.ts), [0034](../../commerce-v2/migrations/0034_browser_contexts.sql) | Cookie/legacy receipt lifetime is not the v10 TTL; deliveryDegraded does not permit bypassing an unknown BOUND outcome |
| The PAID projection issues COURSE/ALL_COURSES access or LAB acceptance; the Refref ACK is a separate step | [checkout](../../commerce-v2/src/checkout.ts), [entitlements](../../commerce-v2/src/entitlements.ts), [lab-tickets](../../commerce-v2/src/lab-tickets.ts) | Access and tickets must not wait for C/FINAL or referral-outbox delivery |
| The host-owned COURSES/LAB storefront switch and offer restrictions exist separately | [storefront-switch.ts](../../commerce-v2/src/storefront-switch.ts), [0035](../../commerce-v2/migrations/0035_storefront_switch.sql) | The native rail must preserve a fresh payment-admission check; changing the recipient of funds does not lift an operator stop |
| LAB V1 was physically stopped; the V2 frontend is `apps/lab-v2` | [AGENTS](../../AGENTS.md), [V2 frontends](../../deploy/v2/frontends/README.md) | Do not restart V1/public token routes or import the archive as new V2 purchases |

The v9 documents describe a historical target: commission after discounts, old refund conditions and +30-day service moves do not transfer to new v10 rights. Historical acquired rights retain their own policy. Green CI, a closed canary or an existing schema does not establish public admission for the new profile.

## 3. Options considered

| Option | Assessment | Reason |
|---|---|---|
| Keep RefrefPaymentRail as the executor and rename it v10 | Rejected | Violates the merchant-native boundary and conflates provider outcomes with delivery of messages to Refref |
| Separate Commerce systems for LMS and LAB | Unnecessary | Catalogue, identity, operations and evidence are already shared; access, seats and fulfilment differ by profile |
| Retain Commerce V2 and add separate native execution and referral adapters | Proposed | Changes payment responsibility with limited disruption while preserving existing grants, guest tickets, stop, recovery and documents |
| Restart V1 for temporary compatibility | Prohibited by current rules | V1 is retired; historical-case recovery has a separate archival path and requires explicit authority |

## 4. Minimum logical records

| Record | Contents | Required guarantee |
|---|---|---|
| Economic purchase | `purchaseRef`, first durable `purchaseCreatedAt`, frozen continuation-policy version/deadline, storefront, product profile, payment owner/flow, legacy order link | The stable ID contains no email/user ID; retries do not select the profile again or reset creation time/deadlines |
| Accepted revision | Contractual items/price/schedule, lineRef, documents/hash, consent and effective times | Corrections append a version; the previously accepted snapshot is never overwritten |
| Native operation / cash fact | Provider connection/operation ID, key, purpose, amount/currency, stage/outcome, source evidence/time | UNKNOWN is not FAILED; callback/read-back/restart must not count the same amount twice |
| Money allocation | Allocation to purchase/lines/refund; separate unknown scope | Never allocate more than the actual amount; a merchant flag cannot make ineligible lines eligible |
| Fulfilment | LMS grant/material readiness; LAB hold/acceptance/ticket/use; fiscal obligations | Payment fulfilment, access, service delivery and the fiscal result are distinct facts |
| Refref delivery | Touch/BOUND result, source events/outbox, immutable receipt, processing result | BOUND precedes the first payment opportunity; a late ACK does not change the FULL snapshot/hash/time |

This is a logical map for future DDL, not a requirement for one new table per row. Flexperiment does not need a universal buyer balance, a new internal partner portal, escrow, a universal ticket/instalment engine or a second Refref financial ledger.

Do not hold a SQLite write transaction during HTTP. Commit the local money/fulfilment outcome atomically with its outgoing record; lease/dispatch fencing protects the real operation. There is no distributed ACID transaction across Commerce, the provider and Refref: recovery uses the existing IDs/sources rather than a new idempotency key.

## 5. Basic new flow

```mermaid
sequenceDiagram
  participant U as LMS/LAB buyer
  participant C as Commerce V2
  participant R as Refref v10
  participant P as Native provider
  U->>C: Accepted terms + permitted action
  C->>R: BOUND before invoice/payment link/session
  R-->>C: Durable result / command read-back
  C->>P: One permitted buyer operation
  P-->>C: Confirmed outcome
  C->>C: Cash fact + profile grant/ticket + outbox
  C->>R: Genuine FULL with its own revision/snapshot
  R-->>C: sourceReceipt; separate qualification of C
```

The diagram describes the referral path. Free access and ordinary sales without BOUND do not require a new referral right or organic-reporting flow. An ordinary sale must not conceal an UNKNOWN initial BOUND command, and retroactive attribution must not be promised. After BOUND has been saved, a Refref outage does not block safe fulfilment or local contractual changes.

A genuine FULL is the first actual full fulfilment of the payment obligation under the effective contractual revision. A redirect, accepted bank request, issued fiscal receipt, grant or class attendance does not establish FULL. The report supplies MERCHANT_ATTESTED facts; it does not become independent bank evidence. Undelivered FULL reporting must not stop delivery of already-paid access/tickets.

## 6. Revisions and two independent facts

The local contract changes according to consent/authority, seats and actual money history. Refref qualification and delivery are a separate process under the [integration contract](04-refref-integration.md). Refusal/UNKNOWN for a revision does not roll back the contract, erase a deposit/payment/BOUND or create S4-zero. Under the accepted R6.2 rule, no positive C may be promised for an ineligible effective FULL revision; a technical error does not establish economic ineligibility.

The first genuine FULL fixes C once. Later course changes, an added LAB participant, an occurrence move or an additional payment do not increase C or move the original S5 anchor. An agreed continuation retains purchaseRef/BOUND even through refund/recharge; a genuinely independent new purchase requires a new action/BOUND. A rewritten technical order must not be presented as a new sale to obtain a different commission.

OWNER approved **PAYMENT for LMS (FX-C04)** and **SCHEDULED_SERVICE for scheduled LAB (FX-C05)**. These choices and the precise original scheduled end must be reflected in the campaign/profile terms before BOUND. LAB uses `max(actualPaidInFullAt, serviceAnchorAtAtBound)`, with the service end frozen at BOUND; a later move does not automatically change it. The ONLINE_COURSE/LAB enum or fiscal method does not select the mode. Immediate LMS access has no indefinite anchor based on the latest login/content update. Profile details are in [LMS](02-lms-profile.md) and [LAB](03-lab-profile.md).

OWNER approved **FX-C12 LIMITED_CONTINUATION for both LMS and LAB**. Its seven-day end is the first durable `purchaseCreatedAt` advanced by seven Moscow calendar dates, preserving the local time of day. Fix the policy version at purchase creation; retry, requote, resume and a new UI mount cannot reset that timestamp or period. The initial single-full-payment profile sets `fullPaymentDueAt` to this end for LMS and to `min(sevenDayEnd, salesCutoffAt)` for LAB. New LAB payment instructions must be created strictly before that minimum and require current availability. The seven-day period does not reserve a seat or extend an existing hold of at most 15 minutes; PENDING/UNKNOWN money and seat fences remain in force.

Final termination follows an actual explicit buyer cancellation, evidenced merchant inability with termination, or the effective end of the continuation period. A UI reset/back action/new-order action, a CANCELLED report or temporary lack of seats does not establish those grounds. At the applicable due time, record and report the truthful state and an appropriate CANCELLED where applicable; UNKNOWN requires diagnostics rather than false NOT_PAID, and no NOT_PAID+CANCELLED pair is mandatory. Previously authorized operations can still settle after the deadline: preserve their read-back/history and report a genuine FULL under the original BOUND. The FULL reporting deadline remains the next Russian business day after actual FULL, independent of day seven. Apply the approved policy prospectively under the version fixed at creation; do not rewrite existing rights retroactively. Detailed lifecycle and reporting rules are in the [integration contract](04-refref-integration.md).

## 7. Draft and implementation boundaries

The approved profile choices must be reflected in the applicable buyer/campaign terms before admission; this package does not publish those terms or rewrite existing acceptances. Scoped owner decisions on ready-made materials/dynamic access, roles, sale-mode, host state and accepted core referral policy remain in force. Unconfirmed provider/fiscal-receipt capabilities remain admission requirements. It introduces no mandatory external counsel approval in place of the accepted OWNER procedure; actual legal/tax authority still requires verification.

Transition proceeds on a separate isolated local test environment with synthetic adapters, followed by separate source/contract, served-transport, provider/evidence and sector-specific admission checks. Positive CI must not conceal an incomplete contract or unknown outcome. The [migration plan and scenarios](06-migration-and-e2e.md) preserve old V2 financial operations and the V1 retirement boundary without restoring the public legacy runtime.
