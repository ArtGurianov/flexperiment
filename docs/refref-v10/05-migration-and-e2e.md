# Migration to Refref v10 and the E2E programme

Status: strategy and acceptance plan for owner review, 27 October 2026. Nothing here was implemented or executed.

## 1. What must not be lost

| Source | Today | Rule for the transition |
|---|---|---|
| Migrations `0001`–`0035` and `migration.lock` | Applied chain of `commerce-v2` | New tables come as forward migrations after `0035`; applied files and lock entries never change |
| RC.2 attempts, payments and refund executions | Owned by the Refref rail; unknown outcomes are read back, never assumed | Every open or unknown attempt finishes under its old owner; the native adapter never repeats it |
| Accepted legal versions, quotes, fiscal policies | Frozen into orders and lines | Kept byte-for-byte; new terms apply only to new purchases |
| Entitlements and LAB tickets | Granted on a confirmed payment; revoked only after a confirmed refund | Same rule with the native provider as the payment truth |
| Arrival contexts and proofs | Short-lived merchant state | Not converted into v10 touches or `BOUND` records |
| v9 referral design | Documented target, not activated for money ([v9 status](../refref-v9-contract-status.md)) | Not carried into new rights; any real old right found by the inventory keeps its own rules |

## 2. Inventory before schema changes or cutover

A separately authorised read-only inventory establishes, per environment: schema identity against the lock; open RC.2 attempts, `UNKNOWN` payments and refund executions; orders in `REVIEW_REQUIRED` or `REFUND_PENDING`; entitlements and tickets granted from them; any referral rights or commissions that really exist; aggregate amounts by owner. No personal data leaves the host. Absence of a public launch does not prove an empty history (FX-C10).

## 3. Implementation stages

| Stage | Bounded result | Exit condition |
|---|---|---|
| F0 — review | This package; decisions FX-C01–FX-C10 | Scope agreed; Refref owner decisions not reopened |
| F1 — provider and fiscal qualification | Chosen native acquiring, fiscal profile and buyer terms for courses, bundles and LAB | No invented defaults; unknown outcomes and read-back documented |
| F2 — native payments and refunds | Payment and refund operations, ownership per order, read-back, receipts | Grant and revoke rules unchanged; no double charge after timeout or restart |
| F3 — referral model and outbox | `purchaseRef`, referral record, outcome outbox in the same transaction as the business fact | Exact-head tests for one `BOUND` and one `FULL` per purchase |
| F4 — touch and Apply | Arrival replaced by v10 touch and holder handling; explicit Apply for Refref codes in LMS and LAB | 72-hour protection, switch confirmation, campaign touch lifetime; unknown result never opens payment |
| F5 — Refref transport | Real HTTP path to a served Refref v10 | Timeout, restart and replay by command id; no second `C` |
| F6 — provider E2E | Real acquiring and fiscal path in an authorised environment | Provider read-back and receipt evidence, not mocks |
| F7 — cutover rehearsal | Copy of the schema with synthetic RC.2 and v10 history | Aggregates match; old owners still reachable; rollback keeps existing rights |
| F8 — scoped activation | Separate owner GO per storefront | Recorded scope, exact SHAs, runtime read-back; a merge does not open sales |

## 4. Ownership at cutover

| Object | Rule |
|---|---|
| RC.2 attempt created before cutover, or its outcome unknown | Stays with the Refref rail until a final outcome; read-back and refund routes stay available |
| New v10 purchase | Flexperiment provider takes the payment; Refref holds `BOUND`, outcome and commission |
| New ordinary purchase | Flexperiment only; nothing reported to Refref |

Cutover assigns the owner per purchase in the database. Switching a UI flag or environment variable without persisted ownership is not enough.

## 5. Rollback and failures

| Situation | Allowed recovery | Forbidden |
|---|---|---|
| Before the first v10 `BOUND` | Stop new issuance; keep schema and evidence | Down-migrations, resets |
| After `BOUND`, before payment | Stop new promises; serve existing `BOUND`, prices and payments | Disabling the v10 API as a whole, asking the buyer to pay again |
| After `FULL` or a claim | Forward fix | Changing `C`, windows or debts by rollback |
| Provider timeout | Keep the operation and key, read back, keep seats | A new key or a second operation for the same amount |
| Refref unavailable after `BOUND` | Keep selling under the saved `BOUND`; deliver the outbox later | A second payment because an answer is missing |
| Refref unavailable before `BOUND` | Ordinary sale only after a proven absence of `BOUND` | Treating a timeout as refusal; binding after payment |

## 6. Planned E2E scenarios

All scenarios are `NOT_RUN`. Amounts are synthetic. Each executed scenario records the exact Flexperiment, Refref and adapter SHAs, correlation ids without personal data, the request and outbox chronology, provider read-back, and the expected and actual number of payments, commissions and tickets.

| ID | Input | Required assertions |
|---|---|---|
| FXV10-E2E-01 | LMS: referral link → `BOUND` → full payment of a course | `BOUND` before the payment session; one `FULL`, one `C`; access after confirmed payment; anchor = payment |
| FXV10-E2E-02 | LAB: referral link → `BOUND` → ticket payment | One `FULL`, one `C`; ticket after confirmed payment; anchor = frozen occurrence end |
| FXV10-E2E-03 | Bundle purchase through a promo touch with Apply | Touch from Apply only; one `C` for the bundle; `ALL_COURSES` entitlement |
| FXV10-E2E-04 | Code typed in the field, no Apply, then payment | No promo touch, no Refref discount; an existing link touch is kept |
| FXV10-E2E-05 | Valid touch, buyer removes the Refref discount | `D_applied = 0`; same `C`; suitability checked with `D_rule` |
| FXV10-E2E-06 | Discount applied without a valid touch | No `BOUND`, no `C`; only this guard fails |
| FXV10-E2E-07 | `BOUND` attempted after the payment session exists | Refused; no `C`; only the chronology guard fails |
| FXV10-E2E-08 | Flexperiment promotion code plus a link touch | Promotion lowers `G`; touch unchanged; stacking per FX-C06 |
| FXV10-E2E-09 | Conflicting link inside 72 hours | Holder unchanged; no queue; cookie refresh does not extend protection |
| FXV10-E2E-10 | After 72 hours, buyer switches with confirmation | Switch only with confirmation and the current holder version; stale confirmation refused |
| FXV10-E2E-11 | Touch expired while the cookie is alive | No new `BOUND`; touch lifetime from campaign terms, not the cookie |
| FXV10-E2E-12 | `binding.create` answer lost | Payment gate closed; read-back by command id returns the same `BOUND` or refusal |
| FXV10-E2E-13 | Refref refuses `BOUND` | Ordinary sale offered with a clear price; no referral right |
| FXV10-E2E-14 | Restart during Buy, old `deliveryDegraded` path | No referral payment on an unknown result; no retro-`BOUND` |
| FXV10-E2E-15 | Payment timeout after possible dispatch | Same operation and key; read-back decides; seat kept |
| FXV10-E2E-16 | Duplicate provider callbacks and a restart | One payment fact, one outbox fact, one `C` |
| FXV10-E2E-17 | Refref `FULL` delivery answer lost | Same command replayed or read back; no second `C`, same actual time |
| FXV10-E2E-18 | `fullPaymentDueAt` passes without payment | True `NOT_PAID`/`CANCELLED` after the order closes; no loss of `BOUND` |
| FXV10-E2E-19 | Payment succeeds after the order was closed as cancelled | True `FULL` delivered once with its actual time |
| FXV10-E2E-20 | Refref unavailable after `BOUND` during payment | Payment not blocked; outbox delivers later with original times |
| FXV10-E2E-21 | LMS full refund inside the window, all eligible services ended | Access ends after confirmed refund; full-cancellation claim may zero `C` |
| FXV10-E2E-22 | LMS refund after the `PAYMENT` window | Access per buyer policy; `C` unchanged; no claim basis |
| FXV10-E2E-23 | LAB occurrence cancelled by Flexperiment, cash refund | Claim may zero `C` inside the window; refund receipt issued |
| FXV10-E2E-24 | LAB occurrence cancelled, credit toward another date instead of cash | Not a cash refund; no full-cancellation basis; continuation visible in the snapshot |
| FXV10-E2E-25 | LAB move to another occurrence with the buyer's consent | Same `purchaseRef`, `BOUND`, `C`; anchor not moved |
| FXV10-E2E-26 | LAB move implemented as refund and new payment | Treated as continuation; both money flows in the snapshot; one `C` |
| FXV10-E2E-27 | Two buyers move to the last seat of an occurrence | At most one succeeds; the other keeps the old seat |
| FXV10-E2E-28 | Partial refund (if FX-C05 allows) with remaining eligible money above `C` | No claim basis; `C` whole |
| FXV10-E2E-29 | Claim filed before a late `FULL` arrives | Claim kept and applied to the later `C`; no new window |
| FXV10-E2E-30 | Ticket scanned, closing receipt issued | Not Refref events; anchor unchanged |
| FXV10-E2E-31 | Receipt timeout after a successful payment | No duplicate receipt or payment; read-back first |
| FXV10-E2E-32 | Monthly registry; partner disputes part of it | Flexperiment answers with evidence in time; missing report is not proof of non-payment |
| FXV10-E2E-33 | Payout transfer outcome unknown at the deadline | No second transfer for the same amount; remainder reported as unclear |
| FXV10-E2E-34 | RC.2 attempt open at cutover; native payment attempted in parallel | Persisted owner blocks the second payment; old read-back still works |
| FXV10-E2E-35 | Rollback after the first v10 `BOUND`, then the buyer pays | New promises stopped; the bound purchase served; one `C` |
| FXV10-E2E-36 | Requests for another merchant's purchase or with buyer data in the result | Refused; no personal data sent or logged |
| FXV10-E2E-37 | LMS logout or account switch with a pending touch | Touch does not move to the other account; no cross-account matching |

Negative money guards need one test per guard with every other condition satisfied: no attribution, late `BOUND`, continuation instead of cancellation. Removing a guard must break its own test.

## 7. Checks during implementation

The existing [test workflow](../../.github/workflows/test.yml) keeps running: migrations, Commerce V2 tests, storefront and Control Room builds. Each implementation PR adds v10 tests for its own code and keeps separate verdicts for source/contract, served transport and provider evidence.

Required before Refref's public GO: the LMS and LAB paths above with a real adapter, together with Mikluha's deposit path, and an explicit owner GO. A green CI never grants the next step.
