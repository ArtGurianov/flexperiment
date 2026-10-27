# Flexperiment LMS and LAB — Refref v10 architecture

Date: **27 October 2026**. Status: **consolidated architecture draft with recorded OWNER profile decisions**. This directory is the proposed architecture entry point for the transition. The decisions below do not establish implementation, deployment, published buyer terms, provider authority or public financial activation; the remaining qualification gates still apply.

## Reading order

1. [Commerce architecture](01-commerce-architecture.md): source baseline, ownership and the proposed target.
2. [LMS / COURSES](02-lms-profile.md): courses, bundles, dynamic access, identity, ready materials, refunds and unpaid-purchase recovery.
3. [LAB](03-lab-profile.md): active V2 guest checkout, occurrences, seats, tickets, moves and fulfillment.
4. [Refref integration](04-refref-integration.md): BOUND, touch migration, revisions, FULL intake, receipts and recovery.
5. [Fiscal and legal impact](05-fiscal-legal-impact.md): separate contract, money and fiscal facts, retained decisions and profile qualification.
6. [Migration and acceptance](06-migration-and-e2e.md): forward-only transition, rollback and **80 planned acceptance cases, all NOT_RUN**.

## Ownership at a glance

| Area | Flexperiment owns | Refref owns | Independent evidence |
|---|---|---|---|
| Buyer contract and fulfillment | Product, accepted terms, price, account/guest access, course entitlement, seats and tickets | Referral rights under accepted campaign terms | BOUND and commission status do not replace the buyer contract or fulfillment |
| Money and fiscal documents | Native acquiring, refunds, provider read-back, receipts and applicable closing documents | Referral reporting and commission accounting | A redirect, receipt request or Refref ACK does not prove bank execution |
| Referral result and partner payment | Automatic truthful result outbox, evidence when claiming, registry execution and payout reporting | Touch, BOUND, qualification, one commission and its applicable finality/claim rules | Access, ticket use and administrative case closure do not establish FINAL or extinguish debt |

## Pinned sources

| Source | Revision | Evidence boundary |
|---|---|---|
| Flexperiment main | [`c8bad757c9daa04385f9cf5e95bf6e07b185080a`](https://github.com/ArtGurianov/flexperiment/tree/c8bad757c9daa04385f9cf5e95bf6e07b185080a) | Source audit; Commerce V2 has 35 SQL migrations, 0001–0035. Not installed-schema or runtime read-back |
| Refref [PR #130](https://github.com/ArtGurianov/refref/pull/130) | [`c932b656edbda1d47cfb57de08fd4a36536712f5`](https://github.com/ArtGurianov/refref/tree/c932b656edbda1d47cfb57de08fd4a36536712f5/docs/v10) | Accepted core policy and specified FULL intake for unknown/unsuitable revisions; a documented route is not a served endpoint |
| Existing product and contractual authority | Source decisions and archives linked from the profiles and fiscal chapter | Distinguish approved decisions, proposed bytes, publication records and a particular buyer's valid acceptance |

[Source baseline](source-baseline.json) stores pinned Git blob hashes and preparation/review provenance. Sources are referenced rather than copied. Private Refref links require access. After an upstream squash merge, update the pin, links and hashes together following a content check; do not replace only a SHA. A stale local branch is not the migration baseline. Existing Refref owner decisions are not reopened by this package.

## Retained boundaries

- Commerce V2 owns the sale, native payments/refunds and fulfillment. Refref neither grants course access nor reserves LAB seats or executes buyer payments.
- Save BOUND before the **first payment opportunity**, including an invoice, URL or provider session. UNKNOWN cannot be bypassed with `deliveryDegraded` or a different purchase identity.
- After a saved BOUND, local contractual changes and safe execution do not wait for a revision ACK. Truthful FULL is durably accepted using its own snapshot; intake, suitability and positive commission are distinct results.
- One purchase has one original commission C, frozen at its first valid FULL revision. Not using the buyer discount alone does not remove the right. Keep `D_rule` separate from `D_applied`; an unsuitable revision is not S4 zeroing or deletion of BOUND.
- Dynamic LMS grants, LAB tickets/admission, actual service performance, fiscalization and FINAL remain separate. A referral outage does not delay fulfillment of an already paid purchase.
- Buyer refunds do not wait for S4. No mandatory organic-sales or continuous-refund stream is introduced; claims require the complete relevant money snapshot.
- UNKNOWN money outcomes forbid blind overlapping retries. Refund/recharge and backup replay do not automatically create another payment or commission.
- V1 stays retired. Do not restart public legacy services or fabricate V2/v10 orders from archives. Existing V2 RC.2 tails keep their original owner and authorized recovery scope.
- Mikluha deposits are not a mandatory new LMS/LAB product. The current one-full-payment model remains the starting point; a different schedule requires a selected profile.

## Profile decisions and qualification

OWNER approved the first single-full-payment profile: FX-C12 seven-day limited continuation for both storefronts, its payment deadlines, LMS PAYMENT, LAB SCHEDULED_SERVICE, and Refref promo codes only. The approval and its scope are recorded in the existing [source baseline](source-baseline.json); no separate Decision Record is introduced. Other prerequisites below remain for their affected implementation/admission scopes and do not revoke existing guarantees. Fixture amounts remain synthetic; the approved seven-day period is now a profile rule, not a fixture-selected alternative.

| ID | Select or qualify | Do not assume |
|---|---|---|
| FX-C01 | Actual Business/seller/qualified-agent roles, COURSES/LAB mapping and accepted campaign terms | A shared local customer permits cross-origin/person matching or partner reassignment |
| FX-C02 | Native acquiring/refund provider, connection, credentials, evidence/read-back and fiscal responsibility | Old `PAYMENT_MODE=refref`, canary bank/KKT evidence or a V1 contract transfers native authority |
| FX-C03 — OWNER_APPROVED for the initial profile | Single full payment: LMS `fullPaymentDueAt=addMoscowCalendarDates(purchaseCreatedAt,7)`; LAB the minimum of that instant and qualified salesCutoffAt. Qualify the actual payment-opportunity/quote implementation | Quote/session/cookie expiry selects the deadline, or early FULL can wait until day seven to be reported |
| FX-C04 — OWNER_APPROVED | LMS uses PAYMENT; anchor is the first actual full payment | Progress, last login, fiscal tags or future course updates select another mode/anchor |
| FX-C05 — OWNER_APPROVED | LAB uses SCHEDULED_SERVICE; anchor=`max(actualPaidInFullAt, serviceAnchorAtAtBound)`. Qualify the eligible occurrence/programme end with provenance/time zone, fixed at BOUND | A move automatically changes the anchor, or a closing receipt substitutes for the frozen service end |
| FX-C06 | Scope of purchase changes, consent, effective times, line identity, LAB moves and price revisions; separately any desired mixed basket/group/staged-payment feature | Truthful history requires a universal basket, certificate ledger or mandatory group/deposit checkout |
| FX-C07 | Storefront action/holder flow: 72 hours, R14.1, campaign TTL, Apply/qualified ORDER_SUBMIT and BOUND recovery | Old Arrival receipts/cookies or degraded delivery create v10 rights or merge storefront contexts |
| FX-C08 | Snapshot/source-event intake, receipt recovery, later evidence, CAS versus append-only facts, R17.1 and calendar qualification | Unknown/unsuitable-revision intake can be redefined: its semantics are already pinned; this gate proves implementation |
| FX-C09 | Buyer documents, acceptance/delivery, native fiscal mapping, personal data/retention/erasure and the actual advertising profile | Mandatory external counsel replaces the retained OWNER procedure, or changing provider cancels ready-material FULL_PAYMENT/dynamic access |
| FX-C10 | Inventory, cutover and restore for actual V2 attempts, grants, tickets and refunds; safe recovery by their original owner | A source snapshot proves an empty database, completed canary operations or permission to delete them |
| FX-C11 | Separate ONLINE_COURSE, COURSE_BUNDLE and LAB qualification and public admission | One course's acceptance opens bundle/LAB, or financial integration blocks independent free Stage A |
| FX-C12 — OWNER_APPROVED | LIMITED_CONTINUATION: both storefronts retain a genuinely continuing unpaid economic purchase for seven Moscow calendar dates from its first durable creation, without a retry/requote reset. LAB new payments additionally require capacity and precede sales cutoff. Policy version and objective termination grounds are fixed at creation | Seven days reserves a seat, UI reset is a buyer cancellation, or expiry cancels existing authorized bank operations. CANCELLED alone does not terminate a contract; true late FULL remains under the original BOUND |
| FX-C13 — OWNER_APPROVED | Only Refref promo codes in the new profile. No Flexperiment-owned promo codes, local coupon engine, stacking option or merchant-code priority flow | The legacy merchant-prefix routing is a v10 feature, an invalid code removes a valid link/BOUND, or this choice revokes an already accepted legacy price. D_rule/D_applied and OWNER-02 remain unchanged |
| FX-C14 | Payer account and responsibilities for registry preparation/execution, execution/remainder/correction reports and dispute response | Refref pays the partner for Flexperiment or UNKNOWN permits another transfer |

### Approved continuation and payment deadlines

Let `sevenDayEnd=addMoscowCalendarDates(purchaseCreatedAt,7)`: add seven Moscow calendar dates while preserving time of day. Store the first durable economic-purchase creation time and policy version once. Preview, handoff, retry, requote and later BOUND do not restart this clock. This is a separate commercial period, not an extension or reuse of the consumed touch TTL.

For the first single-full-payment profile, LMS `fullPaymentDueAt=sevenDayEnd`; LAB `fullPaymentDueAt=min(sevenDayEnd,salesCutoffAt)`. New payment instructions require `now < fullPaymentDueAt` and the applicable availability/consent/version/money checks. A temporary lack of LAB seats blocks a new instruction but does not by itself finally terminate the economic purchase. Expiry of an unconverted hold keeps its original maximum 15-minute limit; a PENDING/UNKNOWN operation and its necessary monetary/reservation fence are not released by this clock.

Final termination follows predefined grounds: genuine explicit buyer cancellation, evidenced inability to provide the service with proper termination, or the end of the permitted continuation/sales period. Back, reload, closing a tab, clearing UI state and “Start new order” are not such buyer cancellation. A reported CANCELLED may coexist with a still-continuing purchase; resume then retains purchaseRef/BOUND/partner and uses a new agreed price. After genuine final termination, an independent new sale requires a new purchase identity and a new qualifying action/BOUND only for a new referral right.

After the deadline, admit no new payment instructions. Continue callbacks/read-back/reconciliation/outbox for existing authorized operations; an operation lawfully started before expiry may settle later. Qualify true FULL against the effective obligation/revision and preserve its original BOUND/actual time. A transfer that does not fulfill an effective obligation is not FULL/C merely because money arrived. Do not postpone an early FULL report until the deadline: the existing next-Russian-business-day SLA after actual FULL remains. At dueAt report the appropriate known state; UNKNOWN requires honest diagnostics, not fabricated NOT_PAID/CANCELLED or an automatic pair of both reports.

These profile choices do not alter the accepted core commission model, extend an old seat hold, change historical policy/accepted prices or grant new bank/provider authority. Other product, legal, calendar/R17.1, payer and transport qualifications remain open where not independently completed.

## Implementation sequence

Agree the affected profile choices and inventory → qualify native payments/refunds and fiscal mapping → implement persistent purchase identity, fulfillment and outbox → implement touch/Apply/BOUND and real Refref transport → run isolated source/contract, transport and provider acceptance → rehearse cutover/rollback → obtain separate scoped activation authority. The migration chapter retains detailed stages and existing-rights safeguards.

## Validation

`python3 docs/refref-v10/validate-package.py` checks the inventory/hashes, repository links/anchors, pinned Flexperiment blobs, all 35 immutable SQL migrations and the identities of 80 planned cases. Optional `--refref-repo <local-refref-checkout>` verifies external Refref blobs; without it the result explicitly says external bytes were not verified. No sibling checkout or archived agent package is required.

The validator does not run the target implementation, browser, bank or E2E. Implementation source/contract acceptance, served transport and provider/evidence E2E remain **NOT_RUN**. Existing CI is evidence for its exact HEAD and existing code, not execution of these 80 scenarios. Runtime code, SQL and published contracts are unchanged.

**CUSTODY_IMPACT: NO.** Documentation and its local validation tooling only: no credentials, host env/networks, backups or deployed persistent state change. Implementation, legal publication, database migrations, deployment and public financial activation retain their separate authority gates.
