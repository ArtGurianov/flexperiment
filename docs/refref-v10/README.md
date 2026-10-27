# Flexperiment LMS and LAB — Refref v10 architecture

Date: **27 October 2026**. Status: **consolidated documentation draft for OWNER review**. This directory is the proposed architecture entry point for the transition. It does not approve pending profile parameters or establish implementation, deployment, published buyer terms, provider authority or public financial activation.

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

The following are prerequisites for the affected implementation/admission scopes. They do not revoke existing guarantees. Fixture amounts and periods are synthetic, not new commercial defaults.

| ID | Select or qualify | Do not assume |
|---|---|---|
| FX-C01 | Actual Business/seller/qualified-agent roles, COURSES/LAB mapping and accepted campaign terms | A shared local customer permits cross-origin/person matching or partner reassignment |
| FX-C02 | Native acquiring/refund provider, connection, credentials, evidence/read-back and fiscal responsibility | Old `PAYMENT_MODE=refref`, canary bank/KKT evidence or a V1 contract transfers native authority |
| FX-C03 | Agreed `fullPaymentDueAt` and the profile's payment opportunity/quote policy | A 15-minute quote or cookie lifetime is the agreed payment deadline |
| FX-C04 | LMS finality mode and an exact original scheduled anchor if that profile applies | Progress, last login or future course updates can create an indefinite anchor; fiscal ready-access alone chooses the mode |
| FX-C05 | LAB finality mode and the eligible occurrence/programme end with provenance/time zone, fixed at BOUND | A PAYMENT window necessarily lasts until the event; a move automatically changes the anchor |
| FX-C06 | Scope of purchase changes, consent, effective times, line identity, LAB moves and price revisions; separately any desired mixed basket/group/staged-payment feature | Truthful history requires a universal basket, certificate ledger or mandatory group/deposit checkout |
| FX-C07 | Storefront action/holder flow: 72 hours, R14.1, campaign TTL, Apply/qualified ORDER_SUBMIT and BOUND recovery | Old Arrival receipts/cookies or degraded delivery create v10 rights or merge storefront contexts |
| FX-C08 | Snapshot/source-event intake, receipt recovery, later evidence, CAS versus append-only facts, R17.1 and calendar qualification | Unknown/unsuitable-revision intake can be redefined: its semantics are already pinned; this gate proves implementation |
| FX-C09 | Buyer documents, acceptance/delivery, native fiscal mapping, personal data/retention/erasure and the actual advertising profile | Mandatory external counsel replaces the retained OWNER procedure, or changing provider cancels ready-material FULL_PAYMENT/dynamic access |
| FX-C10 | Inventory, cutover and restore for actual V2 attempts, grants, tickets and refunds; safe recovery by their original owner | A source snapshot proves an empty database, completed canary operations or permission to delete them |
| FX-C11 | Separate ONLINE_COURSE, COURSE_BUNDLE and LAB qualification and public admission | One course's acceptance opens bundle/LAB, or financial integration blocks independent free Stage A |
| FX-C12 — OWNER_PENDING | Versioned continuation/final-termination policy for unpaid LMS/LAB purchases, including prior CANCELLED: period, objective grounds, recovery/requote and fixation before application to the purchase | Quote TTL, technical cancellation or UI reset proves an independent new contract; dueAt/touch expiry selects a period; the merchant may choose the partner's fate case by case. Late true FULL retains the old BOUND; prospective reopening is separate |
| FX-C13 | Merchant-promotion/Refref-discount stacking, including a merchant code with an existing link touch | Distinguishing D_rule/D_applied selects stacking; a merchant discount changes the holder rather than first forming G |
| FX-C14 | Payer account and responsibilities for registry preparation/execution, execution/remainder/correction reports and dispute response | Refref pays the partner for Flexperiment or UNKNOWN permits another transfer |

The candidate recommendation is **PAYMENT for ready-access LMS** and **SCHEDULED_SERVICE for scheduled LAB**. FX-C04/05 remain OWNER/campaign choices, not adopted defaults. The scheduled anchor is `max(actualPaidInFullAt, serviceAnchorAtAtBound)`. FX-C12 selects neither a period nor a continuation/termination variant here and changes none of the accepted core commission rules.

## Implementation sequence

Agree the affected profile choices and inventory → qualify native payments/refunds and fiscal mapping → implement persistent purchase identity, fulfillment and outbox → implement touch/Apply/BOUND and real Refref transport → run isolated source/contract, transport and provider acceptance → rehearse cutover/rollback → obtain separate scoped activation authority. The migration chapter retains detailed stages and existing-rights safeguards.

## Validation

`python3 docs/refref-v10/validate-package.py` checks the inventory/hashes, repository links/anchors, pinned Flexperiment blobs, all 35 immutable SQL migrations and the identities of 80 planned cases. Optional `--refref-repo <local-refref-checkout>` verifies external Refref blobs; without it the result explicitly says external bytes were not verified. No sibling checkout or archived agent package is required.

The validator does not run the target implementation, browser, bank or E2E. Implementation source/contract acceptance, served transport and provider/evidence E2E remain **NOT_RUN**. Existing CI is evidence for its exact HEAD and existing code, not execution of these 80 scenarios. Runtime code, SQL and published contracts are unchanged.

**CUSTODY_IMPACT: NO.** Documentation and its local validation tooling only: no credentials, host env/networks, backups or deployed persistent state change. Implementation, legal publication, database migrations, deployment and public financial activation retain their separate authority gates.
