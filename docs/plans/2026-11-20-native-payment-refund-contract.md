# FLEX-119: native payment, refund and authoritative reconciliation contract

Status: **contract for review**. Nothing here is implemented in runtime yet. This PR adds the
contract, its fixtures and a pure decision module that the fixtures are tested against. It adds no
DDL, route, provider, configuration or host change.

- Plane: FLEX-119 (this card). Inputs: owner decision 4A of 18.11.2026 in FLEX-17; FLEX-85 (LAB
  closing receipt), FLEX-76 (course FULL_PAYMENT), FLEX-90 (emergency stop), FLEX-36/48 (refund
  authority). Coordination: the FLEX page "Координация V2 · волна 1" (`fb8cf731`).
- Base: `main` `be55bb755100535fd2af5f2a407b1be0199e2c40`. Branch `claude/flex-119-native-payments`.
- Code: [`commerce-v2/src/native-payment-contract.ts`](../../commerce-v2/src/native-payment-contract.ts).
  Fixtures: [`commerce-v2/test/fixtures/native-payments/`](../../commerce-v2/test/fixtures/native-payments/).
  Test: [`commerce-v2/test/native-payment-contract.test.ts`](../../commerce-v2/test/native-payment-contract.test.ts).

## 1. What this contract decides

Under decision 4A, the first paid launch uses Flexperiment's own direct ("native") acquiring and
refunds. Commerce owns these steps:

1. creating a payment for an immutable order snapshot;
2. deciding that money was received, which only an authoritative provider read-back can establish;
3. granting LMS access or issuing a LAB ticket once, on that fact;
4. executing an approved full refund and revoking access once, on the provider's confirmed refund;
5. emitting fiscal events through a provider-neutral port, reconciled separately from money.

The direct contour does not depend on Refref, so it keeps working while Refref is unavailable.
Historical RC.2 operations remain with their original executor (§9).

Out of scope: the real bank, KKT and OFD profile; real money; checkout UI (FLEX-122); the LAB
lifecycle (D); Refref v10 (FLEX-124); public sales switches (owner; FLEX-90); partial refunds.

## 2. Invariants

| # | Invariant |
|---|---|
| I1 | Every payment, refund and fiscal event is bound to the frozen order: `merchantOrderRef`, `amountKopecks`, `currency`, `snapshotHash` (= `orders.snapshot_hash`). A provider fact that differs in any field goes to `REVIEW_REQUIRED` and never grants access. |
| I2 | Only an authenticated `READ_BACK` from the provider is a financial fact. A browser return, a callback or a create response is a hint. |
| I3 | A lost answer means `UNKNOWN`. Absence is never concluded from silence. A local deadline never turns an unknown or pending payment into `EXPIRED`. Only the provider's own terminal read-back does. |
| I4 | Retries resend the **same** request under the **same** idempotency key. Keys are deterministic: `native-pay:{orderPublicId}:1`, `native-refund:{refundRequestPublicId}:1`, and the fiscal `eventRef` (§6). The request body is frozen before the first send and never rebuilt. The refund body stays in the existing sealed envelope (`refund-envelope.ts`). |
| I5 | `GRANT` happens once, on the transition into `PAID`. `REVOKE_ACCESS` happens once, on the transition of a full-line refund into `SUCCEEDED`. Effects are applied in the same SQLite transaction as the state change, so a crash either keeps both or neither. |
| I6 | A contradiction (a late success after a terminal status, a regression such as PAID→DECLINED, a foreign provider id, or a known payment the provider no longer finds) goes to `REVIEW_REQUIRED` with `ALERT`. No automatic grant, revoke or refund follows. |
| I7 | New money (`PROVIDER_CREATE`, `REPLAY_CREATE_SAME_KEY`) requires sales admission at the moment of sending: the storefront switch and the FLEX-90 emergency stop. Read-back, fulfilment of money already received, refunds and fiscal reconciliation never wait for admission. This means the FLEX-90 emergency stop does **not** stop refund execution. The coordinator has put that to the owner as an explicit decision; until the owner answers, this is the default. |
| I8 | A fiscal event never creates, blocks or reverses a financial effect. A missing or rejected receipt alerts an operator. Access already granted on a confirmed payment stays. |
| I9 | Each order's contour (`NATIVE` or `REFREF_RC2`) is decided by what is stored with the order, never by current configuration. |

## 3. Payment

States: `CREATING → CREATE_UNKNOWN | PENDING → PAID | DECLINED | EXPIRED | REVIEW_REQUIRED`.

The full table is `applyPaymentObservation`. In summary:

| Observation | From | To | Effects |
|---|---|---|---|
| create `ACCEPTED(id)` | CREATING, CREATE_UNKNOWN | PENDING | READ_BACK |
| create `LOST` | CREATING, CREATE_UNKNOWN | CREATE_UNKNOWN | READ_BACK |
| create `REFUSED` (provider proves this exact request was not accepted) | CREATING, CREATE_UNKNOWN | DECLINED | RELEASE_HOLD (LAB) |
| callback, signature invalid | any | unchanged | — (recorded, dropped) |
| callback, valid | any | unchanged | READ_BACK |
| read-back `UNAVAILABLE` | any | unchanged | — (retried by the sweep) |
| read-back `NOT_FOUND`, no provider id known | CREATING, CREATE_UNKNOWN | CREATE_UNKNOWN | REPLAY_CREATE_SAME_KEY if admitted, else none |
| read-back `NOT_FOUND`, provider id known | any | REVIEW_REQUIRED | ALERT |
| read-back `FOUND`, binding mismatch | any | REVIEW_REQUIRED | ALERT |
| read-back `PAID` | CREATING, CREATE_UNKNOWN, PENDING | PAID | GRANT (+ ISSUE_PAYMENT_RECEIPT in MERCHANT mode) |
| read-back `PAID` | PAID | PAID | — |
| read-back `PAID` | DECLINED, EXPIRED | REVIEW_REQUIRED | ALERT (`LATE_PAYMENT_AFTER_TERMINAL`) |
| read-back `DECLINED` / `EXPIRED` | CREATING, CREATE_UNKNOWN, PENDING | same as provider | RELEASE_HOLD (LAB) |
| read-back `DECLINED` / `EXPIRED` / `PENDING` | PAID | REVIEW_REQUIRED | ALERT; access stays |

On `PAID` for a LAB line, `RESERVE_FINAL_SETTLEMENT` creates the line's `FINAL_SETTLEMENT` fiscal event in `AWAITING_SERVICE` with the sealed receipt contact, in the same transaction (§6.1).

**One payment per order.** A payment is unique per order: `native_payments.order_id` is UNIQUE and the key ends in `:1`. After `DECLINED` or `EXPIRED`, buying again means a **new order with a new snapshot**. A second payment on the same order is impossible by construction.

The provider payment request carries `merchantOrderRef`, the amount and currency, the payment
purpose (`payment-purpose.ts`, already frozen in the v2 snapshot) and `snapshotHash` as merchant
metadata. A provider fact without that metadata cannot be bound, so it goes to review.

Deadlines. A LAB seat hold and the quote deadline (the 15 minutes from `checkout_quotes`) limit
when a payment may be **started**. They never decide its outcome. When a hold expires while the
payment is still `PENDING` or `CREATE_UNKNOWN`, the seat stays committed (existing
`lab-occurrences.ts` semantics: an uncertain payment never loses its seat). It is released only by
`RELEASE_HOLD` after a terminal provider fact. The provider payment link must expire no later than
the hold deadline (provider qualification item Q3).

## 4. Callback intake

`POST /v1/native-payments/callback` is a proposed route. It changes `app.ts` and is registered
through the coordinator in phase 2. The route:

1. verifies the provider signature with a key that never leaves the runtime env;
2. stores the raw event in an append-only inbox. Duplicates are recognised by
   `(provider, provider_event_id)`, or by a body hash when the provider sends no event id;
3. answers 2xx after the insert. It never answers 2xx before the event is durable;
4. schedules a read-back of the referenced payment or refund.

The handler never changes payment or refund state. A forged, duplicated, reordered or lost callback
therefore cannot cause or prevent a financial effect: fixtures P05, P06, P07 and R08. The periodic
sweep (`reconcilePendingNativePayments`, `reconcilePendingNativeRefunds`) reads back every
non-terminal record, whether or not a callback arrived.

## 5. Refund

Eligibility, amount and decision stay where they are today (FLEX-36/48): `requestRefund`,
`registerEmailRefund` and `decideRefund` in `refunds.ts`, full line only. Execution is dispatched by
contour (§9):

- `REFREF_RC2`: the existing `executeApprovedRefund` and `reconcilePendingRefunds`, unchanged;
- `NATIVE`: the new `executeApprovedNativeRefund`. It uses the same sealed-envelope discipline,
  admission from `admitRefund`, and transitions from `applyRefundObservation`.

Admission (`admitRefund`) requires: the order is on the `NATIVE` contour; the payment is `PAID`; the
approved amount equals the line amount and nothing was refunded before; and no `FINAL_SETTLEMENT`
exists for the line, in any state other than `NOT_REQUIRED`. Compensation after a LAB service was
rendered is not supported and is refused. It is not mislabelled as a cancellation (FLEX-36).

States: `SUBMITTING → SUBMIT_UNKNOWN | PROCESSING → SUCCEEDED | FAILED | REVIEW_REQUIRED`.

| Observation | Result |
|---|---|
| submit `ACCEPTED(id)` | PROCESSING, READ_BACK |
| submit `LOST` | SUBMIT_UNKNOWN, READ_BACK |
| submit `REFUSED` proven terminal | FAILED, PURGE_ENVELOPE, ALERT; access stays |
| submit `REFUSED` not proven (generic 4xx, conflict) | REVIEW_REQUIRED, ALERT; envelope kept |
| read-back `NOT_FOUND` while unknown, no id | SUBMIT_UNKNOWN, REPLAY_REFUND_SAME_KEY (same sealed envelope) |
| read-back `SUCCEEDED` bound to the payment id, amount, currency and refund ref | SUCCEEDED, REVOKE_ACCESS, PURGE_ENVELOPE (+ ISSUE_REFUND_RECEIPT in MERCHANT mode) |
| read-back `SUCCEEDED` after FAILED | REVIEW_REQUIRED (late result) |
| binding mismatch or id conflict | REVIEW_REQUIRED |

There is no admission gate on refund replay. The provider deduplicates by key (provider
qualification Q2). If the selected provider cannot guarantee that, refunds stay manual-only through
the existing Control Room path until it is qualified.

## 6. Fiscal port and adapter

A provider-neutral port, `fiscal-port.ts` in phase 2, with one record per required fiscal event:

| Kind | When | Payment method (tag 1214) | Key |
|---|---|---|---|
| `PAYMENT_RECEIPT` | the payment becomes `PAID` | from the frozen qualified policy (`paymentReceiptMethod`): `ONLINE_COURSE` → `FULL_PAYMENT` (FLEX-76), `LAB` → `FULL_PREPAYMENT` (FLEX-85). Any other combination is refused | `fiscal:PAYMENT_RECEIPT:{orderLineId}` |
| `REFUND_RECEIPT` | the native refund becomes `SUCCEEDED` | same method as the receipt it returns | `fiscal:REFUND_RECEIPT:{orderLineId}:{refundRequestPublicId}` |
| `FINAL_SETTLEMENT` | LAB `SERVICE_RENDERED` is admitted (§7) | `FULL_PAYMENT`, offsetting the advance, with **no new payment** | `fiscal:FINAL_SETTLEMENT:{orderLineId}` |

Fiscal lines come only from `order_lines.fiscal_item_json`, which the order froze from the
qualified fiscal policy. They never come from today's catalogue or policy.

Modes (`fiscalizationMode`, already part of the snapshot):

- `MERCHANT`: our adapter submits the receipt. The states follow `applyFiscalObservation`:
  submit/lost/read-back/replay with the same `eventRef`, and `REJECTED` or a mismatch → alert.
- `PROVIDER`: the acquiring service fiscalizes the payment and the refund itself. The record is
  `NOT_REQUIRED`, and the provider's receipt reference is attached from the payment read-back as
  evidence. **FINAL_SETTLEMENT is impossible in this mode** unless the adapter declares
  `finalSettlementWithoutPayment`. Today's Точка «Чеки» path does not (FLEX-85), so LAB stays
  closed. The capability is checked, never assumed (fixture S02).

### 6.1 Receipt contact for the later closing receipt

The payment envelope (with the e-mail) is purged when the payment reaches `PAID`. D stores only
`receipt_contact_sha256`. The contact for a `FINAL_SETTLEMENT` issued after the occurrence ends
therefore comes from its own reservation:

- On `PAID` for a LAB line, the `RESERVE_FINAL_SETTLEMENT` effect inserts `fiscal_events`
  (`FINAL_SETTLEMENT`, state `AWAITING_SERVICE`). It is written in the same transaction as the
  ticket, and the receipt contact is copied, sealed, from the payment envelope before that envelope
  is purged. The frozen lines and amount come from `order_lines.fiscal_item_json`.
- The issuance job moves it `AWAITING_SERVICE → SUBMITTING` only when `admitFinalSettlement` admits
  it (§7). The contact is purged when the event reaches a terminal state (`REGISTERED`, `REJECTED`).
- **Cancellation** (`cancelReservedSettlement`): a successful refund of the line, or a cancellation
  of the occurrence, before issuance moves the event to `CANCELLED` and purges the contact. Once
  issuance has started it cannot be cancelled; that case alerts (fixture C04).
- **Retention ceiling:** the sealed contact is kept at most until the occurrence's `ends_at` plus 30
  days (proposal). If no `SERVICE_RENDERED` fact has arrived by then, the event goes to
  `REVIEW_REQUIRED` with an alert, and the contact stays only while that review is open. Retention
  ends with a decision, never silently.
- Refund admission treats `AWAITING_SERVICE` and `CANCELLED` as "settlement not started" (A08, A09).

The adapter port (`fiscal-adapter.ts`, with a fake in tests):

```ts
interface FiscalAdapter {
  readonly capabilities: FiscalAdapterCapabilities;
  submit(event: FrozenFiscalEvent): Promise<FiscalSubmitResult>;   // idempotent on event.eventRef
  read(eventRef: string): Promise<FiscalReadBack>;                  // FOUND | NOT_FOUND | UNAVAILABLE
}
```

## 7. SERVICE_RENDERED → FINAL_SETTLEMENT (shared contract with D; D assembles the FLEX-85 proof)

Proposed single contract, to be agreed with D through the coordinator:

- **D owns** an authoritative, append-only fact per order line, in D's own table `lab_service_renditions` (D's migration 0040, not 0039):

  ```json
  { "schema": "flexperiment.service-rendered/1", "orderLineId": "…", "occurrenceRef": "…",
    "renderedAt": "ISO-8601", "evidenceRef": "lab-lifecycle:…", "recordedBy": "operator:…",
    "basis": "CHECKED_IN" | "ATTENDED_ATTESTED" }
  ```

  It is written once, by the LAB lifecycle (`lab-lifecycle*.ts` / `service-rendered*.ts`), when the
  occurrence is finished and its completion evidence is recorded. It is idempotent per
  `orderLineId`. A conflicting second fact is refused. D also exposes whether the occurrence is
  cancelled.
- **C owns** admission and issuance. `admitFinalSettlement` admits exactly one `FINAL_SETTLEMENT`
  per line when all of these hold:
  - kind `LAB`;
  - the line's settlement is `AWAITING_SERVICE` (reserved at PAID, §6.1);
  - the adapter can settle without payment;
  - the fact matches the line and the occurrence;
  - the occurrence is not cancelled;
  - the payment is `PAID`;
  - `PAYMENT_RECEIPT` is `REGISTERED`;
  - no refund is open or has succeeded.

  Any failed condition refuses with a code, without retry until the input changes. Fixtures S01–S09.
- **Uncertainty.** An issuance in `SUBMIT_UNKNOWN` is resolved only by read-back of the same
  `eventRef`, then replay under that key. A refund request arriving while settlement is in any state
  except `NOT_REQUIRED` is refused (`REFUND_AFTER_FINAL_SETTLEMENT_NOT_SUPPORTED`) and goes to a
  person.
- **Interface (coordinator decision of 21.11.2026).**
  - D writes the fact through its own `recordServiceRendered(fact)` into `lab_service_renditions`
    and exposes a read function for one order line.
  - C's issuance job (`reconcilePendingFiscalEvents(db, adapter)`) scans `AWAITING_SERVICE`
    settlements, reads the fact through D's function, applies `admitFinalSettlement` and submits.
  - D never touches fiscal tables, and C never writes D's table. There is no FK between 0040 and
    0039.
  - C exports `routeContour` for D.

### 7.1 Reconciliation with D's proposed `LabFinalSettlementPort` (20.11.2026)

D proposed a port with `submit(req)` and `readBack(idempotencyKey)`, and observations `ISSUED`,
`PENDING`, `UNKNOWN` and `REJECTED`. The proposed single form keeps D's request content inside C's
fiscal adapter port:

```ts
// C implements (fiscal-port.ts / fiscal-adapter*.ts); C's issuance job calls it, D never does.
type FrozenFiscalEvent = {
  eventRef: string;                 // = idempotency key: fiscal:FINAL_SETTLEMENT:{orderLineId}
  kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT" | "FINAL_SETTLEMENT";
  orderPublicId: string; orderLineId: string; snapshotHash: string;
  lines: FrozenFiscalLine[];        // from order_lines.fiscal_item_json
  totalKopecks: number;
  paymentMethod: "FULL_PAYMENT" | "FULL_PREPAYMENT";   // FINAL_SETTLEMENT: FULL_PAYMENT, advance offset
  prepayment?: { executor: "NATIVE"; paymentRef: string; receiptRef: string }; // FINAL_SETTLEMENT only
  serviceRenderedAt?: string;       // FINAL_SETTLEMENT only, from the ServiceRenderedFact
  receiptContact: { kind: "EMAIL"; value: string };   // sealed at rest, purged at terminal state
};
interface FiscalAdapter {
  readonly capabilities: FiscalAdapterCapabilities;  // finalSettlementWithoutPayment must be true
  submit(event: FrozenFiscalEvent): Promise<FiscalSubmitResult>;
  read(eventRef: string): Promise<FiscalReadBack>;
}
```

| D's form | Single form | Why |
|---|---|---|
| key `lab-final:{orderLineId}` | `fiscal:FINAL_SETTLEMENT:{orderLineId}` | one key scheme for all three receipt kinds |
| `ISSUED` | read-back `FOUND` + `REGISTERED` (provider ref, fiscal sign, issuedAt, evidence) | same |
| `PENDING` | `FOUND` + `PROCESSING` | same |
| `UNKNOWN` / transport exception | submit `LOST` or read-back `UNAVAILABLE` → `SUBMIT_UNKNOWN`, read-back first | same as D's rule |
| — | read-back **`NOT_FOUND`** | **added**: the only state that permits a replay under the same key. `UNKNOWN` alone never permits a replay |
| `REJECTED` | `REJECTED` + `ALERT`, no automatic retry | same |
| — | a binding check on read-back (eventRef, amount, payment method) | a mismatch goes to `REVIEW_REQUIRED` |
| `prepayment.executor: "REFREF" \| "NATIVE"` | only `NATIVE` is admitted | see below |

**Historical executor.** D proposed a `lab_order_settlement_executors` table. The single form keeps
one source of truth: the executor is `routeContour(order)` (§9), derived from what the order stored
(`native_payments` row vs `checkout_attempts.refref_attempt_id`) and exported for D.

- If D still needs a table, it must be written in the order-creation transaction and checked equal
  to `routeContour` on every read. A divergence is a hard error.
- A LAB line prepaid on the `REFREF_RC2` contour is not settled through the native adapter. Its
  closing receipt belongs to the original executor, and that path (Точка «Чеки») cannot issue it
  (FLEX-85). `admitFinalSettlement` therefore refuses it (`PAYMENT_NOT_PAID` / no native
  prepayment receipt), and such a line goes to a person.
- The 18.11.2026 aggregate check found 0 LAB orders on the connected canary DBs. The target DB is
  re-checked before switching.
- No new `Payment`, entitlement, ticket, refund or reward scope comes from the closing receipt
  (FLEX-85, ADR-140 P5).

## 8. States for checkout (FLEX-122), LAB and my

The UI shows only the projection, never raw provider states, and never infers payment from a
redirect:

| Payment state | Course | LAB |
|---|---|---|
| CREATING, CREATE_UNKNOWN | `CONFIRMING` | `CONFIRMING` |
| PENDING | `AWAITING_PAYMENT` (with the provider payment URL) | same |
| PAID | `ACCESS_GRANTED` | `TICKET_ISSUED` |
| DECLINED / EXPIRED | `DECLINED` / `EXPIRED`; trying again creates a new order and snapshot, never a second payment on this one | same; the hold is released |
| REVIEW_REQUIRED | `SUPPORT_REVIEW` (the order and support reference are shown) | same |

Refund: `REFUND_PROCESSING` (SUBMITTING, SUBMIT_UNKNOWN, PROCESSING), `REFUNDED`, and
`SUPPORT_REVIEW` (FAILED, REVIEW_REQUIRED). Request, approval and rejection states remain those of
`refund_requests`. Fixture: `buyer-states.json`.

DTO proposal for the order-status read used by checkout, LAB and my. This is a shared DTO, so it is
not changed in this PR. It will be requested through the coordinator:

```ts
{ orderPublicId, contour: "NATIVE" | "REFREF_RC2", payment: BuyerPaymentStatus,
  paymentUrl?: string, refund?: BuyerRefundStatus, supportReference?: string }
```

## 9. Historical routing and Refref unavailability

- `routeContour`: an order with a `native_payments` row is `NATIVE`. An order with
  `checkout_attempts.refref_attempt_id`, the historical RC.2 case, is `REFREF_RC2`. Both together is
  a hard error. Payment read-back, refund execution and fiscal handling follow the stored contour.
  Configuration can never move a historical order to the native provider, nor the reverse.
- `PAYMENT_MODE` gains `native`, proposed in `payment-mode.ts`. In `native` mode:
  - startup does not require any `REFREF_*` variable;
  - the native path imports no Refref rail;
  - Refref is not called on the payment, refund, fiscal or fulfilment paths;
  - the RC.2 rail is still built when its configuration is present, for historical recovery only,
    and it is never used to create new money.

  Phase 2 adds a test that runs the native contour end-to-end with the Refref endpoints answering
  503 or unreachable.
- `NATIVE_PROVIDER=fake` is allowed only for `DEPLOY_ENV` local or test; production refuses it at
  startup (same rule as `mock`). A real provider value is added only after the provider and an
  admitted environment are confirmed.

## 10. Ports

```ts
interface NativePaymentProvider {
  createPayment(req: FrozenNativePaymentRequest): Promise<CreateResult>;      // idempotent by req.idempotencyKey
  readPaymentByOrder(merchantOrderRef: string): Promise<PaymentReadBack>;     // authoritative; FOUND | NOT_FOUND | UNAVAILABLE
  submitRefund(envelope: RefundEnvelope): Promise<RefundSubmitResult>;        // idempotent by envelope.idempotencyKey
  readRefund(refundRef: string): Promise<RefundReadBack>;
  verifyCallback(headers: Headers, rawBody: Uint8Array): CallbackHint | null; // no state change
}
```

The fake provider (test only) is an in-memory bank with deterministic ids and scriptable faults: a
lost answer after commit, a lost answer before commit, a duplicate or reordered or forged callback,
read-back unavailable, a late success after expiry, an amount or id mismatch, and a state
regression. It counts provider-side debits and returns, so tests can assert "exactly one money
movement" and not just local state.

## 11. Persistence: proposed DDL 0039 (registered with the coordinator before integration)

Phase 2 adds only new tables. No `ALTER` touches existing ones, and 0001–0035 (and #279's 0036)
stay byte-identical.

| Table | Key columns | Personal data | Retention / erasure |
|---|---|---|---|
| `native_payments` | `order_id` UNIQUE FK, `payment_ref`, `idempotency_key` UNIQUE, `amount_kopecks`, `snapshot_hash`, `state`, `provider_payment_id` UNIQUE, `request_envelope` (sealed, contains the receipt e-mail), `envelope_key_id`, timestamps | sealed e-mail only, purged at terminal state | financial record retained (accounting); envelope purged as in 0019/0020 |
| `native_payment_observations` | append-only: `native_payment_id`, `source`, `observation_json` (redacted, no e-mail), `decided_state`, `reason`, `observed_at` | none | retained with the payment |
| `native_callback_inbox` | `provider`, `provider_event_id` UNIQUE, `body_sha256`, `signature_valid`, `received_at`, `processed_at` | none (raw body not stored; hash only) | short operational retention (proposal: 90 days) |
| `native_refunds` | `refund_request_id` UNIQUE FK, `native_payment_id` FK, `idempotency_key` UNIQUE, `amount_kopecks`, `state`, `provider_refund_id` UNIQUE, sealed envelope | sealed e-mail only, purged at terminal state | retained; envelope purged |
| `fiscal_events` | `event_ref` UNIQUE, `kind`, `order_line_id` FK, `refund_request_id` NULL FK, `payment_method`, `amount_kopecks`, `items_json` (frozen), `mode`, `state` (incl. `AWAITING_SERVICE`, `CANCELLED`), `provider_receipt_id`, sealed contact | sealed contact only; purged at terminal state or cancellation; for `AWAITING_SERVICE`, at most `ends_at` + 30 days, then review (§6.1) | retained (fiscal) |

The service-rendered fact is **not** in 0039: it is D's `lab_service_renditions` in 0040.

All finality is enforced in SQL as well as in code: CHECK on states, and triggers that refuse
leaving a terminal state and refuse a sealed envelope on a terminal row (pattern of 0020).

Erasure and restore impact: customer identity is reached only through `orders`, which is already
classified. New tables hold no plaintext identity. Erasure keeps financial and fiscal rows. A sealed
envelope or contact is the only way to replay an unfinished operation with the same body, so
erasure purges them **only when every payment, refund and fiscal event of the subject is terminal**
(`admitErasure`). A subject with any unfinished operation is refused with
`ERASURE_FINANCIAL_REVIEW_REQUIRED`, listing the open operations. Unfinished means `CREATE_UNKNOWN`,
`PENDING`, `REVIEW_REQUIRED`, `SUBMIT_UNKNOWN`, `PROCESSING` or `AWAITING_SERVICE`. The refusal is
a block, not a partial purge (fixtures E01–E09). Both schema fingerprints must be extended for the final schema:
`supportedSchemaSha256` in `pd-retention.ts` and `REVIEWED_SCHEMA_SHA256` in `erasure-restore.ts`.
Those are not my files, so their edits go through a coordinator request. The isolated
encrypted-restore scenario must be re-run on the final schema, and an unknown schema must still be
refused.

## 12. Relation to open PRs #279 and #280 (owner decides their fate)

- **Reused conceptually, not by code:** the discipline of #279/#280. Recover by order after an
  ambiguous create without a second POST, keep the original deadline, refuse on a binding mismatch,
  and treat a generic 400/409 as not proof of non-acceptance (here: `REFUSED` with
  `proven=false` → review).
- **Not reused:** the Refref vNext/v9 payable manifests and the `refref-v9-payment-rail.ts`
  transport. The native contour has no Refref dependency (decision 4A).
- **Textual conflicts expected when either side merges:**
  - `payment-mode.ts`: #279 adds `vnextCheckoutStorefronts` under `refref`; this work adds `native`
    to `PaymentMode` and a `native` config block. These are independent hunks.
  - `refunds.ts`: #279 adds a 4-line guard in `executeApprovedRefund`; this work adds a contour
    dispatcher before it. These are adjacent hunks.
  - `checkout.ts`: #279 rewrites resolution; this work touches only state and fixtures, and phase 2
    adds a native branch in the confirm path, which needs coordinator sequencing.
  - D's three point insertions in `checkout.ts` integrate after this work: the
    `assertLabPurchaseAuthority` guard in `prepareCheckout`/`confirmCheckout`, and
    `recordLabPurchaseAcceptance` after the `order_lines` INSERT. They do not change payment states.
    The phase-2 native branch in confirm sits after the order commit and does not overlap them.
  - Migrations: #279 holds 0036. This work holds 0039 (provisional); the final number is assigned by
    the coordinator in merge order.
- Nothing here is built on top of #279 or #280.

## 13. Failure scenarios → fixtures

| Scenario | Fixture |
|---|---|
| retry / duplicate read-back | P01, P07, R01, F01 |
| lost create answer (provider accepted / not) | P02, P03 |
| lost answer while sales stopped (FLEX-90) | P04 |
| lost callback | P05 |
| forged / premature / duplicate callback | P06, P07, R08 |
| UNKNOWN resolved by read-back | P02, R02, F02 |
| late result after terminal | P09, R06, F08 |
| amount / id / method mismatch | P08, P12, R07, F07 |
| provider regression | P10 |
| proven vs unproven refusal | P11, R04, R05 |
| PROVIDER-fiscalized rail | P13, R09 |
| final settlement admission, including "rail cannot settle" | S01–S09 |
| refund after rendered service / wrong contour / partial | A02–A07 |
| historical RC.2 routing | buyer-states `routing` |
| LAB paid: ticket, prepayment receipt, settlement reserved | P15 |
| settlement not awaiting / already started / cancelled | S10–S12, C01–C04 |
| refund before the service (settlement reserved or cancelled) | A08–A10 |
| erasure with an unfinished payment, refund or fiscal event | E01–E09 |

## 14. Phase 2 (same branch, after review)

1. `native-payment-provider.ts` (port), `test/fixtures/native-fake-provider.ts`.
2. `native-payment-ledger.ts`: begin, apply observation, sweep. `native-payment-refunds.ts`:
   dispatcher and execution. `fiscal-port.ts`, `fiscal-adapter-fake.ts` (test).
3. DDL 0039 after registration. Coordinator requests for `app.ts`/`server.ts` (callback route,
   sweeps), `migration.lock`, `docs/v2-merchant-schema.md`, and both fingerprints.
4. DB-level tests on the fake provider:
   - every fixture scenario, plus crash points between commit and send and between send and commit,
     with restart from the same SQLite file;
   - concurrent sweep and callback;
   - a debit counter at the provider (exactly one debit and at most one return per order);
   - Refref 503 or unreachable during the whole native flow;
   - an RC.2 historical order refund still routed to the Refref rail mock.

## 15. Open conditions and owner/provider questions

- **Q1 provider.** Which acquiring and fiscal profile (bank, KKT, OFD) is selected. Real
  integration starts only after confirmation and access to an admitted environment.
- **Q2 idempotency.** Does the provider guarantee idempotency of create and refund by our key, and
  an authoritative read-back by `merchantOrderRef`? If not, the fallback is manual refunds only.
- **Q3 expiry.** Can the provider payment link expiry be set to no later than the LAB hold or quote
  deadline?
- **Q4 metadata.** Does the provider echo merchant metadata (`snapshotHash`) in its read-back? If
  not, binding uses `merchantOrderRef` + amount + currency, and the snapshot binding is local only.
  This is weaker, so it needs review.
- **Q5 fiscalization.** Which of `PROVIDER` or `MERCHANT` applies to the selected profile, and does
  its adapter support a settlement without a new payment (FLEX-85)? Until then, LAB stays CLOSED.
- **Q6 late success.** Should a `LATE_PAYMENT_AFTER_TERMINAL` for an `ONLINE_COURSE` stay a manual
  review (current contract), or auto-grant, since a course has no seat? The conservative default is
  manual.
- Retention period for `native_callback_inbox` (proposal: 90 days): with E and the owner.
- Retention ceiling of the sealed contact for an `AWAITING_SERVICE` settlement (proposal: `ends_at` + 30 days, §6.1).
- I7 / FLEX-90: does the emergency stop also stop refund execution? Default: no (with the owner).

## 16. Verification

| | Local (this PR) | Requires an admitted environment |
|---|---|---|
| Decision tables vs fixtures (87 cases), mutation spot-check | ✔ | — |
| Root typecheck, targeted lint | ✔ | — |
| Durable ledger, crash/restart, concurrency, Refref down | phase 2, local SQLite + fake provider | — |
| Real provider idempotency, read-back, callback signature, expiry | — | provider qualification (FLEX-82/84) |
| Real receipts: course FULL_PAYMENT, refund receipt, LAB prepayment + closing | — | FLEX-76, FLEX-85 (D assembles) |
| Backup / isolated restore with DDL 0039, both fingerprints | phase 2, local | exact environment identity |
