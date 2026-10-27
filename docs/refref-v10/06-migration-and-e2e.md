# LAB/LMS migration to v10 and acceptance programme

Date: 27 October 2026. Status: draft migration strategy and acceptance plan for OWNER review, **all new E2E NOT_RUN**. Flexperiment source main: `c8bad757c9daa04385f9cf5e95bf6e07b185080a`; normative Refref baseline: `c932b656edbda1d47cfb57de08fd4a36536712f5`. This plans subsequent implementation; it is neither a completed migration nor authority to move money.

## 1. History to preserve

| Area | Observed source | Strategy |
|---|---|---|
| V2 storage/migration | [db.ts](../../commerce-v2/src/db.ts), [migration-integrity](../../commerce-v2/src/migration-integrity.ts), [lock](../../commerce-v2/migrations/migration.lock) | SQLite/WAL; a new forward suffix after 35 SQL migrations. Existing SQL, order and record hashes remain unchanged; do not reset the journal |
| Legal/fiscal/order snapshots | [0011](../../commerce-v2/migrations/0011_canonical_order_snapshots.sql), [0017](../../commerce-v2/migrations/0017_fiscal_policy.sql), [0027](../../commerce-v2/migrations/0027_owner_legal_decisions.sql) | Preserve actual accepted bytes/hashes, qualification and OwnerLegalDecision; a new revision does not overwrite prior acceptance |
| V2 RC.2 payment/refund | [rail](../../commerce-v2/src/refref-payment-rail.ts), [refunds](../../commerce-v2/src/refunds.ts) | Operations retain their existing owner/flow until proven completion; no new native create overlaps their UNKNOWN scope |
| Intent/places/Arrival/stop | Migrations 0030–0035 and [checkout](../../commerce-v2/src/checkout.ts) | Inventory holds, original deadlines and contexts; the new profile does not treat an old cookie as BOUND |
| Access/tickets | [entitlements](../../commerce-v2/src/entitlements.ts), [LAB tickets](../../commerce-v2/src/lab-tickets.ts) | Do not reissue actual grants and tickets as a new sale; C/FINAL do not determine the duration/scope of rights |
| Restore/erasure | [restore-reconciliation](../../commerce-v2/src/restore-reconciliation.ts), [erasure-restore](../../commerce-v2/src/erasure-restore.ts) | Preserve independent inventory, tombstone/fence, source identity and schema validation. A new adapter requires newly qualified recovery; the old Refref reader does not automatically read the native bank |
| Retired V1 | [AGENTS](../../AGENTS.md), [retirement evidence index](../evidence/2026-10-16-lab-v1-retirement/README.md) | Do not resume V1/runtime/routes or use its archive to backfill new V2 orders. Historical cases require separately authorised recovery within archival scope |

The source main contains **no 0036**; this document does not reserve future SQL numbers. Findings and fixes in unmerged branches/PRs are not part of the baseline. Before implementation, recompute the actual suffix, verify consistency with the decisions and check exact dependency SHAs.

## 2. Inventory before actual cutover

Begin in a separate isolated local environment with synthetic data. An actual read-only inventory is a separately authorised action, not an implicit part of this PR. It requires:

1. Environment source/digest/schema identity, applied journal and prefix, actual stop/readiness/admission, and matching buyer documents/acceptances. Main is not automatically the deployment source.
2. Actual V2 attempts/intents/payment URLs, CREATE_UNKNOWN/REVIEW_REQUIRED, unread successes, refunds/envelopes, fiscal jobs and availability of every original source/owner.
3. Buyer contracts, BOUND/C/claims/registers where they actually exist, and issued LMS grants/LAB holds/tickets/use; MONEY HOLD does not imply an invented empty history.
4. Control totals: payment/refund/UNKNOWN amounts, grants, tickets/occupied capacity and pending outboxes. Separately identify scope without established allocations; do not adjust amounts to force the balance to close.
5. Restore/custody/erasure evidence and actions that must not repeat after restoring an old backup. An independent inventory of orders lost after the backup is required: querying the restored SQLite cannot enumerate records already lost.

Store the result privately with hashes/source times/authority and aggregate results without personal data. Actual exports, tokens/keys and provider payloads must not enter public Git/PRs or foreign CI.

## 3. Sequential implementation

| Stage | Bounded outcome | Exit evidence |
|---|---|---|
| S0 — profile review | Documentation package and FX-C01–14 list; closed Refref O1–O7 decisions are not reopened | One accepted architecture revision, with unresolved profile choices kept explicit |
| S1 — profile admission | Business/origin/campaign mapping, approved seven-day LIMITED_CONTINUATION and due/finality profiles, Refref-only promo codes, native provider scope, current documents/fiscal mapping | Specific supported flows, UNKNOWN outcomes and sources; no new values/authority assigned by the developer |
| S2 — storage/ownership | Forward-only purchase/revision/operation/allocation/outbox facts; immutable past contracts | Migration tests, direct-SQL/NULL/wrong-type guards, prefix integrity, rollback-compatible readers |
| S3 — synthetic source/contract | Separate acquiring and referral adapters, BOUND gate, grant/ticket, UNKNOWN/replay, revisions and refunds | Exact-head unit/DB/concurrency tests; claim source/contract scope only |
| S4 — first working profile | Either LMS or LAB in the selected order; minimal native paid flow without a mandatory SDK or new basket | Authenticated transport for both systems, restart/recovery, durable FULL receipt/qualification; the second profile is not automatically qualified |
| S5 — second profile and profile edge cases | Separate complete verification of LMS access/LAB places/guests | Distinct profile evidence, actual origin scope, moves/refunds and receipt flows |
| S6 — provider/evidence and rehearsal | Separately authorised native acquiring/refund/fiscal source; isolated restore/replay and cutover rehearsal | Independent read-back, qualified scope, preserved history/control totals; a mock is not provider PASS |
| S7 — scoped cutover | After explicit authority: atomically assign new V2 purchases to the v10/native profile | Source/digest/schema/policy/campaign/stop evidence; existing obligations continue to be served |
| S8 — retire old V2 issuance | Remove redundant writers only after completing outstanding tails and checking retention | No orphan operations/rights; separate source/deploy review. No V1 restart |

One profile followed by the other is a technical sequence; both E2E remain required before public Refref GO. Complete LMS/LAB/Mikluha qualification is mandatory for public Refref v10; independent Stage A free access need not wait for another system's financial launch.

## 4. Ownership and safe rollback

Route old V2 RC.2 and new v10/native paths by the stored profile/operation owner, rather than the current environment. During cutover, no order/monetary scope acquires two writers. Original payment URLs must either be proven terminated by their original owner or accounted for as actual opportunities for late execution. Hiding the button is insufficient.

| Failure/point | Permitted recovery | Prohibited action |
|---|---|---|
| Before new promises | Stop new issuance; restore a qualified compatible runtime | Down/reset an applied schema/journal |
| After saved BOUND | Pause new purchases; preserve existing price/contract/operations/reporting/read-back | Disable the entire v10 adapter/API and lose the existing right |
| Native BANK_UNKNOWN | Read back by the original operation identity; fence the specific amount/places | New key/owner and a second charge; TTL as proof that no money moved |
| Refref BOUND UNKNOWN | Read back the original command/result before the first referral payment opportunity | Treat degraded/timeout as a negative result and create retroactive BOUND after payment |
| Refref revision/reporting outage after BOUND | Perform the admissible contract/access/ticket obligations, preserve source facts/outbox and deliver later | Roll back the contract, block a safe balance payment or repeat money movement because ACK is absent |
| Backup predates an external outcome | Independent inventory and native/legacy owner read-back before side effects; reapply erasure tombstones | Repeat payment/refund/receipt based on a rolled-back marker or restore an erased subject |

Include new fields and schema allowlists in backup/retention/restore admission. Do not simply remove fingerprint validation to admit a new schema; retain historical allowlists in their scope. This PR adds no external credentials/custody; a future deployment documents them separately.

## 5. Acceptance programme — 80 scenarios NOT_RUN

Evidence for each executed case: exact Flexperiment/Refref/adapter source SHAs, schema/terms/calendar/profile versions, source IDs and safe receipt hashes, actual HTTP/DB/outbox chronology, money/places/grants before/after. All fixtures remain synthetic unless a provider operation is separately authorised. The IDs and descriptions below are not executed tests.

### Common checks

| ID | Scenario | Expected result |
|---|---|---|
| FX10-COM-001 | Valid action → BOUND → native full payment → FULL | BOUND precedes invoice/link/session; one monetary fact, one original C; profile performance is independent of the receipt |
| FX10-COM-002 | Durable BOUND, ACK lost | Same command/read-back; gate remains closed until the result; no new purchaseRef/partner |
| FX10-COM-003 | Referral BOUND UNKNOWN, UI receives deliveryDegraded | Do not treat timeout as refusal, open the first referral payment or promise retroactive attribution |
| FX10-COM-004 | Organic paid purchase/free access | Perform the system's own obligations; without BOUND create neither C nor a mandatory organic report |
| FX10-COM-005 | Discount applied without valid attribution | No BOUND/C; all other monetary guards are positive; the discount alone creates no right |
| FX10-COM-006 | Valid touch; BOUND attempted after the first payment opportunity | Refuse the new right, without hidden backdating/new purchase identity |
| FX10-COM-007 | Valid attribution/BOUND; buyer did not use the discount | OWNER-02: discount application is not a separate guard; D_rule remains calculated, C derives from G |
| FX10-COM-008 | G−D_rule−C≤0, but D_applied=0 or rounded differently | An ineligible revision does not receive C through substitution of the actual discount; preserve the promised price |
| FX10-COM-009 | Refref-code SDK prefill/edit without Apply/qualified submit; separately submit a legacy Flexperiment-only code that is not valid in Refref | Prefill/edit creates no new promo-touch; reject the invalid code without creating a local merchant discount/stacking path. A legacy prefix alone does not reject a valid Refref code. Independent link/AutoApply, existing holder and accepted price/history remain intact |
| FX10-COM-010 | Qualified ORDER_SUBMIT without separate Apply | Visible code/clear intent/server validation; v10 touch/BOUND before payment. Hidden code does not qualify |
| FX10-COM-011 | Conflicting link/promo during 72h protection | Holder is not replaced; retry/cookie refresh does not extend the period; no queue of losing contenders |
| FX10-COM-012 | Protection expired, prior touch still eligible, buyer switches | No switch without R14.1; check current versions/offer pair; stale confirmation conflicts |
| FX10-COM-013 | Cookie remains live, campaign touch TTL expired; separate TTL>30 fixture | No new BOUND; invalid TTL is rejected. A balance payment under existing BOUND retains its right |
| FX10-COM-014 | LMS logout/account switch or LAB context on another origin | Do not transfer pending proof or assign another holder through email/account; keep scopes separate |
| FX10-COM-015 | Native create timeout after possible dispatch | Actual UNKNOWN/same operation/key; no second create or automatic FAILED |
| FX10-COM-016 | Duplicate callbacks/read-back, concurrent workers/restart | One allocation/buyer obligation/performance; webhook dedup must not conceal distinct actual charges |
| FX10-COM-017 | Redirect success, receipt, approved credit or internal certificate without fulfilled monetary obligations | No false FULL/C; preserve uncertainty/unpaid balance |
| FX10-COM-018 | Local merchant revision accepted; Refref unavailable/refuses eligibility | Contract/safe payment do not wait for ACK; BOUND/history remain. Economic refusal is not S4-zero |
| FX10-COM-019 | FULL carries a sufficient own snapshot; revision not yet CAS-registered | Durable 202/sourceReceipt; qualification uses that snapshot, rather than REVISION_UNKNOWN refusal |
| FX10-COM-020 | FULL under an actual economically ineligible revision | Preserve the fact; APPLIED does not imply positive C; BOUND remains |
| FX10-COM-021 | FULL accepted, specific effective context missing; evidence arrives later | Pending receipt is not C/0; `/v10/evidence` is linked to the original subject. Original times/hash/windows remain unchanged |
| FX10-COM-022 | Old revision ACK after a new local revision/FULL | ACK does not overwrite the contract, first FULL hash/time or qualification; CAS is not last-write-wins |
| FX10-COM-023 | Old actual FULL T1, revision T2, bank callback T3 | With T1<T2<T3, FULL uses the old effective revision; the new snapshot does not replace the actual first settlement |
| FX10-COM-024 | Same source fact delivered with old and new command/key; separately test changed content under the same source ID | One source identity; request/fact fingerprints are distinct. Incompatible fact produces SOURCE_EVENT_CONFLICT, not overwrite |
| FX10-COM-025 | S4 filed before late FULL; stale NOT_PAID/CANCELLED after FULL | Preserve durable filing; late delivery neither adds windows nor erases FULL; check R17.1 with the exact qualified function |
| FX10-COM-026 | Repeated cash movements +100000−100000+100000−25000 during continuation | Balance 75000; do not subtract the old refund twice; no second C/fabricated full cancellation |
| FX10-COM-027 | Mixed synthetic scope: eligible 10000, actual discount 500, ineligible 2000; refund only the ineligible part | Initial FULL for the whole contract is 11500; G/D/C and S4 eligible scope are not reduced by an ineligible refund |
| FX10-COM-028 | Customer refund/service performance record/access revocation without S4; then complete S4 | Consumer process is independent; refund alone does not change C; only an applicable reasoned binary decision can do so |
| FX10-COM-029 | New contractual revision changed after actual FULL | C/original S5 anchor are neither increased nor shifted; preserve additional payments in evidence |
| FX10-COM-030 | Rollback after first BOUND, concurrent late monetary success | Stop new issuance; serve existing obligations/read-back/truthful FULL without changing owner or repeating a charge |
| FX10-COM-031 | Migration/restore with changed historical SQL/hash or a newer erasure tombstone | Refuse a broken immutable chain; the subject does not reappear; the restored DB does not replace independent inventory |
| FX10-COM-032 | Partner payout report/UNKNOWN and a balance dispute | Merchant reports facts under the applicable contract and does not declare a document bank performance; case closure/new register neither discharges debt nor permits repetition |
| FX10-COM-033 | Initial BOUND demonstrably refused; buyer explicitly selects an ordinary purchase | No BOUND according to the verified original command result; truthful agreed price, native sale/access permitted, no C or retroactive attribution |
| FX10-COM-034 | Initial BOUND UNKNOWN; UI offers an ordinary sale through a new purchaseRef | Block this bypass; read back the original command rather than create a second scope/payment. Distinguish UNKNOWN from proven refusal in COM-033 |
| FX10-COM-035 | SCHEDULED_SERVICE: separate fixtures for actual FULL after frozen end and callback after end when actual FULL preceded it | First anchor=max(actual FULL,end)=actual FULL; second=end. Callback receivedAt is not the anchor; 14 Moscow calendar dates from the correct boundary |
| FX10-COM-036 | Partial cancellation: separately proven retained balances exactly C and C+1 kopeck with supported provider execution | With all other guards positive, the first supports S4 and the second does not; upheld S4 is only C/0. No promise of partial refund outside the selected bank scope |
| FX10-COM-037 | Proven cancellation of eligible services, positive cash refund, but agreed continuation of the same purchase | No full-cancellation basis; only the continuation guard is negative, all other guards are positive; no second C or double subtraction |
| FX10-COM-038 | Ordinary customer refund after the applicable PAYMENT window and FINAL, without R17.1/a closed exceptional ground | Perform customer refund/access policy separately; ordinary S4 does not change C. Preserve judicial/settlement/correction grounds |

### LMS / COURSES

| ID | Scenario | Expected result |
|---|---|---|
| FX10-LMS-001 | Native paid immediate course with READY published materials | One COURSE entitlement and activation evidence; referral C is not an access guard |
| FX10-LMS-002 | Refref unavailable after saved BOUND; native bank PAID | Provide promised access, preserve FULL/outbox; outage does not require a second payment |
| FX10-LMS-003 | Payment amount/currency/owner differs from the frozen obligation | No grant/false FULL; scoped review/reconciliation with original facts |
| FX10-LMS-004 | Material/video not READY at payment admission | No fabricated immediate readiness/incorrect fiscal profile; existing accepted contracts remain intact |
| FX10-LMS-005 | New admissible course content published after purchase | Preserve dynamic COURSE access; initial material snapshot remains evidence rather than a hard ceiling; no new C |
| FX10-LMS-006 | ALL_COURSES grant and subsequent course addition | Access follows the applicable scope; new content does not become a second purchase/FULL |
| FX10-LMS-007 | Attempt to use ONLINE_COURSE qualification for a new public COURSE_BUNDLE sale | No bypass of the separate product/provider/fiscal gate |
| FX10-LMS-008 | Free enrolment, manual grant, FREE→PAID | Preserve prior access grounds without fabricated bank money/new BOUND/C |
| FX10-LMS-009 | Unknown payment, return/resume in two tabs | Do not repeat money movement/create a new intent for the same scope; recovery does not automatically navigate to the bank without the required action |
| FX10-LMS-010 | Confirmed relevant refund, grant reconciliation and separate S4 | Perform buyer access/refund policy; S4 is neither permission for a consumer refund nor a means to revoke access |
| FX10-LMS-011 | Browser/Refref recipient attempts to obtain customer email/lesson tokens | Standard result without buyer PII/private media; independently verify auth/consent/DRM scopes |
| FX10-LMS-012 | Approved first LMS profile: PAYMENT with the frozen seven-day policy | Record PAYMENT/profile version and fullPaymentDueAt=addMoscowCalendarDates(purchaseCreatedAt,7) before BOUND; the first actual FULL is the event. Progress/login/new content/retries/requotes do not shift the deadline or create a scheduled-service anchor |

### LAB

| ID | Scenario | Expected result |
|---|---|---|
| FX10-LAB-001 | Guest email/start → consents → hold → BOUND → native full payment | One economic purchase/place/ticket and one FULL/C; guest capability is not attribution |
| FX10-LAB-002 | Two customers compete for the last place | SQLite transaction admits one hold; capacity is not exceeded |
| FX10-LAB-003 | Short hold expired, but the old operation may settle | Do not resell the place based on TTL alone; independent cancellation/read-back by the operation owner closes the monetary scope |
| FX10-LAB-004 | Late success after UI quote/hold expiry | Preserve money/contract; no silent oversell or fabricated NOT_PAID; handle the buyer remedy separately |
| FX10-LAB-005 | Price change/ordinary offer closure after quote issuance | Honour the actual price/deadline guarantee under the qualified profile; close new quotes without extending the old quote through retry |
| FX10-LAB-006 | Emergency storefront stop/occurrence cancellation | Fresh payment admission blocks new operations; read-back/refunds/existing rights remain available |
| FX10-LAB-007 | Guest/start creates an order, response lost; new order creation exhausts the source quota; repeated replay of original capability/email | Verified replay returns the original orderPublicId without a new order/payment/BOUND or consuming creation quota again. Quota exhaustion does not block recovery; preserve ownership/erasure/security guards |
| FX10-LAB-008 | Another person's bearer/receipt or a request from LMS origin for a LAB offer | No access to another person's documents/ticket; verify origin/capability scope; do not infer identity from email |
| FX10-LAB-009 | Repeated QR scan/use, then attempted undo | Use does not execute twice or become an editable payment/referral status |
| FX10-LAB-010 | Participant replacement/move within a continuing purchase | New accepted revision/consent, atomic places, ticket history; same BOUND/C and original S5 |
| FX10-LAB-011 | Two moves to the last place in another occurrence | At most one new allocation; refusal does not destroy the original confirmed place/contract |
| FX10-LAB-012 | Termination and monetary refund, then a separate new purchase | Preserve prior history/claim; new deliberate attribution before payment, without reusing a consumed touch |
| FX10-LAB-013 | Partial refund with provider full-only capability | Refuse unsupported execution correctly before invocation; documentary availability of S4 does not expand bank scope |
| FX10-LAB-014 | Occurrence end date, actual service delivery and closing receipt | Three distinct facts; receipt/timer creates no new FULL/C and does not prove attendance |
| FX10-LAB-015 | Approved first LAB profile: SCHEDULED_SERVICE with frozen end and fullPaymentDueAt capped by salesCutoffAt | Record the profile before BOUND; anchor=max(actualPaidInFullAt,serviceAnchorAtAtBound), with the service end frozen at BOUND. The LAB enum, payment deadline, callback and later move do not select or overwrite the anchor; new instructions require now<min(sevenDayEnd,salesCutoffAt) and current availability |
| FX10-LAB-016 | Old V1 token/URL after v10 cutover | Public V1 remains stopped/static 410; do not import the archive as a v10 order; historical recovery remains within separately authorised scope |
| FX10-LAB-017 | Source quota exhausted; a new capability with the same email and, separately, another person's capability/changed email are presented | A new order under a new capability remains subject to creation quota; reject changed email under a known capability; replay bypass does not bypass security/erasure guards or disclose another person's order |

### Durable unpaid purchase / FX-C12

These are U1–U13 from the final reconciliation, included under their own IDs. **OWNER approved FX-C12 as LIMITED_CONTINUATION for both LMS and LAB: seven Moscow calendar dates from the first durable purchaseCreatedAt.** Freeze that time and the policy version at creation. `continuationUntil = addMoscowCalendarDates(purchaseCreatedAt, 7)` preserves the recorded time of day in `Europe/Moscow`; retry, requote, resume, recovery and UI remount do not reset it. Apply the approved version prospectively, without changing existing accepted prices, rights or history.

For the first single-full-payment profile, LMS `fullPaymentDueAt = addMoscowCalendarDates(purchaseCreatedAt, 7)`; LAB `fullPaymentDueAt = min(addMoscowCalendarDates(purchaseCreatedAt, 7), salesCutoffAt)` for the applicable accepted cutoff. New payment instructions require `now < fullPaymentDueAt`, accepted price/consents, ownership, money safety and current availability. The boundary is exclusive. The seven-day period does not reserve a seat or renew the original LAB hold of at most 15 minutes. PENDING/UNKNOWN/REVIEW monetary and reservation fences remain in place; already authorised operations can settle late, and genuine FULL is preserved under the original BOUND and effective revision.

Genuine terminal grounds are explicit buyer cancellation, evidenced merchant impossibility with proper termination, or expiry of the continuation period/effective LAB cutoff. UI reset/back/new-order actions are not cancellation; temporary sold-out status alone is not final impossibility. A CANCELLED report alone is not terminal. Two documented contractual outcomes may have the same reported CANCELLED; follow the fixed policy version and facts, not merchant discretion after the buyer returns. No new instructions follow a genuine terminal ground; read-back/history/recovery for authorised operations remain available.

The following synthetic calendar fixtures make the approved period concrete. They are inputs for the existing RES cases, not additional case IDs or executed product tests. All instants are UTC; calendar arithmetic uses Europe/Moscow and preserves local time of day.

| Fixture | Profile | purchaseCreatedAt | salesCutoffAt | Expected sevenDayEnd | Expected fullPaymentDueAt |
|---|---|---|---|---|---|
| CAL-01 | LMS | 2026-10-27T12:00:00Z | n/a | 2026-11-03T12:00:00Z | 2026-11-03T12:00:00Z |
| CAL-02 | LAB | 2026-10-27T12:00:00Z | 2026-10-30T09:00:00Z | 2026-11-03T12:00:00Z | 2026-10-30T09:00:00Z |
| CAL-03 | LAB | 2026-10-27T12:00:00Z | 2026-11-06T09:00:00Z | 2026-11-03T12:00:00Z | 2026-11-03T12:00:00Z |
| CAL-04 | LMS | 2026-12-29T23:30:00Z | n/a | 2027-01-05T23:30:00Z | 2027-01-05T23:30:00Z |

For each fixture, equality with fullPaymentDueAt refuses a new instruction. A pre-existing authorised operation and its reconciliation are not invalidated by that equality. Retry/requote must reproduce the original deadline rather than use the retry time as purchaseCreatedAt.

Report FULL by the end of the next Russian business day after actual FULL, independently of the seven-day deadline. At due time, obtain and report the appropriate known state and CANCELLED where applicable; a NOT_PAID+CANCELLED pair is not mandatory. Preserve UNKNOWN with diagnostics rather than falsely reporting unpaid or releasing a money/seat fence.

| ID | Scenario | Expected result |
|---|---|---|
| FX10-RES-001 | U1: price expired before BOUND, still strictly before the fixed payment deadline | Preview did not consume the touch; after a newly agreed quote, one BOUND before the first payment opportunity. The original purchaseCreatedAt/policy version and seven-day deadline do not reset |
| FX10-RES-002 | U2: BOUND exists, no payment, quote expired, buyer continues the same purchase before its fixed deadline | LMS account ownership / LAB scoped capability or qualified recovery; email match alone is insufficient. Same purchaseRef/BOUND/partner and original purchaseCreatedAt/policy deadline, new agreed quote/revision, no repeated touch consumption; LAB also requires fresh availability |
| FX10-RES-003 | U3: BOUND recorded, ACK lost, handoff expired | Ownership-checked recovery of the original command; a new UI mount/handoff creates no second right or seven-day reset; payment stays closed pending read-back and cannot open at/after the fixed deadline |
| FX10-RES-004 | U4: two tabs resume/requote concurrently, including a lost local resume response | Local purchase CAS/revision+outbox transaction serialise admission; reread the stale version; idempotent recovery, not last-request-wins. Both tabs retain the original purchaseCreatedAt/policy deadline; Refref CAS neither authorises the local contract nor extends the period |
| FX10-RES-005 | U5: quote expired, old session still executable or bank outcome UNKNOWN, including at the fixed deadline | No overlapping new create; retain PENDING/UNKNOWN/REVIEW money/seat fences and read back the original operation. Any new operation also requires proven closure of the old one and now<fullPaymentDueAt; do not reuse the old key with a new body |
| FX10-RES-006 | U6: actual old FULL occurred before a new revision; callback arrived later | FULL belongs to the effective old hash/time; do not request payment again; one grant/ticket and one C |
| FX10-RES-007 | U7: explicit genuine buyer cancellation, evidenced merchant impossibility with termination, or the fixed period/effective cutoff ends; independent new sale of the same product | Record the genuine terminal ground/effective time; UI reset/back/new-order action, temporary sold-out status and a CANCELLED report alone do not qualify. A genuinely independent new sale has a new contract/purchaseRef and action/BOUND; matching account+product and consumed touch do not transfer the old partner. Close admission of new instructions for the old purchase, retaining its read-back/history and late-FULL reporting |
| FX10-RES-008 | U8: new accepted revision of a continuing purchase is economically ineligible | Preserve contract/BOUND, accept truthful FULL, do not promise positive C for an ineligible revision; this is not S4-zero |
| FX10-RES-009 | U9: LAB buyer returns on Moscow calendar day 3 after the original short quote/hold expired, before the fixed seven-day end and accepted sales cutoff; no unresolved prior operation fences the seat | Same purchaseRef/BOUND/partner and original policy deadline; newly agreed price and fresh seat availability/admission. The old hold remains expired and was not renewed or stretched to seven days; temporary sold-out status blocks new payment without itself terminating the purchase |
| FX10-RES-010 | U10: touch already expired, valid BOUND and purchase still within its fixed continuation/payment period | New instructions still require now<fullPaymentDueAt and all profile guards, but require no new touch; touch expiry applies to a new BOUND. An already authorised operation may settle later under the original BOUND |
| FX10-RES-011 | U11: fixed fullPaymentDueAt reached; separately test a pre-existing authorised PENDING/UNKNOWN operation and a purchase with no such operation | No new instructions or arbitrary refresh/due extension. Only the pre-existing authorised operation may settle late; retain its money/seat fences and accept/report genuine FULL under old BOUND by the next Russian business day after actual FULL. At due time report the appropriate known state/CANCELLED where applicable, without a mandatory NOT_PAID+CANCELLED pair or false unpaid state for UNKNOWN; preserve reporting history |
| FX10-RES-012 | U12: touch remains live, but the effective LAB cutoff is reached; separately test temporary lack of seats before cutoff | No new instruction at/after the exclusive minimum of seven-day end and cutoff, oversell or hold extension based on BOUND alone. Temporary sold-out status blocks new admission without proving termination. Preserve authorised-operation recovery/fences and truthful late FULL; an incidental transfer without fulfilment of the obligation is not FULL/C based on amount alone |
| FX10-RES-013 | U13: CANCELLED reported; buyer returns strictly before the fixed seven-day/payment deadline and no genuine terminal ground occurred | Explicit ownership and preserved objective grounds retain the same purchaseRef/BOUND/partner and one C after actual FULL, with a newly agreed quote and LAB availability where required; original CANCELLED remains historical. Contrast RES-007: the same report with a proven terminal ground cannot resume new instructions. The policy cannot be chosen retroactively; genuine late FULL of an operation authorised before closure is delivered under old BOUND in both cases |

Test negative guards in isolation: valid attribution with late BOUND, positive economics without attribution, valid refund during a continuing purchase. Several false conditions in one test do not prove sensitivity to each guard. Profile E2E must execute against actual consumers, not only the Refref oracle.

## 6. Applicable CI and actual verdicts

The current [.github/workflows/test.yml](../../.github/workflows/test.yml) has two jobs, `test` and `docker-build`: exact CI source checkout, immutable migrations, frontend/Commerce types/tests/builds, isolation/restore/proxy checks and actual container builds. The documentation PR preserves these workflows. Current project CI checks current code, rather than implementation of the 80 future scenarios.

| Axis | This package's status | Required after implementation |
|---|---|---|
| Source audit/docs integrity | Checked by validator and review | Recheck target SHA when main/upstream changes |
| v10 implementation source/contract | NOT_RUN | Exact-head DB/concurrency/adapter guards, auth/scope, money/cash/effective-time tests |
| Served transport E2E | NOT_RUN | Working authenticated routes in both systems, sourceReceipt/evidence/replay/outbox/restart |
| Provider/evidence E2E | NOT_RUN | Separately authorised bank/refund/fiscal scope and independent read-backs |
| Public admission | Not granted | Separate LMS, LAB and Mikluha E2E before public Refref GO; actual legal/profile authority |

The older specific error `PURCHASE_V9_TRANSPORT_NOT_QUALIFIED`, if present in the selected executable adapter, refuses the v9 route; it does not authorise sending v10 through RC.2. A missing v10 endpoint blocks transport qualification; new documented routes do not prove deployment.

**CUSTODY_IMPACT: NO** for this PR. Future provisioning/deployment/schema installation involving host resources must separately list custody authorities and evidence under [AGENTS](../../AGENTS.md). Publication, a correct restore and green CI provide no automatic authority to take payment, enable a storefront switch or repeat an operation with unknown outcome.
